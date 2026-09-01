// 가상 매매장(paper_trades) 조회 — 보유 종목 점검 페이지가 쓴다.
import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { fetchPriceRowsPaged, SCREENER_CACHE_TAG } from './shared'
import { computeStopTarget, type PriceBar } from '../risk'
import { findExitSignal, signalReturnPct, type ExitSignal } from '../exitSignal'
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
  /** 진입 후 처음 매도 신호가 뜬 날. 없으면 null(아직 보유 유지). */
  exitSignal: ExitSignal | null
  /** 그 신호일에 팔았다면 몇 %였을지. 실제 성과와 나란히 놓아 판단을 되짚는다. */
  signalReturnPct: number | null
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

/** 매도 신호 판정에 쓰는 날짜별 장세·주도 섹터. 둘 다 하루 몇 행뿐이라 통째로 받는다. */
async function loadMarketContext(market: Market, since: string) {
  const supabase = createServerSupabaseClient()
  const [{ data: regimes }, { data: sectors }] = await Promise.all([
    supabase.from('market_regime').select('date, regime').eq('market', market).gte('date', since),
    supabase.from('leading_sectors').select('date, sector').eq('market', market).gte('date', since),
  ])

  const regimeByDate: Record<string, string> = {}
  for (const r of (regimes ?? []) as { date: string; regime: string }[]) {
    regimeByDate[r.date] = r.regime
  }
  const leadingSectorsByDate: Record<string, string[]> = {}
  for (const r of (sectors ?? []) as { date: string; sector: string }[]) {
    ;(leadingSectorsByDate[r.date] ??= []).push(r.sector)
  }
  return { regimeByDate, leadingSectorsByDate }
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

  // 매도 신호를 판정하려면 진입 이전 봉도 필요하다 — 손절/목표 계산(피벗 탐색 ~90거래일)과
  // 60일선 계산이 진입 직후부터 되려면 앞쪽 여유가 있어야 한다. 그래서 청산된 트레이드까지
  // 포함해 가장 이른 진입일보다 150일 앞에서부터 받는다.
  const oldestEntry = rows.reduce((min, r) => (r.entry_date < min ? r.entry_date : min), '9999-12-31')
  const since = new Date(oldestEntry)
  since.setDate(since.getDate() - 150)
  const sinceStr = since.toISOString().slice(0, 10)

  const barsByKey = new Map<string, PriceBar[]>()
  const contextByMarket: Partial<Record<Market, Awaited<ReturnType<typeof loadMarketContext>>>> = {}

  for (const market of ['KR', 'US'] as Market[]) {
    const tickers = [...new Set(rows.filter((r) => r.market === market).map((r) => r.ticker))]
    if (tickers.length === 0) continue

    const [priceRows, context] = await Promise.all([
      fetchPriceRowsPaged<PriceBar & { ticker: string }>(
        market, tickers, 'ticker, date, open, high, low, close, volume', sinceStr,
      ),
      loadMarketContext(market, sinceStr),
    ])
    contextByMarket[market] = context

    for (const row of priceRows) {
      const key = `${market}:${row.ticker}`
      const b = {
        date: row.date, open: row.open, high: row.high,
        low: row.low, close: row.close, volume: row.volume,
      }
      const bucket = barsByKey.get(key)
      if (bucket) bucket.push(b)
      else barsByKey.set(key, [b])
    }
  }

  return rows.map((row) => {
    const isOpen = row.exit_date === null
    const allBars = barsByKey.get(`${row.market}:${row.ticker}`) ?? []
    const trailingBars = allBars.filter((b) => b.date <= row.entry_date)
    // 청산된 트레이드는 매도일까지만 본다 — 판 뒤에 뜬 신호는 그때의 판단과 무관하다.
    const heldBars = allBars.filter(
      (b) => b.date > row.entry_date && (isOpen || b.date <= (row.exit_date as string)),
    )
    const last = heldBars.at(-1)

    // 열린 포지션인데 봉을 못 찾으면 진입가를 그대로 써서 0%로 둔다.
    // 없는 가격을 지어내느니 "아직 변화 없음"으로 보이는 편이 덜 위험하다.
    const currentPrice = isOpen ? (last?.close ?? row.entry_price) : (row.exit_price as number)
    const currentDate = isOpen ? (last?.date ?? row.entry_date) : (row.exit_date as string)

    const peak = heldBars.length > 0 ? Math.max(...heldBars.map((b) => b.close)) : null

    const { stop, target } = computeStopTarget(trailingBars, row.entry_price)
    const context = contextByMarket[row.market]
    const exitSignal = context
      ? findExitSignal({
          futureBars: heldBars,
          trailingBars,
          source: row.source,
          stop,
          target,
          sector: row.sector,
          regimeByDate: context.regimeByDate,
          leadingSectorsByDate: context.leadingSectorsByDate,
        })
      : null

    return {
      ...row,
      currentPrice,
      currentDate,
      returnPct: ((currentPrice - row.entry_price) / row.entry_price) * 100,
      peakDrawdownPct: isOpen && peak && peak > 0 ? ((currentPrice - peak) / peak) * 100 : null,
      holdingDays: heldBars.length,
      isOpen,
      exitSignal,
      signalReturnPct: exitSignal ? signalReturnPct(row.entry_price, exitSignal) : null,
    }
  })
}
