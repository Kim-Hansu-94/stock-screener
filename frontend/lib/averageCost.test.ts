import { describe, expect, it } from 'vitest'
import { computeAverageCost, simulateAddBuy, DEFAULT_SELL_COST_PCT } from './averageCost'

describe('computeAverageCost', () => {
  it('차수별 매수를 수량 가중 평균으로 합친다', () => {
    // 10,000원 10주 + 8,000원 10주 → 평단 9,000원
    const r = computeAverageCost([{ price: 10000, qty: 10 }, { price: 8000, qty: 10 }], 9500)
    expect(r?.totalQty).toBe(20)
    expect(r?.totalCost).toBe(180000)
    expect(r?.avgCost).toBe(9000)
    expect(r?.marketValue).toBe(190000)
    expect(r?.grossPnl).toBe(10000)
    expect(r?.grossPnlPct).toBeCloseTo(5.5556, 3)
  })

  it('수량이 다르면 많이 산 쪽으로 평단이 끌린다 (단순 평균이 아니다)', () => {
    const r = computeAverageCost([{ price: 10000, qty: 1 }, { price: 5000, qty: 9 }], 5000)
    expect(r?.avgCost).toBe(5500) // 단순 평균 7,500이 아니다
  })

  it('빈 행·잘못된 값은 무시하고, 유효한 행이 없으면 null', () => {
    const r = computeAverageCost(
      [{ price: 0, qty: 10 }, { price: 1000, qty: 0 }, { price: 1000, qty: 5 }],
      1000,
    )
    expect(r?.totalQty).toBe(5)
    expect(computeAverageCost([{ price: Number.NaN, qty: 1 }], 100)).toBeNull()
    expect(computeAverageCost([], 100)).toBeNull()
  })

  it('매도 비용을 평가손익에서 차감한다', () => {
    const r = computeAverageCost([{ price: 1000, qty: 100 }], 1100, DEFAULT_SELL_COST_PCT.KR)
    expect(r?.grossPnl).toBe(10000)
    expect(r?.sellCost).toBeCloseTo(110000 * 0.00165, 6) // 181.5원
    expect(r?.netPnl).toBeCloseTo(10000 - 181.5, 6)
    expect(r?.netPnlPct).toBeLessThan(r!.grossPnlPct)
  })

  it('본전 가격은 비용만큼 평단가보다 높다', () => {
    const r = computeAverageCost([{ price: 1000, qty: 10 }], 1000, DEFAULT_SELL_COST_PCT.KR)
    expect(r?.breakevenPrice).toBeGreaterThan(1000)
    // 그 가격에 팔면 비용을 빼고 정확히 본전이 된다
    const be = r!.breakevenPrice
    expect(be * 10 * (1 - 0.00165)).toBeCloseTo(10000, 2)
    expect(r?.breakevenUpsidePct).toBeCloseTo(0.1653, 3)
  })

  it('비용이 0이면 본전 가격은 평단가와 같다', () => {
    const r = computeAverageCost([{ price: 1000, qty: 10 }], 900, 0)
    expect(r?.breakevenPrice).toBe(1000)
    expect(r?.breakevenUpsidePct).toBeCloseTo(11.1111, 3) // 900 → 1000
  })

  it('현재가가 없으면 평단만 내고 평가금액은 0으로 둔다', () => {
    const r = computeAverageCost([{ price: 1000, qty: 10 }], 0)
    expect(r?.avgCost).toBe(1000)
    expect(r?.marketValue).toBe(0)
    expect(r?.breakevenUpsidePct).toBe(0)
  })
})

describe('simulateAddBuy', () => {
  it('추가 매수 후 평단과 하락률을 낸다', () => {
    // 평단 10,000원 10주 보유 + 8,000원 10주 추가 → 9,000원
    const s = simulateAddBuy([{ price: 10000, qty: 10 }], 8000, 10)
    expect(s?.newAvgCost).toBe(9000)
    expect(s?.newTotalQty).toBe(20)
    expect(s?.avgCostChangePct).toBe(-10)
    expect(s?.addCost).toBe(80000)
  })

  it('현재가가 평단보다 높으면 평단이 올라간다(불타기)', () => {
    const s = simulateAddBuy([{ price: 10000, qty: 10 }], 12000, 10)
    expect(s?.newAvgCost).toBe(11000)
    expect(s?.avgCostChangePct).toBe(10)
  })

  it('수량이나 가격이 없으면 null', () => {
    expect(simulateAddBuy([{ price: 10000, qty: 10 }], 8000, 0)).toBeNull()
    expect(simulateAddBuy([], 8000, 10)).toBeNull()
  })
})
