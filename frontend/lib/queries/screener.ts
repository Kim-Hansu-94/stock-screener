// 홈 화면(app/page.tsx) 눌림목 스크리너 + 감시 종목 카드용 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { LeadingSectorRow, Market, MarketRegimeRow, PriceHistoryRow, ScreenedStockRow, WatchlistStatusRow, WatchlistTickerRow } from '../types'

// 감시 종목(보유 종목) 상태. 테이블 미생성(CREATE TABLE 미실행) 상태에서도
// 홈 화면이 깨지지 않도록 실패 시 빈 배열을 반환한다.
export async function getWatchlistStatus(): Promise<WatchlistStatusRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('watchlist_status')
    .select('*')
    .order('ticker', { ascending: true })
  if (error) return []
  return (data ?? []) as WatchlistStatusRow[]
}

// 사이트에서 직접 추가한 감시 종목 원본(/api/watchlist). watchlist_status와 합쳐
// "방금 추가해서 아직 파이프라인 평가 전"인 종목도 카드에 보여주는 데 쓴다.
export async function getWatchlistTickers(): Promise<WatchlistTickerRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('watchlist_tickers')
    .select('*')
    .order('added_at', { ascending: false })
  if (error) return []
  return (data ?? []) as WatchlistTickerRow[]
}

export async function getLatestRegime(market: Market): Promise<MarketRegimeRow | null> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
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
  cacheTag(SCREENER_CACHE_TAG)
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
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('screened_stocks')
    .select('date, market, ticker, name, sector, close, market_cap, rsi, passed, failed_criteria')
    .eq('market', market)
    .eq('date', date)

  if (error) throw new Error(error.message)
  // 전 조건 통과 종목 먼저, 근접 후보는 미달 조건 적은 순
  const rows = (data ?? []) as ScreenedStockRow[]
  return rows.sort(
    (a, b) =>
      Number(b.passed) - Number(a.passed) ||
      a.failed_criteria.length - b.failed_criteria.length,
  )
}

const PRICE_HISTORY_BATCH = 15
const PRICE_HISTORY_PAGE = 1000

export async function getPriceHistoryByTicker(
  market: Market,
  tickers: string[],
  days = 150,
): Promise<Record<string, PriceHistoryRow[]>> {
  // 홈 화면에서 가장 무거운 쿼리(전 종목 × ~150일 봉)인데 데이터는 하루 한 번만
  // 바뀐다. 다른 쿼리들과 같은 태그로 캐시해 매 방문마다 Supabase 왕복을 없앤다.
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += PRICE_HISTORY_BATCH) {
    batches.push(tickers.slice(i, i + PRICE_HISTORY_BATCH))
  }

  const fetchBatch = async (batch: string[]): Promise<PriceHistoryRow[]> => {
    const rows: PriceHistoryRow[] = []
    for (let from = 0; ; from += PRICE_HISTORY_PAGE) {
      const { data, error } = await supabase
        .from('stock_price_history')
        .select('ticker, market, date, open, high, low, close, volume')
        .eq('market', market)
        .in('ticker', batch)
        .gte('date', cutoffStr)
        .order('ticker', { ascending: true })
        .order('date', { ascending: true })
        .range(from, from + PRICE_HISTORY_PAGE - 1)
      if (error) throw new Error(error.message)
      rows.push(...((data ?? []) as PriceHistoryRow[]))
      if (!data || data.length < PRICE_HISTORY_PAGE) break
    }
    return rows
  }

  const batchResults = await Promise.all(batches.map(fetchBatch))

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of batchResults.flat()) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push(row)
  }
  return grouped
}
