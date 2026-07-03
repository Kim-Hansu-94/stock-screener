import { cacheLife } from 'next/cache'
import { createServerSupabaseClient } from './supabase'
import type { DayReturn, LeadingSectorRow, Market, MarketRegimeRow, PriceHistoryRow, ScreenedStockPerf, ScreenedStockRow, ScreenedStockWithRisk, UniverseStockRow } from './types'

export async function getLatestRegime(market: Market): Promise<MarketRegimeRow | null> {
  'use cache'
  cacheLife('hours')
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('market_regime')
    .select('date, market, regime')
    .eq('market', market)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return data as MarketRegimeRow | null
}

export async function getLeadingSectors(market: Market, date: string): Promise<LeadingSectorRow[]> {
  'use cache'
  cacheLife('hours')
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('leading_sectors')
    .select('date, market, sector, rank')
    .eq('market', market)
    .eq('date', date)
    .order('rank', { ascending: true })

  if (error) throw new Error(error.message)
  return (data ?? []) as LeadingSectorRow[]
}

export async function getScreenedStocks(market: Market, date: string): Promise<ScreenedStockRow[]> {
  'use cache'
  cacheLife('hours')
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close, market_cap, rsi')
    .eq('market', market)
    .eq('date', date)

  if (error) throw new Error(error.message)
  return (data ?? []) as ScreenedStockRow[]
}

export async function getPriceHistoryByTicker(
  market: Market,
  tickers: string[],
  days = 120,
): Promise<Record<string, PriceHistoryRow[]>> {
  if (tickers.length === 0) return {}

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_price_history')
    .select('ticker, market, date, open, high, low, close, volume')
    .eq('market', market)
    .in('ticker', tickers)
    .gte('date', cutoffStr)
    .order('date', { ascending: true })

  if (error) throw new Error(error.message)

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (data ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }
  return grouped
}

export async function getUniverseStocks(
  market: Market,
  memberships?: string[],
): Promise<UniverseStockRow[]> {
  'use cache'
  cacheLife('hours')
  const supabase = createServerSupabaseClient()
  const { data, error } = memberships?.length
    ? await supabase
        .from('stock_universe')
        .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
        .eq('market', market)
        .in('index_membership', memberships)
    : await supabase
        .from('stock_universe')
        .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
        .eq('market', market)

  if (error) return []
  return (data ?? []) as UniverseStockRow[]
}

export async function getUniverseNameMap(
  market: Market,
  tickers: string[],
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_universe')
    .select('ticker, name_kr')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: Record<string, string> = {}
  for (const row of (data ?? []) as { ticker: string; name_kr: string | null }[]) {
    if (row.name_kr) map[row.ticker] = row.name_kr
  }
  return map
}

type DrawdownSummary = {
  ticker: string
  high3y: number
  current_close: number
  row_count: number
}

// Monthly OHLCV via SQL aggregation. Batched to stay under PostgREST max_rows=1000
// (36 bars × 25 tickers = 900 rows per batch; batches run in parallel).
const MONTHLY_BATCH_SIZE = 25

export async function getMonthlyPriceHistory(
  market: Market,
  tickers: string[],
  days = 1095,
): Promise<Record<string, PriceHistoryRow[]>> {
  if (tickers.length === 0) return {}
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += MONTHLY_BATCH_SIZE) {
    batches.push(tickers.slice(i, i + MONTHLY_BATCH_SIZE))
  }

  const batchResults = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await supabase.rpc('get_monthly_ohlcv', {
        p_market: market,
        p_tickers: batch,
        p_cutoff: cutoffStr,
      })
      if (error) throw new Error(error.message)
      return (data ?? []) as PriceHistoryRow[]
    }),
  )

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const rows of batchResults) {
    for (const row of rows) {
      grouped[row.ticker] ??= []
      grouped[row.ticker].push(row)
    }
  }
  return grouped
}

export async function getRegimesInRange(
  market: Market,
  cutoffStr: string,
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
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

type PriceBar = { date: string; high: number; low: number; close: number }

function computeATR(bars: PriceBar[], period = 14): number {
  if (bars.length < 2) return 0
  const trs: number[] = []
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    ))
  }
  const slice = trs.slice(-period)
  return slice.length > 0 ? slice.reduce((a, b) => a + b, 0) / slice.length : 0
}

const TREND_SMA_PERIOD = 20
const TREND_LOOKBACK = 5

function computeSMA(bars: PriceBar[], period: number): number | null {
  if (bars.length < period) return null
  const slice = bars.slice(-period)
  return slice.reduce((sum, b) => sum + b.close, 0) / period
}

