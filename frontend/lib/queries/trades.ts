// 가상 매매장(paper_trades) 조회 — 보유 종목 점검 페이지가 쓴다.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { fetchPriceRowsPaged, SCREENER_CACHE_TAG } from './shared'
import type { Market } from '../types'

export interface PaperTradeRow {
  id: string
  market: Market
  ticker: string
  name: string
  sector: string
  source: 'pullback' | 'opportunity'
  entry_date: string
  entry_price: number
  exit_date: string | null
  exit_price: number | null
}

export interface PaperPosition extends PaperTradeRow {
  /** 열린 포지션이면 최신 종가, 닫힌 포지션이면 청산가 */
  currentPrice: number
  currentDate: string
  returnPct: number
  /** 진입 후 최고 종가 대비 얼마나 밀렸는지 (열린 포지션의 고점 대비 하락) */
  peakDrawdownPct: number | null
  holdingDays: number
  isOpen: boolean
}

/** 지금 열려 있는 티커 집합 — 스크리닝 화면에서 매수 버튼을 '보유 중'으로 바꾸는 데 쓴다. */
export async function getOpenTickers(): Promise<Set<string>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const { data } = await supabase
    .from('paper_trades')
    .select('market, ticker')
    .is('exit_date', null)

  return new Set(
    ((data ?? []) as { market: string; ticker: string }[]).map((r) => `${r.market}:${r.ticker}`),
  )
}

export async function getPaperTrades(): Promise<PaperPosition[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const supabase = createServerSupabaseClient()
  const { data, error } = await supabase
    .from('paper_trades')
    .select('id, market, ticker, name, sector, source, entry_date, entry_price, exit_date, exit_price')
    .order('entry_date', { ascending: false })

  if (error) throw new Error(error.message)
  const rows = (data ?? []) as PaperTradeRow[]
  if (rows.length === 0) return []

  // 열린 포지션만 현재가가 필요하다. 닫힌 건 청산가가 이미 확정값이다.
  const open = rows.filter((r) => r.exit_date === null)
  const barsByKey = new Map<string, { date: string; close: number }[]>()

  for (const market of ['KR', 'US'] as Market[]) {
    const tickers = [...new Set(open.filter((r) => r.market === market).map((r) => r.ticker))]
    if (tickers.length === 0) continue
    const oldest = open
      .filter((r) => r.market === market)
      .reduce((min, r) => (r.entry_date < min ? r.entry_date : min), '9999-12-31')

    const priceRows = await fetchPriceRowsPaged<{ ticker: string; date: string; close: number }>(
      market, tickers, 'ticker, date, close', oldest,
    )
    for (const row of priceRows) {
      const key = `${market}:${row.ticker}`
      const bucket = barsByKey.get(key)
      if (bucket) bucket.push({ date: row.date, close: row.close })
      else barsByKey.set(key, [{ date: row.date, close: row.close }])
    }
  }

  return rows.map((row) => {
    const isOpen = row.exit_date === null
    const bars = barsByKey.get(`${row.market}:${row.ticker}`) ?? []
    const last = bars.at(-1)

    // 열린 포지션인데 봉을 못 찾으면 진입가를 그대로 써서 0%로 둔다.
    // 없는 가격을 지어내느니 "아직 변화 없음"으로 보이는 편이 덜 위험하다.
    const currentPrice = isOpen ? (last?.close ?? row.entry_price) : (row.exit_price as number)
    const currentDate = isOpen ? (last?.date ?? row.entry_date) : (row.exit_date as string)

    const peak = bars.length > 0 ? Math.max(...bars.map((b) => b.close)) : null

    return {
      ...row,
      currentPrice,
      currentDate,
      returnPct: ((currentPrice - row.entry_price) / row.entry_price) * 100,
      peakDrawdownPct: isOpen && peak && peak > 0 ? ((currentPrice - peak) / peak) * 100 : null,
      holdingDays: bars.filter((b) => b.date > row.entry_date).length,
      isOpen,
    }
  })
}
