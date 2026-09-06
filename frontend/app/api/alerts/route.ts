import { createServerSupabaseClient } from '@/lib/supabase'
import { NEW_ENTRY_WINDOW_DAYS, TURN_SIGNAL_WINDOW_DAYS } from '@/lib/buySignal'
import type {
  AlertStock, Market, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock,
} from '@/lib/types'

/**
 * 사이트 진입 시 팝업으로 띄울 "오늘의 알림" — 눌림목 전 조건 충족 종목 +
 * 횡보·조정 매력도 95점 이상 종목 + 오늘 막 하드필터를 통과하기 시작한 관찰 대상 +
 * 오늘 막 박스 상단을 돌파한 종목. 클라이언트(DailyAlertPopup)가 로드 시 한 번 호출한다.
 *
 * 관찰 대상을 따로 두는 이유: 매력도 점수(95점 기준)는 저점 이후 몇 달은 조용해야
 * 오르는 구조라, 점수 기준 알림만으로는 항상 "이미 어느 정도 오른 뒤"에야 알려주게
 * 된다. qualified_since가 오늘(또는 최근 며칠) 시작된 종목은 점수와 무관하게
 * "바닥을 막 다지기 시작했다"는 사실 자체를 미리 알려준다 — 매수 신호가 아니라
 * 참고용 관찰 대상이라는 점을 화면에서 분명히 구분해서 보여줘야 한다.
 *
 * 전환 신호를 또 따로 두는 이유: qualified_since는 "며칠째 후보인지"만 볼 뿐, 후보로
 * 뜬 지 오래여도 실제로 오르기 시작한 건 최근일 수 있다. "이미 몇 배 오른 뒤에야
 * 알았다"는 불만은 결국 이 전환 시점을 놓쳤다는 뜻이라, breakout_since(박스 상단
 * 돌파 + 거래량 확인)가 최근인 종목을 점수와 무관하게 별도로 보여준다. 이평 정배열
 * 대신 이 신호를 쓰는 이유는 pipeline/src/watchlist.py의 detect_box_breakout 참고.
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

  const newEntryCutoff = new Date()
  newEntryCutoff.setUTCDate(newEntryCutoff.getUTCDate() - NEW_ENTRY_WINDOW_DAYS)
  const newEntryCutoffDate = newEntryCutoff.toISOString().slice(0, 10)

  const turnSignalCutoff = new Date()
  turnSignalCutoff.setUTCDate(turnSignalCutoff.getUTCDate() - TURN_SIGNAL_WINDOW_DAYS)
  const turnSignalCutoffDate = turnSignalCutoff.toISOString().slice(0, 10)

  const [
    pullbackKr, pullbackUs, { data: opportunityRows }, { data: newEntryRows }, { data: turnSignalRows },
  ] = await Promise.all([
    fullyPassedPullback(supabase, 'KR'),
    fullyPassedPullback(supabase, 'US'),
    supabase
      .from('opportunity_snapshot')
      .select('ticker, market, name, name_kr, score')
      .gte('score', OPPORTUNITY_SCORE_THRESHOLD)
      .order('score', { ascending: false }),
    // 95점 미만 + 최근 며칠 내 새로 하드필터를 통과하기 시작한 종목만 — 위 목록과
    // 겹치지 않게 하고("이미 확인된 것"과 "막 시작된 것"을 분리), 오래전부터
    // 조용히 낮은 점수로 머무는 종목까지 매번 다시 알리지 않게 한다.
    supabase
      .from('opportunity_snapshot')
      .select('ticker, market, name, name_kr, score, qualified_since')
      .gte('qualified_since', newEntryCutoffDate)
      .lt('score', OPPORTUNITY_SCORE_THRESHOLD)
      .order('qualified_since', { ascending: false }),
    // 95점 미만 + 최근 며칠 내 박스 상단을 돌파한 종목 — 후보로 뜬 지는
    // 오래됐어도(qualified_since와 무관) 실제로 오르기 시작한 시점 자체를 알려준다.
    supabase
      .from('opportunity_snapshot')
      .select('ticker, market, name, name_kr, score, breakout_since')
      .gte('breakout_since', turnSignalCutoffDate)
      .lt('score', OPPORTUNITY_SCORE_THRESHOLD)
      .order('breakout_since', { ascending: false }),
  ])

  const opportunity: OpportunityAlertStock[] = (
    (opportunityRows ?? []) as { ticker: string; market: Market; name: string; name_kr: string | null; score: number }[]
  ).map((r) => ({ ticker: r.ticker, market: r.market, name: r.name, nameKr: r.name_kr, score: r.score }))

  const newEntries: NewEntryAlertStock[] = (
    (newEntryRows ?? []) as {
      ticker: string; market: Market; name: string; name_kr: string | null
      score: number; qualified_since: string
    }[]
  ).map((r) => ({
    ticker: r.ticker, market: r.market, name: r.name, nameKr: r.name_kr,
    score: r.score, qualifiedSince: r.qualified_since,
  }))

  const turnSignals: TurnSignalAlertStock[] = (
    (turnSignalRows ?? []) as {
      ticker: string; market: Market; name: string; name_kr: string | null
      score: number; breakout_since: string
    }[]
  ).map((r) => ({
    ticker: r.ticker, market: r.market, name: r.name, nameKr: r.name_kr,
    score: r.score, breakoutSince: r.breakout_since,
  }))

  return Response.json({ pullback: [...pullbackKr, ...pullbackUs], opportunity, newEntries, turnSignals })
}