// Requires price above a rising SMA20 so a downtrending stock's tight ATR stop
// doesn't produce a misleadingly high risk-reward ratio (RR ignores trend direction otherwise)
function isUptrend(bars: PriceBar[]): boolean {
  if (bars.length < TREND_SMA_PERIOD + TREND_LOOKBACK) return false
  const smaNow = computeSMA(bars, TREND_SMA_PERIOD)
  const smaPrior = computeSMA(bars.slice(0, -TREND_LOOKBACK), TREND_SMA_PERIOD)
  if (smaNow === null || smaPrior === null) return false
  const latestClose = bars.at(-1)!.close
  return latestClose > smaNow && smaNow > smaPrior
}

export async function getScreenedStockPerformance(
  market: Market,
  days = 30,
): Promise<ScreenedStockPerf[]> {
  'use cache'
  cacheLife('hours')

  const supabase = createServerSupabaseClient()
  const today = new Date().toISOString().slice(0, 10)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  // Past recommendations only (exclude today since day1 would be today's close, not yet settled)
  const { data: recs, error: recsError } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close')
    .eq('market', market)
    .lt('date', today)
    .gte('date', cutoffStr)
    .order('date', { ascending: false })

  if (recsError) throw new Error(recsError.message)
  if (!recs?.length) return []

  const tickers = [...new Set(recs.map((r: { ticker: string }) => r.ticker))]
  const oldestDate = (recs as { date: string }[]).at(-1)!.date
  const nameKrMap = await getUniverseNameMap(market, tickers)

  // Extend 40 calendar days before oldest rec date for ATR + swing level calculation
  const prePeriodDate = new Date(oldestDate)
  prePeriodDate.setDate(prePeriodDate.getDate() - 40)
  const prePeriodStr = prePeriodDate.toISOString().slice(0, 10)

  const { data: priceData, error: priceError } = await supabase
    .from('stock_price_history')
    .select('ticker, date, high, low, close')
    .eq('market', market)
    .in('ticker', tickers)
    .gte('date', prePeriodStr)
    .order('date', { ascending: true })

  if (priceError) throw new Error(priceError.message)

  const priceMap: Record<string, PriceBar[]> = {}
  for (const row of (priceData ?? []) as (PriceBar & { ticker: string })[]) {
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

      let stop: number | null = null
      let target: number | null = null
      let riskReward: number | null = null

      if (preBars.length >= 10 && isUptrend(preBars)) {
        const recent20 = preBars.slice(-20)
        const recent30 = preBars.slice(-30)

        const swingLow = Math.min(...recent20.map((p) => p.low))
        const swingHigh = Math.max(...recent30.map((p) => p.high))
        const atr = computeATR(recent20)

        const atrStop = atr > 0 ? rec.close - 1.5 * atr : swingLow
        // Take the tighter (higher) of the two stops
        const rawStop = Math.max(swingLow, atrStop)

        if (rawStop < rec.close) {
          stop = rawStop
          const risk = rec.close - stop
          // Target = previous swing high (pullback thesis: reclaim the prior peak)
          target = swingHigh > rec.close ? swingHigh : rec.close + 2 * risk
          riskReward = (target - rec.close) / risk
        }
      }

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

  // 120 days of daily OHLCV — used for both ATR/swing calculation and chart display
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 120)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const { data: priceData, error: priceError } = await supabase
    .from('stock_price_history')
    .select('ticker, market, date, open, high, low, close, volume')
    .eq('market', market)
    .in('ticker', tickers)
    .gte('date', cutoffStr)
    .order('date', { ascending: true })

  if (priceError) throw new Error(priceError.message)

  const priceMap: Record<string, PriceHistoryRow[]> = {}
  for (const row of (priceData ?? []) as PriceHistoryRow[]) {
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
      let stop: number | null = null
      let target: number | null = null
      let riskReward: number | null = null

      if (bars.length >= 10 && isUptrend(bars)) {
        const recent20 = bars.slice(-20)
        const recent30 = bars.slice(-30)

        const swingLow = Math.min(...recent20.map((p) => p.low))
        const swingHigh = Math.max(...recent30.map((p) => p.high))
        const atr = computeATR(recent20)

        const atrStop = atr > 0 ? entry - 1.5 * atr : swingLow
        const rawStop = Math.max(swingLow, atrStop)

        if (rawStop < entry) {
          stop = rawStop
          const risk = entry - stop
          target = swingHigh > entry ? swingHigh : entry + 2 * risk
          riskReward = (target - entry) / risk
        }
      }

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

// Computes 3-year high + current close in the DB (one RPC call → bypasses PostgREST max_rows=1000)
export async function getOpportunityDrawdowns(
  market: Market,
  tickers: string[],
): Promise<DrawdownSummary[]> {
  if (tickers.length === 0) return []
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase.rpc('get_opp_drawdowns', {
    p_market: market,
    p_tickers: tickers,
    p_cutoff: cutoffStr,
  })
  if (error) throw new Error(error.message)
  return (data ?? []) as DrawdownSummary[]
}
