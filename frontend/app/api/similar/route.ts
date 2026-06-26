import type { NextRequest } from 'next/server'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()
import { createServerSupabaseClient } from '@/lib/supabase'
import type { PriceHistoryRow, SimilarStockResult } from '@/lib/types'

const TOP_N = 20
const MIN_OVERLAP_DAYS = 20
const RETURN_WEIGHT = 0.7
const VOLUME_WEIGHT = 0.3
const VOL_MA_WINDOW = 20

function zScore(arr: number[]): number[] {
  if (arr.length === 0) return []
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length
  const std = Math.sqrt(variance)
  return std < 0.001 ? arr.map(() => 0) : arr.map((v) => (v - mean) / std)
}

function normalizeToReturns(prices: number[]): number[] {
  const returns: number[] = []
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i - 1]) / prices[i - 1])
  }
  return zScore(returns)
}

// 20일 이동평균 대비 당일 거래량 비율 → Z-score
function normalizeVolume(volumes: number[]): number[] {
  const ratios: number[] = []
  for (let i = VOL_MA_WINDOW; i < volumes.length; i++) {
    const ma = volumes.slice(i - VOL_MA_WINDOW, i).reduce((a, b) => a + b, 0) / VOL_MA_WINDOW
    ratios.push(ma > 0 ? volumes[i] / ma : 1)
  }
  return zScore(ratios)
}

function cosineSim(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  if (len < MIN_OVERLAP_DAYS) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    magA += a[i] ** 2
    magB += b[i] ** 2
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

// SMA50이 SMA200보다 10% 이상 낮으면 심한 역배열로 판단
function isDeepBearish(closes: number[]): boolean {
  if (closes.length < 200) return false
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50
  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200
  return sma50 < sma200 * 0.9
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const ticker = searchParams.get('ticker')
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  if (!ticker || !from || !to) {
    return Response.json({ error: 'ticker, from, to 파라미터가 필요합니다.' }, { status: 400 })
  }

  // 1. Fetch reference ticker data from Yahoo Finance
  let refPrices: number[]
  let refVolumes: number[]
  try {
    const hist = (await yahooFinance.historical(
      ticker,
      { period1: from, period2: to },
      { validateResult: false },
    )) as unknown as Array<{ close: number; volume: number }>
    refPrices = hist.map((d) => d.close).filter((v) => v != null && isFinite(v))
    refVolumes = hist.map((d) => d.volume ?? 0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: `${ticker} 데이터 오류: ${msg}` }, { status: 502 })
  }

  if (refPrices.length < MIN_OVERLAP_DAYS) {
    return Response.json(
      { error: `기간이 너무 짧습니다. 최소 ${MIN_OVERLAP_DAYS}거래일 이상 선택하세요.` },
      { status: 400 },
    )
  }

  const refReturnNorm = normalizeToReturns(refPrices)
  const refVolumeNorm = normalizeVolume(refVolumes)
  const windowLen = refReturnNorm.length
  const useVolume = refVolumeNorm.length >= MIN_OVERLAP_DAYS

  // 2. Fetch candidate price history
  // Dynamic cutoff: 1.5× the reference calendar-day span (calendar days > trading days), min 250
  const fromDate = new Date(from)
  const today = new Date()
  const calendarDays = Math.ceil((today.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))
  const lookbackDays = Math.max(Math.ceil(calendarDays * 1.5), 250)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - lookbackDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()
  const { data: universeData, error: universeErr } = await supabase
    .from('stock_universe')
    .select('ticker, name, sector')
    .eq('market', 'US')
  if (universeErr) return Response.json({ error: universeErr.message }, { status: 500 })

  const universeMap = new Map<string, { name: string; sector: string | null }>(
    (universeData ?? []).map((r) => [r.ticker, { name: r.name, sector: r.sector }]),
  )

  const { data: histData, error: histErr } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close, open, high, low, volume, market')
    .eq('market', 'US')
    .gte('date', cutoffStr)
    .order('date', { ascending: true })
  if (histErr) return Response.json({ error: histErr.message }, { status: 500 })

  // Group by ticker
  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  // Pre-filter 1: compute average daily turnover (close × volume) per ticker
  const avgTurnover: Record<string, number> = {}
  for (const [t, rows] of Object.entries(grouped)) {
    const total = rows.reduce((sum, r) => sum + r.close * r.volume, 0)
    avgTurnover[t] = total / rows.length
  }
  const sorted = Object.values(avgTurnover).sort((a, b) => a - b)
  const bottom20Threshold = sorted[Math.floor(sorted.length * 0.2)] ?? 0

  // 3. Compute similarity
  const results: SimilarStockResult[] = []
  for (const [t, rows] of Object.entries(grouped)) {
    if (t === ticker.toUpperCase()) continue

    // Pre-filter 1: 거래대금 하위 20% 제외
    if ((avgTurnover[t] ?? 0) <= bottom20Threshold) continue

    const closes = rows.map((r) => r.close)
    const volumes = rows.map((r) => r.volume)

    // Pre-filter 2: 심한 역배열 종목 제외
    if (isDeepBearish(closes)) continue

    const returnNorm = normalizeToReturns(closes.slice(-windowLen))
    const volNorm = normalizeVolume(volumes.slice(-(windowLen + VOL_MA_WINDOW)))

    const returnSim = cosineSim(refReturnNorm, returnNorm)
    const volSim = useVolume ? cosineSim(refVolumeNorm, volNorm) : returnSim

    const sim = RETURN_WEIGHT * returnSim + VOLUME_WEIGHT * volSim
    if (sim <= 0) continue

    const meta = universeMap.get(t)
    results.push({
      ticker: t,
      name: meta?.name ?? t,
      sector: meta?.sector ?? null,
      similarity: sim,
      history: rows,
    })
  }

  results.sort((a, b) => b.similarity - a.similarity)
  return Response.json(results.slice(0, TOP_N))
}
