// 종목발굴 탭(app/discover) — 오늘의 추천 · 횡보·조정 · 실적 판정용 쿼리.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { FundamentalsRow, Market, OpportunitySnapshotRow, PriceHistoryRow } from '../types'

// 장기(10년) 월봉. stock_long_monthly는 과거 확정 구간이라 갱신이 거의 없고,
// 최근 3년은 mv_monthly_ohlcv(getMonthlyPriceHistory)가 매일 갱신한다. 둘을
// 합쳐야 "진짜 최고점"과 10년 차트를 모두 얻는다. 테이블 미생성 시 빈 맵.
// PostgREST가 응답을 max_rows=1000으로 자른다. 10년 월봉은 종목당 120행이라
// 배치 하나가 이 한도를 훌쩍 넘고, month_start 오름차순이라 잘리면 각 종목의
// 최근 구간이 통째로 사라진다(실제로 2018-01에서 끊기고 최근 3년으로 건너뛰는
// 차트가 됐다). getPriceHistoryByTicker와 동일하게 배치를 끝까지 페이지네이션한다.
const LONG_MONTHLY_BATCH = 60
const LONG_MONTHLY_PAGE = 1000

export async function getLongMonthlyHistory(
  market: Market,
  tickers: string[],
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()

  const batches: string[][] = []
  for (let i = 0; i < tickers.length; i += LONG_MONTHLY_BATCH) {
    batches.push(tickers.slice(i, i + LONG_MONTHLY_BATCH))
  }

  type LongRow = { ticker: string; month_start: string; open: number; high: number; low: number; close: number; volume: number }

  const results = await Promise.all(
    batches.map(async (batch) => {
      const rows: LongRow[] = []
      for (let from = 0; ; from += LONG_MONTHLY_PAGE) {
        const { data, error } = await supabase
          .from('stock_long_monthly')
          .select('ticker, month_start, open, high, low, close, volume')
          .eq('market', market)
          .in('ticker', batch)
          .order('ticker', { ascending: true })
          .order('month_start', { ascending: true })
          .range(from, from + LONG_MONTHLY_PAGE - 1)
        if (error) return rows
        rows.push(...((data ?? []) as LongRow[]))
        if (!data || data.length < LONG_MONTHLY_PAGE) break
      }
      return rows
    }),
  )

  const grouped: Record<string, PriceHistoryRow[]> = {}
  for (const row of results.flat()) {
    grouped[row.ticker] ??= []
    grouped[row.ticker].push({
      ticker: row.ticker,
      market,
      date: row.month_start,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    })
  }
  return grouped
}

// 파이프라인이 미리 계산한 횡보·조정 후보. 예전에는 페이지가 요청마다 유니버스
// 1,460종목의 조정폭을 집계하고 통과 종목의 일봉 14만 행을 받아 점수를 다시
// 계산했다(왕복 30회 이상). 이제 이 표만 읽는다. 테이블 미생성 시 빈 배열.
export async function getOpportunitySnapshot(): Promise<OpportunitySnapshotRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('opportunity_snapshot')
    .select('*')
    .order('score', { ascending: false })
  if (error) return []
  return (data ?? []) as OpportunitySnapshotRow[]
}

// 실적 요약. 테이블 미생성·미수집이면 빈 맵을 돌려주고 화면은 해당 섹션을 숨긴다.
export async function getFundamentals(
  market: Market,
  tickers: string[],
): Promise<Record<string, FundamentalsRow>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}
  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('stock_fundamentals')
    .select('*')
    .eq('market', market)
    .in('ticker', tickers)
  if (error) return {}
  const map: Record<string, FundamentalsRow> = {}
  for (const row of (data ?? []) as FundamentalsRow[]) map[row.ticker] = row
  return map
}

// Monthly OHLCV via SQL aggregation. Batched to stay under PostgREST max_rows=1000
// (36 bars × 25 tickers = 900 rows per batch; batches run in parallel).
const MONTHLY_BATCH_SIZE = 25

export async function getMonthlyPriceHistory(
  market: Market,
  tickers: string[],
  days = 1095,
): Promise<Record<string, PriceHistoryRow[]>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
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
