import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import type { Market } from '../types'

// 파이프라인이 매일 아침 DB를 갱신한 직후 /api/revalidate가 이 태그를 일괄 무효화해,
// 모든 페이지·섹션이 같은 시점의 데이터로 함께 갱신된다. cacheLife는 웹훅 실패 시 안전망.
export const SCREENER_CACHE_TAG = 'screener-data'

// 미국 시총·주가의 원화 환산용 환율. 실패 시 대략적인 고정값으로 폴백.
export async function fetchUsdKrwRate(): Promise<number> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=KRW')
    const json = await res.json()
    return json.rates.KRW as number
  } catch {
    return 1380
  }
}

// PostgREST caps a single response at max_rows=1000. A flat `.in(tickers)` query over
// ~100 bars/ticker silently truncates once ~10+ tickers are requested, and because the
// rows come back date-ascending the truncation drops each ticker's most RECENT bars —
// leaving some tickers under the 65-bar minimum that computeStopTarget/isUptrend needs,
// which then reports "손익비 —" for stocks that actually qualify. So we batch the ticker
// list and page each batch to completion.
const PRICE_HISTORY_BATCH = 15
const PRICE_HISTORY_PAGE = 1000

// stock_price_history를 여러 티커에 대해 읽는 모든 곳이 써야 하는 헬퍼.
// 위 max_rows=1000 절단은 조용히 일어나 데이터가 "일부만" 돌아오므로,
// 개별 호출부가 페이지네이션을 빠뜨리면 알아채기 어려운 오작동이 된다.
export async function fetchPriceRowsPaged<T>(
  market: Market,
  tickers: string[],
  columns: string,
  cutoffStr: string,
): Promise<T[]> {
  if (tickers.length === 0) return []
  const supabase = createServerSupabaseClient()
  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += PRICE_HISTORY_BATCH) {
    batches.push(tickers.slice(i, i + PRICE_HISTORY_BATCH))
  }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const rows: T[] = []
      for (let from = 0; ; from += PRICE_HISTORY_PAGE) {
        const { data, error } = await supabase
          .from('stock_price_history')
          .select(columns)
          .eq('market', market)
          .in('ticker', batch)
          .gte('date', cutoffStr)
          .order('ticker', { ascending: true })
          .order('date', { ascending: true })
          .range(from, from + PRICE_HISTORY_PAGE - 1)
        if (error) throw new Error(error.message)
        rows.push(...((data ?? []) as T[]))
        if (!data || data.length < PRICE_HISTORY_PAGE) break
      }
      return rows
    }),
  )
  return results.flat()
}
