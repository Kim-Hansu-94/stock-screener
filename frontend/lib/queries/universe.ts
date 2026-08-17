// 종목 유니버스(이름·섹터·시총) 메타데이터 조회. 여러 화면이 공용으로 쓴다.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { Market, MarketCapMap, UniverseStockRow } from '../types'

export async function getUniverseStocks(
  market: Market,
  memberships?: string[],
): Promise<UniverseStockRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const PAGE_SIZE = 1000
  const rows: UniverseStockRow[] = []

  for (let page = 0; ; page++) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const query = memberships?.length
      ? supabase
          .from('stock_universe')
          .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
          .eq('market', market)
          .in('index_membership', memberships)
      : supabase
          .from('stock_universe')
          .select('ticker, market, name, name_kr, sector, index_membership, updated_at')
          .eq('market', market)

    const { data, error } = await query.range(from, to)
    if (error) return []

    rows.push(...((data ?? []) as UniverseStockRow[]))
    if (!data || data.length < PAGE_SIZE) break
  }

  return rows
}

export async function getUniverseNameMap(
  market: Market,
  tickers: string[],
): Promise<Record<string, string>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
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

// stock_universe에서 시가총액만 조회. market_cap 컬럼이 아직 없는 배포(ALTER 미실행)나
// 파이프라인 미갱신 상태에서도 화면이 깨지지 않도록, 실패하면 빈 맵을 반환한다.
export async function getUniverseMarketCaps(
  market: Market,
  tickers: string[],
): Promise<MarketCapMap> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_universe')
    .select('ticker, market_cap')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: MarketCapMap = {}
  for (const row of (data ?? []) as { ticker: string; market_cap: number | null }[]) {
    if (row.market_cap != null && row.market_cap > 0) map[row.ticker] = row.market_cap
  }
  return map
}
