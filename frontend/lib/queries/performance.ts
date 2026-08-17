// 성적표(app/history)·포지션(app/positions) 페이지 — 과거 추천의 결과 추적용 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { computeStopTarget, filterBarsAsOf, isBelowTrend, type PriceBar } from '../risk'
import { fetchPriceRowsPaged, SCREENER_CACHE_TAG } from './shared'
import { getLatestRegime, getLeadingSectors } from './screener'
import { getUniverseNameMap } from './universe'
import type { DayReturn, ExitCheckResult, ExitStatus, Market, PriceHistoryRow, ScreenedStockPerf, ScreenedStockWithRisk, TrackRecord } from '../types'

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

// Re-evaluates past recommendations that may still be held: walks forward through ALL
// bars since entry (not a fixed day1-3 window) to find the first stop/target breach, then
// checks CURRENT regime/leading-sector/trend state (not the state at entry time) so a
// still-open position gets flagged the moment the setup it was bought on breaks down.
export async function getExitSignals(market: Market, days = 30): Promise<ExitCheckResult[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true만: 근접 후보(참고용)는 보유 종목 점검 대상이 아니다
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

  const latestRegime = await getLatestRegime(market)
  const leadingSectors = latestRegime ? await getLeadingSectors(market, latestRegime.date) : []
  const leadingSectorSet = new Set(leadingSectors.map((s) => s.sector))

  return (recs as { date: string; market: string; ticker: string; name: string; sector: string; close: number }[]).map(
    (rec) => {
      const allBars = priceMap[rec.ticker] ?? []
      const preBars = allBars.filter((p) => p.date <= rec.date)
      const future = allBars.filter((p) => p.date > rec.date)

      const { stop, target, riskReward } = computeStopTarget(preBars, rec.close)

      let status: ExitStatus = 'open'
      let exitDate: string | null = null
      for (const bar of future) {
        if (stop !== null && bar.low <= stop) {
          status = 'stopped_out'
          exitDate = bar.date
          break
        }
        if (target !== null && bar.high >= target) {
          status = 'target_hit'
          exitDate = bar.date
          break
        }
      }

      const latestBar = allBars.at(-1) ?? null
      const currentPrice = latestBar?.close ?? rec.close
      const currentReturnPct = ((currentPrice - rec.close) / rec.close) * 100

      const exitReasons: string[] = []
      if (status === 'open') {
        if (latestRegime?.regime === 'bear') exitReasons.push('시장이 하락장으로 전환되었습니다')
        if (leadingSectorSet.size > 0 && !leadingSectorSet.has(rec.sector)) {
          exitReasons.push('주도 섹터에서 이탈했습니다')
        }
        if (isBelowTrend(allBars)) exitReasons.push('60일 이동평균선을 하회합니다')
      }

      const recommendation: 'sell' | 'hold' = status !== 'open' || exitReasons.length > 0 ? 'sell' : 'hold'

      return {
        date: rec.date,
        market: rec.market as Market,
        ticker: rec.ticker,
        name: rec.name,
        name_kr: nameKrMap[rec.ticker],
        sector: rec.sector,
        entryPrice: rec.close,
        currentPrice,
        currentReturnPct,
        stop,
        target,
        riskReward,
        status,
        exitDate,
        exitReasons,
        recommendation,
      }
    },
  )
}

// Aggregate 90-day track record: walk each past pullback recommendation forward to its
// stop/target resolution (same logic as getExitSignals), dedupe to the first day each ticker
// was recommended within the window, then summarize hit/stop/open rates and P&L stats.
export async function getScreenerTrackRecord(market: Market, days = 90): Promise<TrackRecord> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // passed=true만: 성적표는 실제 추천(전 조건 통과)의 기록이어야 한다
  const { data: recs, error: recsError } = await supabase
    .from('screened_stocks')
    .select('date, ticker, close')
    .eq('market', market)
    .eq('passed', true)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (recsError) throw new Error(recsError.message)

  const empty: TrackRecord = {
    market,
    totalTrades: 0,
    targetHitRate: 0,
    stoppedOutRate: 0,
    openRate: 0,
    avgReturnPct: 0,
    avgHoldingDays: 0,
    avgR: 0,
  }
  if (!recs?.length) return empty

  // Dedupe to the first (earliest) recommendation per ticker within the window. recs come
  // in date-descending order, so the last match for each ticker is its earliest date.
  const firstByTicker = new Map<string, { date: string; ticker: string; close: number }>()
  for (const rec of recs as { date: string; ticker: string; close: number }[]) {
    firstByTicker.set(rec.ticker, rec)
  }
  const trades = [...firstByTicker.values()]

  const tickers = [...firstByTicker.keys()]
  const oldestDate = trades.reduce((min, t) => (t.date < min ? t.date : min), trades[0].date)

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

  let targetHits = 0
  let stoppedOut = 0
  let open = 0
  const closedReturns: number[] = []
  const closedHoldingDays: number[] = []
  const closedR: number[] = []

  for (const trade of trades) {
    const allBars = priceMap[trade.ticker] ?? []
    const preBars = allBars.filter((p) => p.date <= trade.date)
    const future = allBars.filter((p) => p.date > trade.date)

    const { stop, target } = computeStopTarget(preBars, trade.close)
    // Skip recommendations whose stop/target can't be computed: an unresolvable trade
    // would distort the rates and R stats.
    if (stop === null || target === null) continue

    let status: ExitStatus = 'open'
    let holdingDays = 0
    for (let i = 0; i < future.length; i++) {
      const bar = future[i]
      // Same-bar tie: stop takes priority (conservative).
      if (bar.low <= stop) {
        status = 'stopped_out'
        holdingDays = i + 1
        break
      }
      if (bar.high >= target) {
        status = 'target_hit'
        holdingDays = i + 1
        break
      }
    }

    if (status === 'open') {
      open++
      continue
    }

    const exitPrice = status === 'target_hit' ? target : stop
    const returnPct = ((exitPrice - trade.close) / trade.close) * 100
    const risk = trade.close - stop
    closedReturns.push(returnPct)
    closedHoldingDays.push(holdingDays)
    if (risk > 0) closedR.push((exitPrice - trade.close) / risk)

    if (status === 'target_hit') targetHits++
    else stoppedOut++
  }

  const total = targetHits + stoppedOut + open
  if (total === 0) return empty

  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

  return {
    market,
    totalTrades: total,
    targetHitRate: targetHits / total,
    stoppedOutRate: stoppedOut / total,
    openRate: open / total,
    avgReturnPct: mean(closedReturns),
    avgHoldingDays: mean(closedHoldingDays),
    avgR: mean(closedR),
  }
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
