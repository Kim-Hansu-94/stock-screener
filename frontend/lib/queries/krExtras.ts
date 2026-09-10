import { cacheLife, cacheTag } from 'next/cache'
import { createServerSupabaseClient } from '../supabase'
import { SCREENER_CACHE_TAG } from './shared'
import type { BuybackRow, ConsensusRow, InvestorFlowRow } from '../types'

/**
 * 국내 시장 부가 데이터 3종 조회 — 수급 · 목표주가 컨센서스 · 자사주 매입.
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

export async function getBuyback(ticker: string): Promise<BuybackRow | null> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)
  const supabase = createServerSupabaseClient()
  const rows = await safeSelect<BuybackRow>(() =>
    supabase
      .from('stock_buyback')
      .select(
        'market, ticker, name, latest_report, latest_report_date, latest_report_url, is_disposal, planned_amount, planned_qty, acquired_amount, amount_progress_pct, period_progress_pct, period_start, period_end, disclosure_count',
      )
      .eq('market', 'KR')
      .eq('ticker', ticker)
      .limit(1),
  )
  return rows[0] ?? null
}
