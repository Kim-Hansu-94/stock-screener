// 성적표(app/history)·포지션(app/positions) 페이지 — 과거 추천의 결과 추적용 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { computeStopTarget, filterBarsAsOf, type PriceBar } from '../risk'
import { fetchPriceRowsPaged, SCREENER_CACHE_TAG } from './shared'
import { resolveTrade, type ResolvedTrade } from '../scorecard'
import { getUniverseNameMap } from './universe'
import type { DayReturn, Market, PriceHistoryRow, ScreenedStockPerf, ScreenedStockWithRisk } from '../types'

export async function getRegimesInRange(
  market: Market,
  cutoffStr: string,
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('market_regime')
    .select('date, regime')
    .eq('market', market)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  const map: Record<string, string> = {}
  for (const row of (data ?? []) as { date: string; regime: string }[]) {
    map[row.date] = row.regime
  }
  return map
}

export async function getScreenedStockPerformance(
  market: Market,
  days = 30,
): Promise<ScreenedStockPerf[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // Past recommendations only (exclude today since day1 would be today's close, not yet settled)
  // passed=true만: 근접 후보(참고용)는 추천이 아니므로 수익률 집계에서 제외
  const { data: recs, error: recsError } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close')
    .eq('market', market)
    .eq('passed', true)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (recsError) throw new Error(recsError.message)
  if (!recs?.length) return []

  const tickers = [...new Set(recs.map((r: { ticker: string }) => r.ticker))]
  const oldestDate = (recs as { date: string }[]).at(-1)!.date
  const nameKrMap = await getUniverseNameMap(market, tickers)

  // Extend 150 calendar days before oldest rec date for ATR + resistance-level calculation
  // (covers the ~90-trading-day pivot-high lookback plus holiday/weekend buffer)
  const prePeriodDate = new Date(oldestDate)
  prePeriodDate.setDate(prePeriodDate.getDate() - 150)
  const prePeriodStr = prePeriodDate.toISOString().slice(0, 10)

  const priceData = await fetchPriceRowsPaged<PriceBar & { ticker: string }>(
    market,
    tickers,
    'ticker, date, high, low, close',
    prePeriodStr,
  )

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, high: row.high, low: row.low, close: row.close })
  }

  return (recs as { date: string; market: string; ticker: string; name: string; sector: string; close: number }[]).map(
    (rec) => {
      const allBars = priceMap[rec.ticker] ?? []
      const future = allBars.filter((p) => p.date > rec.date)
      const preBars = allBars.filter((p) => p.date <= rec.date)

      const makeReturn = (i: number): DayReturn | null => {
        const row = future[i]
        if (!row) return null
        return { date: row.date, close: row.close, returnPct: ((row.close - rec.close) / rec.close) * 100 }
      }

      const { stop, target, riskReward } = computeStopTarget(preBars, rec.close)

      return {
        date: rec.date,
        market: rec.market as Market,
        ticker: rec.ticker,
        name: rec.name,
        name_kr: nameKrMap[rec.ticker],
        sector: rec.sector,
        entryPrice: rec.close,
        day1: makeReturn(0),
        day2: makeReturn(1),
        day3: makeReturn(2),
        stop,
        target,
        riskReward,
      }
    },
  )
}

export async function getPullbackScreenerWithRisk(
  market: Market,
): Promise<ScreenedStockWithRisk[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()

  // Get the latest screened date for this market
  const { data: latestRow } = await supabase
    .from('screened_stocks')
    .select('date')
    .eq('market', market)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestRow) return []
  const latestDate = (latestRow as { date: string }).date

  const { data: stocks, error } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close, rsi')
    .eq('market', market)
    .eq('date', latestDate)

  if (error) throw new Error(error.message)
  if (!stocks?.length) return []

  const tickers = (stocks as { ticker: string }[]).map((s) => s.ticker)
  const nameKrMap = await getUniverseNameMap(market, tickers)

  // 150 days of daily OHLCV — used for both ATR/resistance calculation and chart display
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 150)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const priceData = await fetchPriceRowsPaged<PriceHistoryRow>(
    market,
    tickers,
    'ticker, market, date, open, high, low, close, volume',
    cutoffStr,
  )

  const priceMap: Record<string, PriceHistoryRow[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push(row)
  }

  return (stocks as { date: string; market: string; ticker: string; name: string; sector: string; close: number; rsi: number }[]).map(
    (stock) => {
      const history = priceMap[stock.ticker] ?? []
      const bars: PriceBar[] = history.map((r) => ({
        date: r.date,
        high: r.high,
        low: r.low,
        close: r.close,
      }))

      const entry = stock.close
      const barsAsOfEntry = filterBarsAsOf(bars, stock.date)
      const { stop, target, riskReward } = computeStopTarget(barsAsOfEntry, entry)

      return {
        date: stock.date,
        market: stock.market as Market,
        ticker: stock.ticker,
        name: stock.name,
        name_kr: nameKrMap[stock.ticker],
        sector: stock.sector,
        entryPrice: entry,
        rsi: stock.rsi,
        stop,
        target,
        riskReward,
        history,
      }
    },
  )
}


