import { describe, expect, it } from 'vitest'
import type { PriceBar } from './risk'
import {
  MAX_HOLD_BARS,
  type TradeInput,
  resolveTrade,
  segmentBy,
  summarize,
  verdictOf,
} from './scorecard'

function bars(specs: Array<{ high: number; low: number; close: number }>): PriceBar[] {
  return specs.map((s, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, ...s }))
}

/** 진입 100, 손절 90(=1R은 10), 목표 120(=2R). */
function trade(futureBars: PriceBar[]): TradeInput {
  return {
    date: '2026-01-01', market: 'KR', ticker: '005930', name: 'Samsung',
    sector: 'Semiconductors', entry: 100, stop: 90, target: 120,
    futureBars, regime: 'bull',
  }
}

const flat = (n: number) => bars(Array.from({ length: n }, () => ({ high: 105, low: 95, close: 100 })))

describe('resolveTrade', () => {
  it('목표에 닿으면 목표 배수만큼 R을 얻는다', () => {
    const r = resolveTrade(trade(bars([{ high: 110, low: 99, close: 108 }, { high: 125, low: 118, close: 124 }])))
    expect(r.outcome).toBe('target')
    expect(r.r).toBe(2)
    expect(r.holdingDays).toBe(2)
  })

  it('손절에 닿으면 정확히 -1R이다', () => {
    const r = resolveTrade(trade(bars([{ high: 102, low: 88, close: 89 }])))
    expect(r.outcome).toBe('stop')
    expect(r.r).toBe(-1)
  })

  it('한 봉에서 목표와 손절을 다 건드리면 손절로 본다', () => {
    // 일봉만으로는 장중 순서를 알 수 없으므로 불리한 쪽을 택해 성적을 부풀리지 않는다
    const r = resolveTrade(trade(bars([{ high: 125, low: 85, close: 100 }])))
    expect(r.outcome).toBe('stop')
    expect(r.r).toBe(-1)
  })

  it('기간을 다 채우고도 결론이 없으면 그 시점 종가로 청산한다', () => {
    const b = flat(MAX_HOLD_BARS)
    b[MAX_HOLD_BARS - 1] = { date: 'x', high: 112, low: 108, close: 110 }
    const r = resolveTrade(trade(b))
    expect(r.outcome).toBe('timeout')
    expect(r.r).toBe(1) // (110-100)/10
    expect(r.holdingDays).toBe(MAX_HOLD_BARS)
  })

  it('아직 기간이 안 찼으면 pending이라 집계에 안 들어간다', () => {
    // 결과를 모르는 트레이드를 0으로 세는 것도 편향이다
    const r = resolveTrade(trade(flat(MAX_HOLD_BARS - 1)))
    expect(r.outcome).toBe('pending')
    expect(r.r).toBeNull()
  })

  it('기간을 넘긴 봉은 판정에 쓰지 않는다', () => {
    // MAX_HOLD_BARS 이후에 목표에 닿아도 그건 이미 청산된 뒤의 일이다
    const b = [...flat(MAX_HOLD_BARS), { date: 'late', high: 130, low: 120, close: 128 }]
    expect(resolveTrade(trade(b)).outcome).toBe('timeout')
  })
})

describe('summarize', () => {
  it('pending은 분모에서 빠진다', () => {
    const card = summarize([
      resolveTrade(trade(bars([{ high: 125, low: 118, close: 124 }]))), // target
      resolveTrade(trade(flat(3))),                                     // pending
    ])
    expect(card.resolved).toBe(1)
    expect(card.pending).toBe(1)
    expect(card.hitRate).toBe(1)
  })

  it('2R 목표의 손익분기 도달률은 1/3이다', () => {
    // 손절 1칸 · 목표 2칸이면 실력이 없어도 손절이 2배 자주 걸린다.
    // 즉 도달률 33%가 본전선이고, 손절률 67%는 실패가 아니다.
    const card = summarize([
      resolveTrade(trade(bars([{ high: 125, low: 118, close: 124 }]))),
      resolveTrade(trade(bars([{ high: 102, low: 88, close: 89 }]))),
      resolveTrade(trade(bars([{ high: 102, low: 88, close: 89 }]))),
    ])
    expect(card.breakevenHitRate).toBeCloseTo(1 / 3, 5)
    expect(card.hitRate).toBeCloseTo(1 / 3, 5)
    // 도달률이 정확히 본전선이면 기댓값도 0이어야 한다
    expect(card.expectancyR).toBeCloseTo(0, 5)
  })

  it('표본이 없으면 0으로 채운 카드를 준다', () => {
    expect(summarize([]).resolved).toBe(0)
  })
})

describe('segmentBy', () => {
  it('표본이 적은 구간은 착시라 잘라낸다', () => {
    const win = () => resolveTrade({ ...trade(bars([{ high: 125, low: 118, close: 124 }])), sector: 'Big' })
    const lone = resolveTrade({ ...trade(bars([{ high: 125, low: 118, close: 124 }])), sector: 'Tiny' })
    const segs = segmentBy([...Array.from({ length: 5 }, win), lone], (t) => t.sector)
    expect(segs.map((s) => s.key)).toEqual(['Big'])
  })

  it('기댓값이 높은 구간이 먼저 온다', () => {
    const win = () => resolveTrade({ ...trade(bars([{ high: 125, low: 118, close: 124 }])), sector: 'Good' })
    const lose = () => resolveTrade({ ...trade(bars([{ high: 102, low: 88, close: 89 }])), sector: 'Bad' })
    const segs = segmentBy([...Array.from({ length: 5 }, lose), ...Array.from({ length: 5 }, win)], (t) => t.sector)
    expect(segs.map((s) => s.key)).toEqual(['Good', 'Bad'])
  })
})

describe('verdictOf', () => {
  it('표본이 20건 미만이면 숫자가 좋아도 단정하지 않는다', () => {
    expect(verdictOf({ ...summarize([]), resolved: 19, expectancyR: 5 })).toBe('insufficient')
  })

  it('기댓값 부호와 크기로 등급이 갈린다', () => {
    const base = { ...summarize([]), resolved: 30 }
    expect(verdictOf({ ...base, expectancyR: -0.1 })).toBe('negative')
    expect(verdictOf({ ...base, expectancyR: 0 })).toBe('negative')
    expect(verdictOf({ ...base, expectancyR: 0.1 })).toBe('marginal')
    expect(verdictOf({ ...base, expectancyR: 0.5 })).toBe('positive')
  })
})
