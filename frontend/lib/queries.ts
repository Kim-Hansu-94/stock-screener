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
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  if (tickers.length === 0) return {}

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 120)
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

export async function getUniverseStocks(market: Market): Promise<UniverseStockRow[]> {
  'use cache'
  cacheLife('hours')
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_universe')
    .select('ticker, market, name, sector, index_membership, updated_at')
    .eq('market', market)

  if (error) throw error
  return (data ?? []) as UniverseStockRow[]
}

const PAGE_SIZE = 10_000

export async function getAllUniversePriceHistory(
  market: Market,
  tickers: string[],
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  if (tickers.length === 0) return {}

  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 3)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()
  const allRows: PriceHistoryRow[] = []
  let from = 0

  while (true) {
    const { data, error } = await supabase
      .from('stock_price_history')
      .select('ticker, market, date, open, high, low, close, volume')
      .eq('market', market)
      .in('ticker', tickers)
      .gte('date', cutoffStr)
      .order('ticker', { ascending: true })
      .order('date', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error
    if (!data?.length) break
    allRows.push(...(data as PriceHistoryRow[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of allRows) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }
  return grouped
}
