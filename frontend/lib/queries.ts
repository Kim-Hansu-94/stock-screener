import { cacheLife } from 'next/cache'
import { createServerSupabaseClient } from './supabase'
import type { DayReturn, LeadingSectorRow, Market, MarketRegimeRow, PriceHistoryRow, ScreenedStockPerf, ScreenedStockRow, UniverseStockRow } from './types'

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

  const { data: priceData, error: priceError } = await supabase
    .from('stock_price_history')
    .select('ticker, date, close')
    .eq('market', market)
    .in('ticker', tickers)
    .gte('date', oldestDate)
    .order('date', { ascending: true })

  if (priceError) throw new Error(priceError.message)

  const priceMap: Record<string, { date: string; close: number }[]> = {}
  for (const row of (priceData ?? []) as { ticker: string; date: string; close: number }[]) {
    priceMap[row.ticker] ??= []
    priceMap[row.ticker].push({ date: row.date, close: row.close })
  }

  return (recs as { date: string; market: string; ticker: string; name: string; sector: string; close: number }[]).map(
    (rec) => {
      const future = (priceMap[rec.ticker] ?? []).filter((p) => p.date > rec.date)
      const makeReturn = (i: number): DayReturn | null => {
        const row = future[i]
        if (!row) return null
        return { date: row.date, close: row.close, returnPct: ((row.close - rec.close) / rec.close) * 100 }
      }
      return {
        date: rec.date,
        market: rec.market as Market,
        ticker: rec.ticker,
        name: rec.name,
        sector: rec.sector,
        entryPrice: rec.close,
        day1: makeReturn(0),
        day2: makeReturn(1),
        day3: makeReturn(2),
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
