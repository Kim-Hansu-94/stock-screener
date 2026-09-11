import { describe, expect, it } from 'vitest'
import { buybackProgress, tradingDaysBetween, MIN_ESTIMATE_COVERAGE } from './buybackProgress'

function row(over: Record<string, unknown> = {}) {
  return {
    confirmed_progress_pct: null,
    confirmed_days: null,
    amount_progress_pct: null,
    estimated_progress_pct: null,
    period_progress_pct: null,
    period_start: null,
    observed_days: null,
    broker: null,
    ...over,
  } as Parameters<typeof buybackProgress>[0]
}

describe('tradingDaysBetween', () => {
  it('주말을 뺀다', () => {
    // 2026-09-07(월) ~ 2026-09-11(금) = 5거래일
    expect(tradingDaysBetween('2026-09-07', '2026-09-11')).toBe(5)
    // 토·일이 낀 2주 = 10거래일
    expect(tradingDaysBetween('2026-09-07', '2026-09-18')).toBe(10)
  })

  it('같은 날은 1거래일, 거꾸로면 0', () => {
    expect(tradingDaysBetween('2026-09-10', '2026-09-10')).toBe(1)
    expect(tradingDaysBetween('2026-09-10', '2026-09-01')).toBe(0)
  })
})

describe('buybackProgress', () => {
  it('거래소 체결내역이 있으면 다른 근거를 전부 제친다', () => {
    // KRX KIND가 일자별 체결수량을 공시하므로 진행 중에도 확정치를 쓸 수 있다.
    // 결과보고서(amount)를 기다릴 필요도, 창구로 추정할 필요도 없다.
    const r = buybackProgress(
      row({
        confirmed_progress_pct: 43,
        confirmed_days: 17,
        amount_progress_pct: 42,
        estimated_progress_pct: 90,
        period_progress_pct: 23,
      }),
      '2026-09-11',
    )
    expect(r.basis).toMatchObject({ pct: 43, kind: 'confirmed', measuresPurchase: true })
    expect(r.basis?.label).toContain('17일')
  })

  it('체결내역은 소급되므로 관측 커버리지를 따지지 않는다', () => {
    // 거래원(estimated)과 결정적으로 다른 점이다 — 취득 시작 직후 조회해도
    // 8/20부터의 전 구간이 한 번에 오므로 "하루만 봤다"는 상태가 없다.
    const r = buybackProgress(
      row({
        confirmed_progress_pct: 43,
        confirmed_days: 1,
        period_start: '2026-08-20',
        observed_days: 1,
      }),
      '2026-09-11',
    )
    expect(r.basis?.kind).toBe('confirmed')
    expect(r.estimateUnderObserved).toBe(false)
  })

  it('확정치가 있으면 무조건 그걸 쓴다', () => {
    const r = buybackProgress(
      row({ amount_progress_pct: 42, estimated_progress_pct: 90, period_progress_pct: 10 }),
      '2026-09-10',
    )
    expect(r.basis).toMatchObject({ pct: 42, kind: 'amount', measuresPurchase: true })
    expect(r.estimateUnderObserved).toBe(false)
  })

  it('관측이 모자란 추정치는 대표로 쓰지 않는다 (SK하이닉스 실사례)', () => {
    // 8/20 시작, 9/10 현재 = 16거래일인데 관측은 1일뿐.
    // 그대로 쓰면 "회사가 3%만 샀다"로 읽히지만 실제로는 "우리가 하루만 봤다"다.
    const r = buybackProgress(
      row({
        estimated_progress_pct: 2.9,
        period_progress_pct: 23,
        period_start: '2026-08-20',
        observed_days: 1,
        broker: 'SK증권',
      }),
      '2026-09-10',
    )
    // 기간 경과율은 **매입량을 재는 값이 아니다** — 화면이 이걸 진행률처럼 그리면
    // "23% 샀구나"로 읽힌다(2026-09-11 실제로 그렇게 읽혔다).
    expect(r.basis).toMatchObject({ kind: 'period', measuresPurchase: false })
    expect(r.basis?.label).not.toContain('진행률')
    expect(r.estimateUnderObserved).toBe(true)
    expect(r.coverage).toBeLessThan(MIN_ESTIMATE_COVERAGE)
  })

  it('충분히 관측하면 추정치를 대표로 쓴다', () => {
    const r = buybackProgress(
      row({
        estimated_progress_pct: 35,
        period_progress_pct: 40,
        period_start: '2026-09-01',
        observed_days: 8, // 9/1~9/10 = 8거래일 전부 관측
        broker: 'SK증권',
      }),
      '2026-09-10',
    )
    expect(r.basis).toMatchObject({ pct: 35, kind: 'estimated', measuresPurchase: true })
    expect(r.basis?.label).toContain('SK증권')
    expect(r.estimateUnderObserved).toBe(false)
  })

  it('취득 기간을 모르면 커버리지를 못 재므로 추정치를 그대로 쓴다', () => {
    // 기간이 없으면 "덜 관측했다"고 단정할 근거도 없다.
    const r = buybackProgress(
      row({ estimated_progress_pct: 12, observed_days: 3, period_start: null }),
      '2026-09-10',
    )
    expect(r.basis).toMatchObject({ pct: 12, kind: 'estimated' })
    expect(r.coverage).toBeNull()
  })

  it('아무 근거도 없으면 basis가 null', () => {
    const r = buybackProgress(row(), '2026-09-10')
    expect(r.basis).toBeNull()
    expect(r.estimateUnderObserved).toBe(false)
  })

  it('추정치가 아예 없으면 단서도 필요 없다', () => {
    const r = buybackProgress(
      row({ period_progress_pct: 50, period_start: '2026-08-20', observed_days: 0 }),
      '2026-09-10',
    )
    expect(r.basis).toMatchObject({ kind: 'period' })
    expect(r.estimateUnderObserved).toBe(false)
  })
})
