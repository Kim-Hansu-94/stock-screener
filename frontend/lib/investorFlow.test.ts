import { describe, expect, it } from 'vitest'
import { flowScale, formatKrwCompact, summarizeFlow } from './investorFlow'
import type { InvestorFlowRow } from './types'

function row(date: string, foreign: number | null, institution: number | null, close = 100): InvestorFlowRow {
  return {
    market: 'KR',
    ticker: '005930',
    name: '삼성전자',
    date,
    close,
    foreign_net_qty: foreign,
    institution_net_qty: institution,
    foreign_net_amount: foreign === null ? null : foreign * close,
    institution_net_amount: institution === null ? null : institution * close,
    source: '테스트',
  }
}

describe('summarizeFlow', () => {
  it('누적 수량·금액과 순매수 일수를 낸다', () => {
    const rows = [row('2026-09-08', 100, -50), row('2026-09-09', 200, -30), row('2026-09-10', -50, 10)]
    const f = summarizeFlow(rows, 'foreign')
    expect(f.netQty).toBe(250)
    expect(f.netAmount).toBe(25000)
    expect(f.buyDays).toBe(2)
    expect(f.days).toBe(3)
  })

  it('연속 일수는 최근 날부터 세고 방향이 바뀌면 멈춘다', () => {
    const rows = [row('2026-09-08', 100, 0), row('2026-09-09', -10, 0), row('2026-09-10', -20, 0)]
    expect(summarizeFlow(rows, 'foreign').streak).toBe(-2) // 최근 2일 연속 순매도
  })

  it('순매매가 0인 날은 연속을 끊는다', () => {
    // 거래가 없던 하루를 건너뛰고 이어 세면 "10일 연속 순매수" 같은 과장이 생긴다.
    const rows = [row('2026-09-08', 100, 0), row('2026-09-09', 0, 0), row('2026-09-10', 100, 0)]
    expect(summarizeFlow(rows, 'foreign').streak).toBe(1)
  })

  it('값이 없는 날은 분모에서 뺀다', () => {
    const rows = [row('2026-09-09', null, 5), row('2026-09-10', 10, 5)]
    const f = summarizeFlow(rows, 'foreign')
    expect(f.days).toBe(1)
    expect(f.netQty).toBe(10)
  })

  it('빈 목록이면 전부 0', () => {
    expect(summarizeFlow([], 'institution')).toEqual({
      netQty: 0, netAmount: 0, streak: 0, buyDays: 0, days: 0,
    })
  })
})

describe('flowScale', () => {
  it('양쪽 통틀어 가장 큰 절댓값', () => {
    expect(flowScale([row('2026-09-10', 100, -500)])).toBe(500)
  })
  it('값이 없으면 0', () => {
    expect(flowScale([row('2026-09-10', null, null)])).toBe(0)
  })
})

describe('formatKrwCompact', () => {
  it.each([
    [1_500_000_000_000, '1.5조'],
    [340_000_000_000, '3,400억'],
    [56_000_000, '5,600만'],
    [-340_000_000_000, '−3,400억'],
    [1234, '1,234'],
  ])('%s → %s', (input, expected) => {
    expect(formatKrwCompact(input)).toBe(expected)
  })
})

describe('summarizeFlow — 최소 형태 입력 (배지용 조회)', () => {
  it('필요한 열만 있는 행도 그대로 받는다', () => {
    // 요약 배지는 SELECT를 줄이려고 date + 외국인 두 열만 받아 온다.
    // 전체 행을 요구하면 안 쓰는 열까지 조회해야 한다.
    const rows = [
      { date: '2026-09-09', foreign_net_qty: 100, foreign_net_amount: 1000 },
      { date: '2026-09-10', foreign_net_qty: 50, foreign_net_amount: 500 },
    ]
    const f = summarizeFlow(rows, 'foreign')
    expect(f.netQty).toBe(150)
    expect(f.netAmount).toBe(1500)
    expect(f.streak).toBe(2)
    expect(f.days).toBe(2)
  })

  it('해당 열이 아예 없으면 그 날은 세지 않는다', () => {
    // 기관 열을 안 받아 온 응답으로 기관 요약을 부르면 0건이어야 한다 —
    // undefined를 0으로 읽어 "순매매 0인 날"로 세면 안 된다.
    const rows = [{ date: '2026-09-10', foreign_net_qty: 100 }]
    expect(summarizeFlow(rows, 'institution').days).toBe(0)
  })
})