/**
 * 스크리너 성적 집계용 트레이드 목록.
 *
 * 조회 창이 긴 이유: 판정에 최대 MAX_HOLD_BARS(60거래일 ≈ 3개월)가 걸리므로,
 * 90일 창으로는 판정이 끝난 표본이 거의 안 남는다. 기본 180일이면 앞쪽 90일치가
 * 판정 완료로 쌓이고 뒤쪽은 pending으로 분리된다.
 */
export async function getScorecardTrades(market: Market, days = 180): Promise<ResolvedTrade[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true로 거르지 않는다. 전 조건 통과는 드물고(하락장인 날은 '시장 하락장'이
  // 모든 종목에 붙어 그날 전체가 passed=false다) 화면에 실제로 뜨는 건 미달이 가장 적은
  // 상위 후보들이다. 통과분만 집계하면 표본이 거의 없을뿐더러, 정작 매일 보고 있는
  // 종목들의 성적은 알 수 없다. 대신 failed_criteria를 같이 받아 미달 개수별로 나눈다.
  const { data: recs, error } = await supabase
    .from('screened_stocks')
    .select('date, ticker, name, sector, close, failed_criteria')
    .eq('market', market)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (error) throw new Error(error.message)
  if (!recs?.length) return []

  // 같은 종목이 눌림목 구간 내내 반복 추천되므로, 창 안의 첫 추천 하나만 트레이드로 센다.
  // (date 내림차순이라 마지막으로 덮이는 값이 가장 이른 날짜다.)
  type Rec = { date: string; ticker: string; name: string; sector: string; close: number; failed_criteria: string[] }
  const firstByTicker = new Map<string, Rec>()
  for (const rec of recs as Rec[]) {
    firstByTicker.set(rec.ticker, rec)
  }
  const picks = [...firstByTicker.values()]
  const tickers = [...firstByTicker.keys()]

  const oldestDate = picks.reduce((min, t) => (t.date < min ? t.date : min), picks[0].date)
  // 손절/목표 계산에 쓰는 피벗 탐색(약 90거래일)을 덮도록 앞쪽으로 150일 더 확보한다.
  const prePeriod = new Date(oldestDate)
  prePeriod.setDate(prePeriod.getDate() - 150)

  const [priceData, regimes, nameKrMap] = await Promise.all([
    fetchPriceRowsPaged<PriceBar & { ticker: string }>(
      market, tickers, 'ticker, date, high, low, close', prePeriod.toISOString().slice(0, 10),
    ),
    getRegimesInRange(market, cutoffStr),
    getUniverseNameMap(market, tickers),
  ])

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of priceData) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, high: row.high, low: row.low, close: row.close })
  }

  const trades: ResolvedTrade[] = []
  for (const pick of picks) {
    const allBars = priceMap[pick.ticker] ?? []
    const preBars = allBars.filter((b) => b.date <= pick.date)
    const { stop, target } = computeStopTarget(preBars, pick.close)
    // 손절/목표를 못 잡는 추천은 애초에 트레이드가 성립하지 않으므로 표본에서 뺀다.
    // 0으로 세면 기댓값이 실제보다 좋아 보인다.
    if (stop === null || target === null) continue

    trades.push(resolveTrade({
      date: pick.date,
      market,
      ticker: pick.ticker,
      name: pick.name,
      nameKr: nameKrMap[pick.ticker],
      sector: pick.sector,
      entry: pick.close,
      stop,
      target,
      futureBars: allBars.filter((b) => b.date > pick.date),
      regime: regimes[pick.date] === 'bull' ? 'bull' : regimes[pick.date] === 'bear' ? 'bear' : null,
      failedCriteria: pick.failed_criteria ?? [],
    }))
  }

  return trades
}
