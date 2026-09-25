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
}

/**
 * 490590 구성종목을 DB에서 읽는다 (`pipeline/src/etf_holdings.py`가 매일 저장).
 *
 * **수집 전이거나 조회가 실패하면 폴백을 쓴다** — 화면이 통째로 비는 것보다는 낫지만,
 * 폴백은 손으로 적어둔 낡은 값이라(2026-09-25 기준 10개 중 5개가 어긋나 있었다)
 * `fromDb: false`를 같이 돌려줘 화면이 그 사실을 밝히게 한다. 조용히 폴백을 쓰면
 * "자동으로 따라가고 있다"고 믿게 되는데, 그게 이 기능을 만든 이유인 사고 그 자체다.
 */
export async function getEtfHoldings(): Promise<EtfHoldingsResult> {
  'use cache'
  cacheLife('hours')
  cacheTag(SCREENER_CACHE_TAG)

  const fallback: EtfHoldingsResult = {
    holdings: FALLBACK_PROXY_HOLDINGS,
    asOf: FALLBACK_PROXY_WEIGHTS_AS_OF,
    fromDb: false,
    unresolved: [],
  }

  try {
    const supabase = createServerSupabaseClient()
    const { data, error } = await supabase
      .from('etf_holdings')
      .select('ticker, name, stock_count, weight_pct, as_of')
      .eq('etf_ticker', ETF_TICKER)
      .order('seq', { ascending: true })
    // 표가 아직 없거나(SQL 미실행) 비어 있는 것은 **정상 상태**다 — 첫 수집 전까지는
    // 그렇다. 예외로 화면을 죽이지 않고 폴백으로 내려간다.
    if (error || !data || data.length === 0) return fallback

    const holdings: ProxyHolding[] = []
    const unresolved: string[] = []
    for (const row of data) {
      // 비중을 못 낸 종목(일봉 없음)은 가중에 넣을 수 없다 — 0으로 깔면 "데이터가
      // 없다"와 "비중이 0이다"가 구분되지 않는다(supportSignals.ts와 같은 원칙).
      if (!row.ticker || row.weight_pct == null) {
        unresolved.push(row.name as string)
        continue
      }
      holdings.push({
        ticker: row.ticker as string,
        name: row.name as string,
        weight: Number(row.weight_pct),
      })
    }
    if (holdings.length === 0) return fallback

    return {
      holdings,
      asOf: (data[0].as_of as string) ?? FALLBACK_PROXY_WEIGHTS_AS_OF,
      fromDb: true,
      unresolved,
    }
  } catch {
    return fallback
  }
}
