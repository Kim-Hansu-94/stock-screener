import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()
import { createServerSupabaseClient } from '@/lib/supabase'
import type { PriceHistoryRow, DailyReportResult, DailyReportResponse } from '@/lib/types'
import {
  normalizeToReturns,
  normalizeVolume,
  weightedSim,
  isDeepBearish,
  hasVolatilityContraction,
  hasVolumeSpikes,
  isVolumeTriggerToday,
  VOL_MA_WINDOW,
  MIN_OVERLAP_DAYS,
} from '@/lib/similarity'

const TOP_N = 20
const PATTERN_DAYS = 90

const GOLD_STANDARDS = [
  {
    ticker: 'QBTS',
    name: 'D-Wave Quantum',
    windows: [
      ['2023-01-01', '2023-07-01'],
      ['2023-09-01', '2024-04-01'],
    ],
  },
  {
    ticker: 'RGTI',
    name: 'Rigetti Computing',
    windows: [
      ['2023-01-01', '2023-07-01'],
      ['2023-09-01', '2024-04-01'],
    ],
  },
  {
    ticker: 'AEVA',
    name: 'Aeva Technologies',
    windows: [
      ['2022-09-01', '2023-07-01'],
      ['2023-07-01', '2024-06-01'],
    ],
  },
  {
    ticker: 'JOBY',
    name: 'Joby Aviation',
    windows: [
      ['2022-09-01', '2023-07-01'],
      ['2023-07-01', '2024-06-01'],
    ],
  },
  {
    ticker: 'FCEL',
    name: 'FuelCell Energy',
    windows: [['2024-01-01', '2024-12-31']],
  },
]

interface GoldPattern {
  ticker: string
  name: string
  bottom: string
  returnNorm: number[]
  volumeNorm: number[]
}

type YahooHistRow = { date: Date; close: number; volume: number }

let goldCache: GoldPattern[] | null = null

async function loadGoldPatterns(): Promise<GoldPattern[]> {
  if (goldCache) return goldCache

  const patterns: GoldPattern[] = []

  for (const gs of GOLD_STANDARDS) {
    const earliest = gs.windows.reduce(
      (min, [s]) => (s < min ? s : min),
      '9999-99-99',
    )
    const startDate = new Date(earliest)
    startDate.setDate(startDate.getDate() - 300)

    let hist: YahooHistRow[]
    try {
      hist = (await yahooFinance.historical(
        gs.ticker,
        { period1: startDate.toISOString().slice(0, 10) },
        { validateResult: false },
      )) as unknown as YahooHistRow[]
    } catch {
      continue
    }
    if (!hist || hist.length < 50) continue

    for (const [winStart, winEnd] of gs.windows) {
      const winData = hist.filter((d) => {
        const ds = d.date.toISOString().slice(0, 10)
        return ds >= winStart && ds <= winEnd
      })
      if (winData.length < Math.floor(PATTERN_DAYS / 2)) continue

      const winPrices = winData.map((d) => d.close)
      const minIdx = winPrices.indexOf(Math.min(...winPrices))
      const bottomDate = winData[minIdx].date.toISOString().slice(0, 10)

      const absBottomIdx = hist.findIndex(
        (d) => d.date.toISOString().slice(0, 10) === bottomDate,
      )
      if (absBottomIdx < 0) continue

      const patStart = Math.max(0, absBottomIdx - PATTERN_DAYS)
      const slice = hist.slice(patStart, absBottomIdx + 1)
      if (slice.length < MIN_OVERLAP_DAYS) continue

      const prices = slice.map((d) => d.close)
      const volumes = slice.map((d) => d.volume ?? 0)
      const returnNorm = normalizeToReturns(prices)
      const volumeNorm = normalizeVolume(volumes)
      if (returnNorm.length < MIN_OVERLAP_DAYS) continue

      patterns.push({
        ticker: gs.ticker,
        name: gs.name,
        bottom: bottomDate,
        returnNorm,
        volumeNorm,
      })
    }
  }

  goldCache = patterns
  return patterns
}

