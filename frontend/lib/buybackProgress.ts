import type { BuybackRow } from '@/lib/types'

/**
 * 자사주 진행률을 **어느 근거로 보여줄지** 고르는 단 하나의 규칙.
 *
 * 배지(KrExtrasBadges)와 상세(MarketExtrasPanel)가 각자 고르면 같은 종목인데 다른
 * 숫자를 말하게 된다. 그래서 규칙을 여기 한 곳에 두고 양쪽이 이 함수를 쓴다.
 *
 * ## 왜 관측 일수를 따지는가 (2026-09-10 실사례)
 *
 * 창구 추정치는 `broker_trading`에 쌓인 날만 더한 값이다. 그런데 네이버는 그날 상위
 * 5개 창구만 주므로 **과거 소급이 안 된다** — 수집을 시작한 날부터 하루씩 쌓인다.
 *
 * SK하이닉스는 8월 20일에 40조원 취득을 시작했는데, 수집 첫날 관측한 SK증권 순매수는
 * 1.16조원이었다. 그대로 나누면 **2.9%**가 나온다. 하지만 그건 "회사가 3%만 샀다"가
 * 아니라 "우리가 하루만 봤다"는 뜻이다. 숫자만 보여주면 정반대로 읽힌다.
 *
 * 그래서 관측 커버리지(관측일 ÷ 경과 거래일)가 낮으면 추정치를 **대표 진행률로
 * 쓰지 않는다**. 대신 기간 기준으로 표시하고, 창구 관측치는 "N일 관측" 단서를 달아
 * 따로 보여준다.
 */

/** 이만큼은 관측해야 추정치를 대표 진행률로 쓴다. */
export const MIN_ESTIMATE_COVERAGE = 0.5

/**
 * 두 날짜 사이의 거래일 수(주말 제외 근사).
 *
 * 공휴일은 빼지 않는다 — 커버리지가 실제보다 **낮게** 나오는 쪽이라, 덜 익은
 * 추정치를 대표로 승격시키는 실수는 생기지 않는다(안전한 방향의 오차).
 */
export function tradingDaysBetween(startISO: string, endISO: string): number {
  const start = new Date(`${startISO}T00:00:00Z`)
  const end = new Date(`${endISO}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return 0

  let count = 0
  const cursor = new Date(start)
  while (cursor <= end) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) count += 1
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return count
}

export type BuybackBasis = {
  pct: number
  kind: 'amount' | 'estimated' | 'period'
  /** 화면에 붙일 근거 라벨 */
  label: string
  /**
   * 이 값이 **"회사가 얼마나 샀나"인가**. false면 달력이 얼마나 흘렀는지일 뿐이다.
   *
   * 이 구분이 없으면 화면이 둘을 같은 진행바로 그린다. 실제로 기간 경과 23%를
   * 보고 "자사주를 23% 샀구나"로 읽히는 일이 있었다(2026-09-11) — 퍼센트를
   * 진행률 자리에 놓는 순간 사람은 매입량으로 읽는다.
   */
  measuresPurchase: boolean
}

export type BuybackProgress = {
  /** 대표로 보여줄 진행률. 아무 근거도 없으면 null */
  basis: BuybackBasis | null
  /**
   * 창구 관측치를 **대표로 쓰기엔 관측이 모자란** 상태인지.
   * true면 화면이 "N일 관측" 단서를 반드시 같이 보여줘야 한다.
   */
  estimateUnderObserved: boolean
  /** 관측일 ÷ 경과 거래일. 기간을 모르면 null */
  coverage: number | null
}

type BuybackLike = Pick<
  BuybackRow,
  | 'amount_progress_pct'
  | 'estimated_progress_pct'
  | 'period_progress_pct'
  | 'period_start'
  | 'observed_days'
> & { broker?: string | null }

export function buybackProgress(row: BuybackLike, today: string): BuybackProgress {
  const elapsed = row.period_start ? tradingDaysBetween(row.period_start, today) : 0
  const observed = row.observed_days ?? 0
  const coverage = elapsed > 0 ? Math.min(observed / elapsed, 1) : null
  const estimateUsable =
    row.estimated_progress_pct != null && (coverage === null || coverage >= MIN_ESTIMATE_COVERAGE)

  if (row.amount_progress_pct != null) {
    return {
      basis: {
        pct: row.amount_progress_pct,
        kind: 'amount',
        label: '취득 금액 기준 (공시 확정)',
        measuresPurchase: true,
      },
      estimateUnderObserved: false,
      coverage,
    }
  }

  if (estimateUsable && row.estimated_progress_pct != null) {
    return {
      basis: {
        pct: row.estimated_progress_pct,
        kind: 'estimated',
        label: `${row.broker ?? '위탁 증권사'} 창구 순매수 기준 (추정)`,
        measuresPurchase: true,
      },
      estimateUnderObserved: false,
      coverage,
    }
  }

  return {
    basis:
      row.period_progress_pct != null
        ? {
            pct: row.period_progress_pct,
            kind: 'period',
            // "진행률"이라는 말 자체를 쓰지 않는다 — 이건 달력 이야기다.
            label: '취득 기간 경과 (매입량 아님)',
            measuresPurchase: false,
          }
        : null,
    // 추정치가 있는데 대표로 못 쓴 경우에만 단서가 필요하다.
    estimateUnderObserved: row.estimated_progress_pct != null && !estimateUsable,
    coverage,
  }
}
