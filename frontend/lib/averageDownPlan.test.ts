import { describe, expect, it } from 'vitest'
import {
  LADDER_DROPS,
  LADDER_WEIGHTS,
  buildAverageDownPlan,
  defaultScenarios,
  evaluateScenario,
  roundTrigger,
  type PlanInput,
} from './averageDownPlan'

/**
 * 실제 보유 상태. 숫자를 지어내지 않는다.
 *   평단·수량 — 2026-11-11 사용자 증권사 앱 캡처
 *   현재가 — `stock_price_history`의 2026-11-11 **종가** 1,280,000원
 *             (앱 화면의 1,290,000은 그날 고가다. 화면은 종가로 계산하므로 종가를 쓴다)
 */
const HYNIX: PlanInput = {
  avgCost: 2_032_230,
  shares: 13,
  price: 1_280_000,
  budget: 30_000_000,
  market: 'KR',
}

describe('사다리 상수', () => {
  it('예산 비중의 합이 정확히 1이다', () => {
    expect(LADDER_WEIGHTS.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it('아래로 갈수록 더 크게 산다 — 이게 뒤집히면 설계 의도가 깨진다', () => {
    for (let i = 1; i < LADDER_WEIGHTS.length; i += 1) {
      expect(LADDER_WEIGHTS[i]).toBeGreaterThan(LADDER_WEIGHTS[i - 1])
      expect(LADDER_DROPS[i]).toBeGreaterThan(LADDER_DROPS[i - 1])
    }
  })

  it('1차는 지금 가격에 집행한다 (안 빠지고 올라가면 예산이 통째로 논다)', () => {
    expect(LADDER_DROPS[0]).toBe(0)
  })

  it('측정된 중간값 -15%를 2·3차가 양옆에서 감싼다', () => {
    // backtestTurnSignals.ts 실측: 15% 이상 빠진 종목을 추가 매수하면
    // 60거래일 안에 중간값 -15%까지 더 빠진다(104,119건). 이 설계의 유일한 근거라
    // 사다리를 옮기면 여기서 걸리게 해 둔다.
    expect(LADDER_DROPS[1]).toBeLessThan(0.15)
    expect(LADDER_DROPS[2]).toBeGreaterThan(0.15)
  })
})

describe('roundTrigger', () => {
  it('사람이 조건주문에 넣을 수 있는 자리에서 끊는다', () => {
    expect(roundTrigger(1_148_100)).toBe(1_140_000)
    expect(roundTrigger(1_006_200)).toBe(1_000_000)
    expect(roundTrigger(844_800)).toBe(844_000)
    expect(roundTrigger(48_321)).toBe(48_300)
  })

  it('올림하지 않는다 — 계획보다 비싸게 사는 일이 없어야 한다', () => {
    for (const p of [1_148_100, 1_006_200, 844_800, 48_321, 999]) {
      expect(roundTrigger(p)).toBeLessThanOrEqual(p)
    }
  })

  it('말이 안 되는 값은 0', () => {
    expect(roundTrigger(0)).toBe(0)
    expect(roundTrigger(-5)).toBe(0)
    expect(roundTrigger(Number.NaN)).toBe(0)
  })
})

describe('buildAverageDownPlan — SK하이닉스 실제 보유 상태', () => {
  const plan = buildAverageDownPlan(HYNIX)!

  it('4차까지 나온다', () => {
    expect(plan.tranches.map((t) => t.step)).toEqual([1, 2, 3, 4])
  })

  it('집행 가격과 수량이 고정돼 있다', () => {
    expect(plan.tranches.map((t) => [t.triggerPrice, t.qty])).toEqual([
      [1_280_000, 4],
      [1_130_000, 5],
      [998_000, 7],
      [844_000, 13],
    ])
  })

  it('예산을 절대 넘기지 않는다', () => {
    const spent = plan.tranches.reduce((a, t) => a + t.cost, 0)
    expect(spent).toBeLessThanOrEqual(HYNIX.budget)
    expect(plan.unusedBudget).toBeGreaterThanOrEqual(0)
    expect(spent + plan.unusedBudget).toBe(HYNIX.budget)
  })

  it('차수를 거칠수록 평단이 내려간다', () => {
    let prev = HYNIX.avgCost
    for (const t of plan.tranches) {
      expect(t.avgCostAfter).toBeLessThan(prev)
      prev = t.avgCostAfter
    }
    expect(Math.round(plan.finalAvgCost)).toBe(1_313_024)
  })

  it('본전가는 평단보다 위다 — 매도비용(KR 0.165%)만큼', () => {
    for (const t of plan.tranches) {
      expect(t.breakevenAfter).toBeGreaterThan(t.avgCostAfter)
      expect(t.breakevenAfter / t.avgCostAfter).toBeCloseTo(1 / (1 - 0.00165), 6)
    }
  })

  it('지금 평단 위에서는 더 사지 않는다', () => {
    expect(plan.stopBuyingAbove).toBe(HYNIX.avgCost)
  })
})

describe('buildAverageDownPlan — 안 되는 입력', () => {
  it('보유가 없거나 예산이 0이면 계획이 없다', () => {
    expect(buildAverageDownPlan({ ...HYNIX, shares: 0 })).toBeNull()
    expect(buildAverageDownPlan({ ...HYNIX, budget: 0 })).toBeNull()
    expect(buildAverageDownPlan({ ...HYNIX, price: 0 })).toBeNull()
  })

  it('예산이 1주 값에도 못 미치면 계획이 없다 (0주짜리 차수를 만들지 않는다)', () => {
    expect(buildAverageDownPlan({ ...HYNIX, budget: 100_000 })).toBeNull()
  })

  it('예산이 애매하면 살 수 있는 차수만 돌려준다', () => {
    // 1차 비중 18%로는 1주도 못 사지만 4차 비중 37%로는 살 수 있는 금액.
    const plan = buildAverageDownPlan({ ...HYNIX, budget: 3_000_000 })
    expect(plan).not.toBeNull()
    expect(plan!.tranches.length).toBeLessThan(4)
    expect(plan!.tranches.every((t) => t.qty > 0)).toBe(true)
  })
})

describe('evaluateScenario', () => {
  const plan = buildAverageDownPlan(HYNIX)!

  it('최저가가 어디까지 갔느냐로 집행 차수가 정해진다', () => {
    expect(evaluateScenario(HYNIX, plan, '', 1_280_000, 1_280_000).executedSteps).toBe(1)
    expect(evaluateScenario(HYNIX, plan, '', 1_130_000, 1_280_000).executedSteps).toBe(2)
    expect(evaluateScenario(HYNIX, plan, '', 998_000, 1_280_000).executedSteps).toBe(3)
    // 807,000원은 지어낸 값이 아니라 이 종목의 **8개월 전 실제 저가**다
    // (position_signals_probe 실측: 구간 저가 807,000원, 2026-03-16~11-11 창).
    expect(evaluateScenario(HYNIX, plan, '', 807_000, 1_280_000).executedSteps).toBe(4)
  })

  it('**물타기는 손실률을 낮추지 손실액을 낮추지 않는다**', () => {
    // 이 계산기가 사람을 속이기 가장 쉬운 자리다. 떨어진 채로 끝나면 더 많은 돈을
    // 넣었으니 잃는 '금액'은 늘어난다 — 줄어드는 건 '비율'뿐이다. 화면이 둘을 같이
    // 보여줘야 하는 이유이고, 이 테스트가 그 사실을 박아 둔다.
    const o = evaluateScenario(HYNIX, plan, '', 1_088_000, 1_088_000)
    expect(o.planPnl).toBeLessThan(o.holdPnl) // 손실액은 더 크다
    expect(o.planPnlPct).toBeGreaterThan(o.holdPnlPct) // 손실률은 더 작다
  })

  it('떨어졌다 회복하면 계획이 크게 이긴다', () => {
    const o = evaluateScenario(HYNIX, plan, '', 807_000, HYNIX.avgCost)
    expect(o.planPnl).toBeGreaterThan(0)
    expect(o.holdPnl).toBeCloseTo(0, 0) // 평단으로 돌아왔을 뿐이니 본전
    expect(o.planPnl).toBeGreaterThan(o.allInPnl) // 나눠 산 쪽이 한 번에 산 쪽보다 낫다
  })

  it('안 빠지고 바로 오르면 한 번에 산 쪽이 낫다 — 공짜 점심이 아니다', () => {
    const o = evaluateScenario(HYNIX, plan, '', 1_280_000, 1_600_000)
    expect(o.executedSteps).toBe(1)
    expect(o.allInPnl).toBeGreaterThan(o.planPnl)
  })
})

describe('defaultScenarios', () => {
  const plan = buildAverageDownPlan(HYNIX)!
  // 807,000원은 position_signals_probe가 찍은 **실제 구간 저가**다(2026-03-16~11-11).
  const scenarios = defaultScenarios(HYNIX, plan, 807_000)

  it('네 개를 돌려주고 전부 손에 있는 값에서 나온다', () => {
    expect(scenarios).toHaveLength(4)
    expect(scenarios[0].label).toBe('여기서 15% 더 빠진 채로 끝')
    expect(scenarios.map((s) => s.lowPrice)).toEqual([1_088_000, 807_000, 807_000, 1_280_000])
    expect(scenarios.map((s) => s.endPrice)).toEqual([1_088_000, 1_280_000, 2_032_230, 2_032_230])
  })

  it('구간 저가가 현재가보다 높으면(=저가 정보가 쓸모없으면) 측정 중간값으로 대신한다', () => {
    const s = defaultScenarios(HYNIX, plan, 9_999_999)
    expect(s[1].lowPrice).toBe(1_088_000)
  })

  it('평단까지만 회복해도 계획 쪽은 플러스다 — 평단을 낮춰 놨으니까', () => {
    const recovered = scenarios[2]
    expect(recovered.planPnl).toBeGreaterThan(0)
    expect(recovered.holdPnl).toBeCloseTo(0, 0)
  })
})
