import { cacheLife } from 'next/cache'
import { createServerSupabaseClient } from './supabase'
import type { LeadingSectorRow, Market, MarketRegimeRow, PriceHistoryRow, ScreenedStockRow, UniverseStockRow } from './types'

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

  if (error) throw error
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

  if (error) throw error
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

  if (error) throw error
  return (data ?? []) as ScreenedStockRow[]
}

export async function getPriceHistoryByTicker(
  market: Market,
  tickers: string[],
  days = 120,
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
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

  if (error) throw error

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

  if (error) throw error
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
  if (error) throw error
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

// Computes 3-year high + current close in the DB (one RPC call → bypasses PostgREST max_rows=1000)
// new Date() lives here (inside 'use cache') — Next.js 16 cacheComponents mode requires this
export async function getOpportunityDrawdowns(
  market: Market,
  tickers: string[],
): Promise<DrawdownSummary[]> {
  'use cache'
  cacheLife('hours')
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
  if (error) throw error
  return (data ?? []) as DrawdownSummary[]
}
