import { createServerSupabaseClient } from '@/lib/supabase'
import type { AlertStock, Market, OpportunityAlertStock } from '@/lib/types'

/**
 * 사이트 진입 시 팝업으로 띄울 "오늘의 알림" — 눌림목 전 조건 충족 종목 +
 * 횡보·조정 매력도 95점 이상 종목. 클라이언트(DailyAlertPopup)가 로드 시 한 번 호출한다.
 */

const OPPORTUNITY_SCORE_THRESHOLD = 0.95

async function fullyPassedPullback(
  supabase: ReturnType<typeof createServerSupabaseClient>,
  market: Market,
): Promise<AlertStock[]> {
  const { data: latestRow } = await supabase
    .from('screened_stocks')
    .select('date')
    .eq('market', market)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!latestRow) return []

  // screened_stocks에는 name_kr 컬럼이 없다(KR 종목은 name 자체가 이미 한글 —
  // universe_kr.py가 FinanceDataReader "Name"을 그대로 씀). US 종목의 한글명은
  // stock_universe.name_kr인데, 팝업 하나 띄우자고 별도 조회를 더 붙이지 않는다.
  const { data } = await supabase
    .from('screened_stocks')
    .select('ticker, name')
    .eq('market', market)
    .eq('date', (latestRow as { date: string }).date)
    .eq('passed', true)

  return ((data ?? []) as { ticker: string; name: string }[]).map((r) => ({
    ticker: r.ticker,
    market,
    name: r.name,
    nameKr: null,
  }))
}

export async function GET() {
  const supabase = createServerSupabaseClient()

  const [pullbackKr, pullbackUs, { data: opportunityRows }] = await Promise.all([
    fullyPassedPullback(supabase, 'KR'),
    fullyPassedPullback(supabase, 'US'),
    supabase
      .from('opportunity_snapshot')
      .select('ticker, market, name, name_kr, score')
      .gte('score', OPPORTUNITY_SCORE_THRESHOLD)
      .order('score', { ascending: false }),
  ])

  const opportunity: OpportunityAlertStock[] = (
    (opportunityRows ?? []) as { ticker: string; market: Market; name: string; name_kr: string | null; score: number }[]
  ).map((r) => ({ ticker: r.ticker, market: r.market, name: r.name, nameKr: r.name_kr, score: r.score }))

  return Response.json({ pullback: [...pullbackKr, ...pullbackUs], opportunity })
}
