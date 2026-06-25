import { createServerSupabaseClient } from './supabase'
import type { LeadingSectorRow, Market, MarketRegimeRow, PriceHistoryRow, ScreenedStockRow } from './types'

export async function getLatestRegime(market: Market): Promise<MarketRegimeRow | null> {
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
  if (tickers.length === 0) return {}

  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_price_history')
    .select('ticker, market, date, open, high, low, close, volume')
    .eq('market', market)
    .in('ticker', tickers)
    .order('date', { ascending: true })

  if (error) throw error

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of (data ?? []) as PriceHistoryRow[]) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }
  return grouped
}
