import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { ConsensusRow, InvestorFlowRow } from '../types'
import { summarizeFlow } from '../investorFlow'

/**
 * 국내 시장 부가 데이터 2종 조회 — 수급 · 목표주가 컨센서스.
 *
 * **자사주 매입은 2026-10-27에 걷어냈다 (사용자 요청)** — SK하이닉스 프로그램이
 * 끝나(DART 최신 공시가 2026-10-26자 `자기주식취득결과보고서`) 볼 대상이 없어졌다.
 *
 * 세 표 모두 본 파이프라인이 아닌 별도 워크플로
 * (`.github/workflows/kr_market_extras.yml`)가 채운다. 그래서 **데이터가 아직
 * 없는 게 정상 상태**다(워크플로가 처음 도는 날까지). 조회가 실패하거나 표가
 * 아직 없어도 빈 값을 돌려주고, 화면은 그 섹션만 숨긴다 — 여기서 예외를 던지면
 * 부가 정보 하나 때문에 카드 전체가 못 뜬다.
 */

/** 화면이 보여주는 수급 구간. 20영업일이면 "최근 한 달 누가 사고 있나"가 보인다. */
export const FLOW_DISPLAY_DAYS = 20

async function safeSelect<T>(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  try {
    const { data, error } = await run()
    if (error) return []
    return (data ?? []) as T[]
  } catch {
    return []
  }
}

export async function getInvestorFlow(ticker: string): Promise<InvestorFlowRow[]> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const rows = await safeSelect<InvestorFlowRow>(() =>
    supabase
      .from('investor_flow')
      .select(
        'market, ticker, name, date, close, foreign_net_qty, institution_net_qty, foreign_net_amount, institution_net_amount, source',
      )
      .eq('market', 'KR')
      .eq('ticker', ticker)
      .order('date', { ascending: false })
      .limit(FLOW_DISPLAY_DAYS),
  )
  // 화면은 왼쪽이 과거인 막대그래프로 그리므로 날짜 오름차순으로 뒤집어 준다.
  return rows.slice().reverse()
}

export async function getConsensus(ticker: string): Promise<ConsensusRow | null> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const rows = await safeSelect<ConsensusRow>(() =>
    supabase
      .from('stock_consensus')
      .select('market, ticker, name, date, target_price, upside_pct, opinion, report_count, consensus_eps, source')
      .eq('market', 'KR')
      .eq('ticker', ticker)
      .limit(1),
  )
  return rows[0] ?? null
}

/**
 * 접힌 카드에 띄울 **요약** — 수급·컨센서스를 종목당 숫자 몇 개로 줄인다.
 *
 * 카드를 펼쳐야만 보이던 정보를 눈에 띄게 하려고 만들었다. 상세는 그대로
 * `/api/kr-extras`(펼쳤을 때)가 맡고, 여기서는 **미리 보내도 무겁지 않은 것만**
 * 낸다 — 종목당 숫자 서너 개라, 예전에 페이지를 느리게 만들던 일봉 150개와는
 * 차원이 다르다. 그 교훈은 "다 보내지 말라"였지 "아무것도 보내지 말라"가 아니다.
 */

/** 요약 배지가 보는 수급 구간. 상세 화면(20일)과 같은 창을 쓴다. */
const SUMMARY_FLOW_DAYS = 20

export type KrExtrasSummary = {
  /** 구간 누적 외국인 순매매 수량(주). 값이 없으면 배지를 안 그린다. */
  foreignNetQty: number | null
  foreignNetAmount: number | null
  /** 같은 방향이 이어진 일수 (순매수면 양수) */
  foreignStreak: number
  /** 관측된 날 수 — 0이면 수급 배지를 숨긴다 */
  foreignDays: number
  targetPrice: number | null
  /** 저장 시점 종가 기준 상승여력. 화면에 최신 종가가 있으면 그걸로 다시 계산한다. */
  targetUpsidePct: number | null
}

function emptySummary(): KrExtrasSummary {
  return {
    foreignNetQty: null,
    foreignNetAmount: null,
    foreignStreak: 0,
    foreignDays: 0,
    targetPrice: null,
    targetUpsidePct: null,
  }
}

/**
 * @param tickers 국내 종목 코드. 빈 배열이면 조회하지 않는다.
 * @returns 티커 → 요약. 데이터가 없는 종목은 키가 아예 없다(화면이 배지를 숨긴다).
 */
export async function getKrExtrasSummaries(
  tickers: string[],
): Promise<Record<string, KrExtrasSummary>> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  if (tickers.length === 0) return {}

  const supabase = createServerSupabaseClient()
  const cutoff = new Date()
  // 영업일이 아니라 달력일 기준이라 주말·공휴일을 감안해 넉넉히 잡는다.
  cutoff.setDate(cutoff.getDate() - SUMMARY_FLOW_DAYS * 2)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const [flowRows, consensusRows] = await Promise.all([
    safeSelect<{
      ticker: string
      date: string
      foreign_net_qty: number | null
      foreign_net_amount: number | null
    }>(() =>
      supabase
        .from('investor_flow')
        .select('ticker, date, foreign_net_qty, foreign_net_amount')
        .eq('market', 'KR')
        .in('ticker', tickers)
        .gte('date', cutoffStr)
        .order('date', { ascending: true }),
    ),
    safeSelect<{ ticker: string; target_price: number; upside_pct: number | null }>(() =>
      supabase
        .from('stock_consensus')
        .select('ticker, target_price, upside_pct')
        .eq('market', 'KR')
        .in('ticker', tickers),
    ),
  ])

  const result: Record<string, KrExtrasSummary> = {}
  const ensure = (ticker: string) => (result[ticker] ??= emptySummary())

  // 수급은 종목별로 최근 SUMMARY_FLOW_DAYS일만 남겨 누적한다.
  const byTicker = new Map<string, typeof flowRows>()
  for (const row of flowRows) {
    const list = byTicker.get(row.ticker) ?? []
    list.push(row)
    byTicker.set(row.ticker, list)
  }
  for (const [ticker, rows] of byTicker) {
    // 연속 일수·누적 규칙은 상세 화면과 **같은 함수**를 쓴다. 여기서 따로 세면
    // 배지와 상세가 다른 숫자를 말하게 된다(0인 날을 연속으로 볼지 등).
    const flow = summarizeFlow(rows.slice(-SUMMARY_FLOW_DAYS), 'foreign')
    const summary = ensure(ticker)
    summary.foreignDays = flow.days
    summary.foreignStreak = flow.streak
    if (flow.days > 0) {
      summary.foreignNetQty = flow.netQty
      summary.foreignNetAmount = flow.netAmount
    }
  }

  for (const row of consensusRows) {
    const summary = ensure(row.ticker)
    summary.targetPrice = row.target_price
    summary.targetUpsidePct = row.upside_pct
  }

  return result
}
