import { createServerSupabaseClient } from '@/lib/supabase'
import { cacheLife, cacheTag } from 'next/cache'
import { SCREENER_CACHE_TAG } from './shared'
import {
  ETF_TICKER,
  FALLBACK_PROXY_HOLDINGS,
  FALLBACK_PROXY_WEIGHTS_AS_OF,
  type ProxyHolding,
} from '@/lib/etfEntryCheck'

export interface EtfHoldingsResult {
  holdings: readonly ProxyHolding[]
  /** 구성 기준일 (네이버가 밝힌 날짜, 폴백이면 손으로 적어둔 날짜) */
  asOf: string
  /** DB에서 왔는가. false면 코드에 적어둔 낡은 폴백이다 — 화면이 밝혀야 한다. */
  fromDb: boolean
  /** 이름을 티커로 못 이어 판정에서 빠진 종목 이름들. 조용히 버리지 않는다. */
  unresolved: string[]
  /** 자동 수집엔 있는데 실측 목록엔 없는 종목 = 리밸런싱 신호. 화면이 알린다. */
  staleNames: string[]
  /**
   * 어제까지 수집에 잡히던 종목이 오늘 안 잡힌 것 (파이프라인이 status='dropped'로
   * 남긴 행). **"ETF에서 빠졌다"고 단정하지 않는다** — 네이버는 주식 수 순 상위
   * 10개만 주므로 그대로 담고 있어도 11위로 밀리면 사라진다.
   * supabase/etf_holdings_status.sql을 안 돌렸으면 항상 빈 목록이다(메일 알림은 정상).
   */
  droppedNames: string[]
  /** 자동 수집이 마지막으로 구성을 확인한 날짜. null이면 아직 한 번도 안 돌았다. */
  autoCheckedAt: string | null
}

/**
 * 490590 구성종목·비중.
 *
 * **비중은 DB가 아니라 `FALLBACK_PROXY_HOLDINGS`(사용자 실측 15종목)를 쓴다** —
 * 이름과 달리 이게 지금 가장 정확한 기준이다. 자동 수집(`etf_holdings`)이 덮는 건
 * 64.31%뿐이라 그대로 쓰면 ETF의 4분의 1을 못 보고 신호등을 매기게 된다(2026-09-25
 * 확인: 네이버가 주는 상위 10개는 비중 순이 아니라 **주식 수 순**이라 주가가 비싼
 * AMD·MU·META·TSM·AVGO·MSFT가 통째로 빠진다).
 *
 * 그럼 DB는 왜 읽는가 — **구성이 바뀐 것을 알아채기 위해서다.** 그게 이 기능을 만든
 * 이유인 원래 문제였다("리밸런싱되면 아무도 모른다"). 64%만 덮어도 새 이름이 뜨거나
 * 사라지는 것은 잡히고, 실제로 인텔·오라클·버티브가 들어온 것을 네이버가 먼저
 * 알려줬다. 그래서 `staleNames`(DB엔 있는데 실측 목록엔 없는 종목)를 화면에 띄워
 * "실측값을 갱신할 때가 됐다"고 알린다.
 *
 * 전체 15종목을 한 번에 주는 자동 경로는 **아직 없다** — 네이버 3경로 404, KRX 3개
 * 400 LOGOUT, KIS `FHKST121600C0`는 작동하지만 **국내 상장 구성종목만** 준다
 * (490590은 485690 하나뿐. 비중 필드 `etf_cnfg_issu_rlim`은 존재하므로, 국내 주식을
 * 담는 ETF였다면 이 경로로 해결됐을 것이다). `pipeline/src/etf_pdf_probe.py` 참고.
 */
export async function getEtfHoldings(): Promise<EtfHoldingsResult> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const base: EtfHoldingsResult = {
    holdings: FALLBACK_PROXY_HOLDINGS,
    asOf: FALLBACK_PROXY_WEIGHTS_AS_OF,
    fromDb: false,
    unresolved: [],
    staleNames: [],
    droppedNames: [],
    autoCheckedAt: null,
  }

  try {
    const supabase = createServerSupabaseClient()
    // status는 나중에 더한 열이라(supabase/etf_holdings_status.sql) 아직 없을 수 있다.
    // 없으면 select가 통째로 실패하므로 한 번 더 시도한다 — 그래야 SQL을 안 돌린
    // 상태에서도 기존 리밸런싱 알람이 계속 돈다('빠짐' 알림만 빠진다).
    type HoldingRow = { ticker: string | null; name: string; as_of: string; status?: string }
    const query = (columns: string) =>
      supabase
        .from('etf_holdings')
        .select(columns)
        .eq('etf_ticker', ETF_TICKER)
        .order('seq', { ascending: true })

    let result = await query('ticker, name, as_of, status')
    if (result.error) result = await query('ticker, name, as_of')
    const { data, error } = result as { data: HoldingRow[] | null; error: unknown }

    // 표가 아직 없거나 비어 있는 것은 **정상 상태**다(첫 수집 전까지) — 예외로 화면을
    // 죽이지 않고, 알람만 없는 채로 실측 목록을 그대로 쓴다.
    if (error || !data || data.length === 0) return base

    // status='dropped'는 구성이 아니라 **경고**를 담은 행이다 — 보유 종목을 세는
    // 쪽에 섞이면 없는 종목을 세게 되므로 먼저 갈라낸다.
    const isDropped = (row: { status?: unknown }) => row.status === 'dropped'
    const held = data.filter((row) => !isDropped(row))
    const droppedNames = data
      .filter(isDropped)
      .map((row) => `${row.name as string} (${row.ticker as string})`)

    // 자동 수집이 본 종목 중 실측 목록에 없는 것 = 그 사이 리밸런싱됐다는 신호.
    const known = new Set(FALLBACK_PROXY_HOLDINGS.map((h) => h.ticker))
    const staleNames = held
      .filter((row) => row.ticker && !known.has(row.ticker as string))
      .map((row) => `${row.name as string} (${row.ticker as string})`)

    return {
      ...base,
      staleNames,
      droppedNames,
      autoCheckedAt: (held[0]?.as_of as string) ?? (data[0].as_of as string) ?? null,
    }
  } catch {
    return base
  }
}