let scanCache: { data: DailyReportResponse; expiry: number } | null = null
const SCAN_CACHE_TTL_MS = 60 * 60 * 1000

export async function GET() {
  if (scanCache && Date.now() < scanCache.expiry) {
    return Response.json(scanCache.data)
  }

  const goldPatterns = await loadGoldPatterns()
  if (goldPatterns.length === 0) {
    return Response.json(
      { error: 'Gold Standard 패턴 로드에 실패했습니다.' },
      { status: 500 },
    )
  }

  const maxPatLen = Math.max(...goldPatterns.map((gp) => gp.returnNorm.length))

  const supabase = createServerSupabaseClient()

  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector')
    .eq('market', 'US')
  if (universeErr) return Response.json({ error: universeErr.message }, { status: 500 })

  const universeMap = new Map<string, { name: string; sector: string | null }>(
    (universeData ?? []).map((r) => [r.ticker, { name: r.name, sector: r.sector }]),
  )

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 400)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const { data: histData, error: histErr } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close, open, high, low, volume, market')
    .eq('market', 'US')
    .gte('date', cutoffStr)
    .order('date', { ascending: true })
  if (histErr) return Response.json({ error: histErr.message }, { status: 500 })

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  // 거래대금 하위 20% 제외
  const avgTurnover: Record<string, number> = {}
  for (const [t, rows] of Object.entries(grouped)) {
    avgTurnover[t] = rows.reduce((sum, r) => sum + r.close * r.volume, 0) / rows.length
  }
  const sortedTurnover = Object.values(avgTurnover).sort((a, b) => a - b)
  const bottom20Threshold = sortedTurnover[Math.floor(sortedTurnover.length * 0.2)] ?? 0

  const gsTickerSet = new Set(GOLD_STANDARDS.map((g) => g.ticker))
  const results: DailyReportResult[] = []

  for (const [t, rows] of Object.entries(grouped)) {
    if (gsTickerSet.has(t)) continue
    if ((avgTurnover[t] ?? 0) <= bottom20Threshold) continue

    const closes = rows.map((r) => r.close)
    const volumes = rows.map((r) => r.volume)

    if (isDeepBearish(closes)) continue
    if (!hasVolatilityContraction(closes)) continue
    if (!hasVolumeSpikes(volumes)) continue

    // 최대 패턴 길이 기준으로 후보 벡터 한 번만 계산
    const candRFull = normalizeToReturns(closes.slice(-(maxPatLen + 1)))
    const candVFull = normalizeVolume(volumes.slice(-(maxPatLen + VOL_MA_WINDOW + 1)))

    let bestSim = 0
    let bestPattern: GoldPattern | null = null

    for (const gp of goldPatterns) {
      const candR = candRFull.slice(-gp.returnNorm.length)
      const candV = candVFull.slice(-gp.volumeNorm.length)
      const sim = weightedSim(gp.returnNorm, gp.volumeNorm, candR, candV)
      if (sim > bestSim) {
        bestSim = sim
        bestPattern = gp
      }
    }

    if (bestSim <= 0 || !bestPattern) continue

    const meta = universeMap.get(t)
    results.push({
      ticker: t,
      name: meta?.name ?? t,
      sector: meta?.sector ?? null,
      similarity: bestSim,
      matchedStandard: bestPattern.name,
      matchedStandardTicker: bestPattern.ticker,
      matchedBottom: bestPattern.bottom,
      volumeTriggered: isVolumeTriggerToday(volumes),
      history: rows,
    })
  }

  results.sort((a, b) => b.similarity - a.similarity)

  const response: DailyReportResponse = {
    generatedAt: new Date().toISOString(),
    results: results.slice(0, TOP_N),
  }

  scanCache = { data: response, expiry: Date.now() + SCAN_CACHE_TTL_MS }
  return Response.json(response)
}
