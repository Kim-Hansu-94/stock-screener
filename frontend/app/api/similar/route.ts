import type { NextRequest } from 'next/server'
import YahooFinance from 'yahoo-finance2'
const yahooFinance = new YahooFinance()
import { createServerSupabaseClient } from '@/lib/supabase'
import type { PriceHistoryRow, SimilarStockResult, SimilarSearchResponse } from '@/lib/types'

const TOP_N = 20
const MIN_OVERLAP_DAYS = 20
const RETURN_WEIGHT = 0.8
const VOLUME_WEIGHT = 0.2
const VOL_MA_WINDOW = 20

// ── 공통 유틸 ──────────────────────────────────────────────

function zScore(arr: number[]): number[] {
  if (arr.length === 0) return []
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length
  const std = Math.sqrt(variance)
  return std < 0.001 ? arr.map(() => 0) : arr.map((v) => (v - mean) / std)
}

function stdDev(arr: number[]): number {
  if (arr.length === 0) return 0
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length
  return Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length)
}

function dailyReturns(prices: number[]): number[] {
  const r: number[] = []
  for (let i = 1; i < prices.length; i++) r.push((prices[i] - prices[i - 1]) / prices[i - 1])
  return r
}

function normalizeToReturns(prices: number[]): number[] {
  return zScore(dailyReturns(prices))
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

// ── 필터 함수 ─────────────────────────────────────────────

// SMA50이 SMA200보다 10% 이상 낮으면 심한 역배열로 판단
function isDeepBearish(closes: number[]): boolean {
  if (closes.length < 200) return false
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / 50
  const sma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / 200
  return sma50 < sma200 * 0.9
}

// 최근 20일 수익률 표준편차 < 직전 60일 표준편차 × 0.5 → 변동성 수축 (바닥 다지기 신호)
function hasVolatilityContraction(closes: number[]): boolean {
  if (closes.length < 82) return false // 20 + 60 + 2 버퍼
  const ret = dailyReturns(closes)
  const std20 = stdDev(ret.slice(-20))
  const std60 = stdDev(ret.slice(-80, -20))
  return std60 > 0 && std20 < std60 * 0.5
}

// 최근 60일 내 직전 90일 평균 거래량 대비 5배 이상인 날이 2회 이상 → 매집봉 신호
function hasVolumeSpikes(volumes: number[]): boolean {
  const LOOKBACK = 60
  const BASELINE = 90
  const THRESHOLD = 5
  const MIN_SPIKES = 2
  if (volumes.length < LOOKBACK + BASELINE) return false
  const baseline = volumes.slice(-(LOOKBACK + BASELINE), -LOOKBACK)
  const baselineAvg = baseline.reduce((a, b) => a + b, 0) / baseline.length
  if (baselineAvg <= 0) return false
  const spikes = volumes.slice(-LOOKBACK).filter((v) => v >= baselineAvg * THRESHOLD).length
  return spikes >= MIN_SPIKES
}

// ── API 핸들러 ────────────────────────────────────────────

// 최근 200 거래일 내 최저가 날짜 인덱스 반환
function findRecentBottomIdx(prices: number[]): number {
  const lookback = Math.min(200, prices.length)
  const slice = prices.slice(-lookback)
  const minIdx = slice.indexOf(Math.min(...slice))
  return prices.length - lookback + minIdx
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const ticker = searchParams.get('ticker')
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')

  if (!ticker) {
    return Response.json({ error: 'ticker 파라미터가 필요합니다.' }, { status: 400 })
  }

  // 1. 기준 종목 데이터 (Yahoo Finance)
  let refPrices: number[]
  let refVolumes: number[]
  let detectedFrom: string
  let detectedTo: string

  if (fromParam && toParam) {
    // 수동 모드: 사용자가 지정한 기간
    try {
      const hist = (await yahooFinance.historical(
        ticker,
        { period1: fromParam, period2: toParam },
        { validateResult: false },
      )) as unknown as Array<{ date: Date; close: number; volume: number }>
      refPrices = hist.map((d) => d.close).filter((v) => v != null && isFinite(v))
      refVolumes = hist.map((d) => d.volume ?? 0)
      detectedFrom = fromParam
      detectedTo = toParam
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: `${ticker} 데이터 오류: ${msg}` }, { status: 502 })
    }
  } else {
    // 자동 감지 모드: 최근 500일 다운로드 → 최저가 바닥 탐지 → 직전 90 거래일을 패턴으로 사용
    const autoStart = new Date()
    autoStart.setDate(autoStart.getDate() - 500)
    let fullHist: Array<{ date: Date; close: number; volume: number }>
    try {
      fullHist = (await yahooFinance.historical(
        ticker,
        { period1: autoStart.toISOString().slice(0, 10) },
        { validateResult: false },
      )) as unknown as Array<{ date: Date; close: number; volume: number }>
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: `${ticker} 데이터 오류: ${msg}` }, { status: 502 })
    }

    if (fullHist.length < 30) {
      return Response.json({ error: `${ticker} 데이터가 부족합니다.` }, { status: 400 })
    }

    const allPrices = fullHist.map((d) => d.close)
    const bottomIdx = findRecentBottomIdx(allPrices)
    const patternStart = Math.max(0, bottomIdx - 90)
    const patternSlice = fullHist.slice(patternStart, bottomIdx + 1)

    refPrices = patternSlice.map((d) => d.close)
    refVolumes = patternSlice.map((d) => d.volume ?? 0)
    detectedFrom = patternSlice[0].date.toISOString().slice(0, 10)
    detectedTo = patternSlice[patternSlice.length - 1].date.toISOString().slice(0, 10)
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

  // 2. 후보 종목 가격 이력 조회
  // 동적 cutoff: 기준 기간 × 1.5 (거래일 < 달력일 보정), 최소 400일 (필터용 200거래일 확보)
  const fromDate = new Date(detectedFrom)
  const today = new Date()
  const calendarDays = Math.ceil((today.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24))
  const lookbackDays = Math.max(Math.ceil(calendarDays * 1.5), 400)
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

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (histData ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }

  // 사전 필터 1: 거래대금 하위 20% 제외
  const avgTurnover: Record<string, number> = {}
  for (const [t, rows] of Object.entries(grouped)) {
    avgTurnover[t] = rows.reduce((sum, r) => sum + r.close * r.volume, 0) / rows.length
  }
  const sorted = Object.values(avgTurnover).sort((a, b) => a - b)
  const bottom20Threshold = sorted[Math.floor(sorted.length * 0.2)] ?? 0

  // 3. 유사도 계산
  const results: SimilarStockResult[] = []
  for (const [t, rows] of Object.entries(grouped)) {
    if (t === ticker.toUpperCase()) continue

    // 거래대금 하위 20% 제외
    if ((avgTurnover[t] ?? 0) <= bottom20Threshold) continue

    const closes = rows.map((r) => r.close)
    const volumes = rows.map((r) => r.volume)

    // 심한 역배열 제외
    if (isDeepBearish(closes)) continue

    // 변동성 수축 조건 (최근 20일 std < 직전 60일 std × 0.5)
    if (!hasVolatilityContraction(closes)) continue

    // 최근 60일 내 매집봉 2회 이상
    if (!hasVolumeSpikes(volumes)) continue

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
  const response: SimilarSearchResponse = {
    detectedFrom,
    detectedTo,
    results: results.slice(0, TOP_N),
  }
  return Response.json(response)
}
