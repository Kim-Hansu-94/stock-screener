import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LADDER_STYLE,
  LADDERS,
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

describe('사다리 상수 — 네 모양 공통', () => {
  for (const style of ['dip', 'rebound', 'conviction', 'cycle'] as const) {
    it(`[${style}] 예산 비중의 합이 정확히 1이다`, () => {
      expect(LADDERS[style].reduce((a, b) => a + b.weight, 0)).toBeCloseTo(1, 10)
    })

    it(`[${style}] 1차는 지금 가격에 집행한다 (안 움직이면 예산이 통째로 논다)`, () => {
      expect(LADDERS[style][0].offset).toBe(0)
    })

    it(`[${style}] 차수가 4개다`, () => {
      expect(LADDERS[style]).toHaveLength(4)
    })
  }
})

describe('사다리 상수 — dip (측정 기반 기본값)', () => {
  it('아래로 갈수록 더 크게 산다 — 이게 뒤집히면 설계 의도가 깨진다', () => {
    const L = LADDERS.dip
    for (let i = 1; i < L.length; i += 1) {
      expect(L[i].weight).toBeGreaterThan(L[i - 1].weight)
      expect(L[i].offset).toBeLessThan(L[i - 1].offset)
    }
  })

  it('전부 현재가 아래에만 둔다', () => {
    expect(LADDERS.dip.every((d) => d.offset <= 0)).toBe(true)
  })

  it('측정된 중간값 -15%를 2·3차가 양옆에서 감싼다', () => {
    // backtestTurnSignals.ts 실측: 15% 이상 빠진 종목을 추가 매수하면
    // 60거래일 안에 중간값 -15%까지 더 빠진다(104,119건). 이 설계의 유일한 근거라
    // 사다리를 옮기면 여기서 걸리게 해 둔다.
    expect(Math.abs(LADDERS.dip[1].offset)).toBeLessThan(0.15)
    expect(Math.abs(LADDERS.dip[2].offset)).toBeGreaterThan(0.15)
  })
})

describe('사다리 상수 — rebound (사용자 판단: 바닥권 + 반등에 크게)', () => {
  it('예산의 **절반 이상**이 현재가 위에 있다 — 이게 이 모양의 전부다', () => {
    const above = LADDERS.rebound.filter((d) => d.offset > 0).reduce((a, b) => a + b.weight, 0)
    expect(above).toBeGreaterThan(0.5)
  })

  it('그래도 아래쪽 보험을 한 칸은 남긴다', () => {
    // 측정된 기본값(-15% 더 빠짐)을 통째로 무시하지는 않는다. 바닥권 판단이 틀렸을 때
    // 쓸 돈이 0이면 그건 계획이 아니라 베팅이다.
    const below = LADDERS.rebound.filter((d) => d.offset < 0)
    expect(below.length).toBeGreaterThanOrEqual(1)
    expect(below.reduce((a, b) => a + b.weight, 0)).toBeGreaterThanOrEqual(0.15)
  })

  it('위쪽은 갈수록 크게 산다 (반등이 확인될수록 많이)', () => {
    const up = LADDERS.rebound.filter((d) => d.offset > 0)
    for (let i = 1; i < up.length; i += 1) {
      expect(up[i].offset).toBeGreaterThan(up[i - 1].offset)
      expect(up[i].weight).toBeGreaterThan(up[i - 1].weight)
    }
  })

  it('지금 기본값이다 (사용자가 고른 모양)', () => {
    expect(DEFAULT_LADDER_STYLE).toBe('rebound')
  })
})

describe('사다리 상수 — conviction (바닥권 확신을 측정과 어긋나지 않게 실행)', () => {
  it('1차가 가장 크다 — "지금이 바닥"이라는 믿음을 금액으로 표현한 것', () => {
    const L = LADDERS.conviction
    expect(L[0].weight).toBe(Math.max(...L.map((d) => d.weight)))
    expect(L[0].weight).toBeGreaterThan(LADDERS.rebound[0].weight)
  })

  it('**현재가 위에는 한 칸도 두지 않는다**', () => {
    // 2026-11-12 측정: "저점 대비 X% 반등 + D일 저점 유지" 격자를 한국·미국
    // 32칸 전부 재서 하나도 기준선을 못 넘었고, X가 커질수록 나빠졌다.
    // 바닥권이라고 믿으면서 +8%·+23% 확인을 기다리는 건 전제와 앞뒤가 안 맞는다.
    expect(LADDERS.conviction.every((d) => d.offset <= 0)).toBe(true)
  })

  it('아래 간격이 측정된 추가 하락폭 분포를 덮는다', () => {
    // 국내 전체 중간값 -17.2%(25%분위 -30.1%) · 미국 IT -30.1%(25%분위 -45.3%).
    const offs = LADDERS.conviction.map((d) => Math.abs(d.offset))
    expect(Math.max(...offs)).toBeGreaterThanOrEqual(0.3)
  })

  it('dip보다 지금 많이 사고 rebound보다 평단을 많이 낮춘다 — 둘의 중간이 아니라 다른 선택이다', () => {
    const c = buildAverageDownPlan({ ...HYNIX, style: 'conviction' })!
    const d = buildAverageDownPlan({ ...HYNIX, style: 'dip' })!
    const r = buildAverageDownPlan({ ...HYNIX, style: 'rebound' })!
    expect(c.tranches[0].qty).toBeGreaterThan(d.tranches[0].qty)
    expect(c.finalAvgCost).toBeLessThan(r.finalAvgCost)
  })

  it('집행 가격·수량이 고정돼 있다', () => {
    const c = buildAverageDownPlan({ ...HYNIX, style: 'conviction' })!
    expect(c.tranches.map((t) => [t.triggerPrice, t.direction, t.qty])).toEqual([
      [1_280_000, 'now', 8],
      [1_120_000, 'dip', 6],
      [972_000, 'dip', 7],
      [819_000, 'dip', 7],
    ])
    expect(Math.round(c.finalAvgCost)).toBe(1_363_805)
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

describe('buildAverageDownPlan — SK하이닉스 실제 보유 상태 (rebound 기본값)', () => {
  const plan = buildAverageDownPlan(HYNIX)!

  it('4차까지 나온다', () => {
    expect(plan.tranches.map((t) => t.step)).toEqual([1, 2, 3, 4])
  })

  it('집행 가격·방향·수량이 고정돼 있다', () => {
    expect(plan.tranches.map((t) => [t.triggerPrice, t.direction, t.qty])).toEqual([
      [1_280_000, 'now', 5],
      [1_120_000, 'dip', 6],
      [1_380_000, 'rebound', 5],
      [1_570_000, 'rebound', 6],
    ])
  })

  it('예산을 절대 넘기지 않는다', () => {
    const spent = plan.tranches.reduce((a, t) => a + t.cost, 0)
    expect(spent).toBeLessThanOrEqual(HYNIX.budget)
    expect(plan.unusedBudget).toBeGreaterThanOrEqual(0)
    expect(spent + plan.unusedBudget).toBe(HYNIX.budget)
  })

  it('자투리를 다음 차수로 넘겨 **놀고 있는 돈이 예산의 3% 미만**이다', () => {
    // 넘기지 않으면 반등 사다리에서 3,060,000원(10.2%)이 놀았다 — 비싼 가격에 사는
    // 칸이 많아 내림 손실이 크기 때문이다. 이 테스트가 그 회귀를 막는다.
    expect(plan.unusedBudget / HYNIX.budget).toBeLessThan(0.03)
  })

  it('차수를 거칠수록 평단이 내려간다 — 위쪽 차수도 평단보다는 싸기 때문', () => {
    let prev = HYNIX.avgCost
    for (const t of plan.tranches) {
      expect(t.avgCostAfter).toBeLessThan(prev)
      prev = t.avgCostAfter
    }
    expect(Math.round(plan.finalAvgCost)).toBe(1_595_971)
  })

  it('**dip 사다리보다 평단을 덜 낮춘다 — 이게 이 선택의 대가다**', () => {
    // 반등 사다리는 비싼 가격에 더 많이 사므로 평단이 덜 내려간다. 대신 반등이
    // 진짜일 때 주식 수가 많다. 어느 쪽이 "좋다"가 아니라 무엇에 거느냐의 문제이고,
    // 화면이 이 차이를 반드시 보여줘야 한다.
    const dip = buildAverageDownPlan({ ...HYNIX, style: 'dip' })!
    expect(plan.finalAvgCost).toBeGreaterThan(dip.finalAvgCost)
    expect(plan.finalQty).toBeLessThan(dip.finalQty)
  })

  it('본전가는 평단보다 위다 — 매도비용(KR 0.165%)만큼', () => {
    for (const t of plan.tranches) {
      expect(t.breakevenAfter).toBeGreaterThan(t.avgCostAfter)
      expect(t.breakevenAfter / t.avgCostAfter).toBeCloseTo(1 / (1 - 0.00165), 6)
    }
  })

  it('지금 평단 위에서는 더 사지 않는다', () => {
    expect(plan.stopBuyingAbove).toBe(HYNIX.avgCost)
    expect(plan.tranches.every((t) => t.triggerPrice < HYNIX.avgCost)).toBe(true)
  })

  it('**평단을 넘는 위쪽 차수는 아예 만들지 않는다**', () => {
    // 반등 사다리는 가격을 쫓아 올라가므로 평단을 넘길 수 있다. 그 가격에 사면
    // 평단이 올라가 이 계산기의 목적과 정반대가 된다. 평단을 지금 가격 바로 위로
    // 낮춰 두면 위쪽 차수가 전부 빠져야 한다.
    const tight = buildAverageDownPlan({ ...HYNIX, avgCost: 1_300_000 })!
    expect(tight.tranches.every((t) => t.direction !== 'rebound')).toBe(true)
    // 건너뛴 몫은 조용히 사라지지 않고 '못 쓴 돈'으로 드러난다.
    expect(tight.unusedBudget).toBeGreaterThan(0)
  })
})

describe('buildAverageDownPlan — dip 사다리 (측정 기반)', () => {
  const plan = buildAverageDownPlan({ ...HYNIX, style: 'dip' })!

  it('전부 아래쪽이고 가격·수량이 고정돼 있다', () => {
    expect(plan.tranches.map((t) => [t.triggerPrice, t.direction, t.qty])).toEqual([
      [1_280_000, 'now', 4],
      [1_130_000, 'dip', 5],
      [998_000, 'dip', 8],
      [844_000, 'dip', 13],
    ])
    expect(Math.round(plan.finalAvgCost)).toBe(1_305_697)
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
    // 차수 하나 몫으로는 1주도 못 사지만, 자투리를 모으면 살 수 있는 금액.
    const plan = buildAverageDownPlan({ ...HYNIX, budget: 3_000_000 })
    expect(plan).not.toBeNull()
    expect(plan!.tranches.length).toBeLessThan(4)
    expect(plan!.tranches.every((t) => t.qty > 0)).toBe(true)
  })
})

describe('evaluateScenario — 양방향 사다리', () => {
  const plan = buildAverageDownPlan(HYNIX)! // rebound: now / -12% / +8% / +23%

  it('아래쪽 차수는 최저가로, 위쪽 차수는 최고가로 걸린다', () => {
    const E = (lo: number, hi: number) => evaluateScenario(HYNIX, plan, '', lo, hi, hi).executedSteps
    expect(E(1_280_000, 1_280_000)).toBe(1) // 1차만
    expect(E(1_120_000, 1_280_000)).toBe(2) // + 아래 한 칸
    expect(E(1_280_000, 1_380_000)).toBe(2) // + 위 한 칸 (아래는 안 걸림)
    expect(E(1_280_000, 1_570_000)).toBe(3) // + 위 두 칸
    // 807,000원은 지어낸 값이 아니라 이 종목의 **8개월 전 실제 저가**다
    // (position_signals_probe 실측: 구간 저가 807,000원, 2026-03-16~11-11 창).
    expect(E(807_000, 1_570_000)).toBe(4) // 아래로 갔다가 위까지 — 전부
  })

  it('**물타기는 손실률을 낮추지 손실액을 낮추지 않는다**', () => {
    // 이 계산기가 사람을 속이기 가장 쉬운 자리다. 떨어진 채로 끝나면 더 많은 돈을
    // 넣었으니 잃는 '금액'은 늘어난다 — 줄어드는 건 '비율'뿐이다. 화면이 둘을 같이
    // 보여줘야 하는 이유이고, 이 테스트가 그 사실을 박아 둔다.
    const o = evaluateScenario(HYNIX, plan, '', 1_088_000, 1_280_000, 1_088_000)
    expect(o.planPnl).toBeLessThan(o.holdPnl) // 손실액은 더 크다
    expect(o.planPnlPct).toBeGreaterThan(o.holdPnlPct) // 손실률은 더 작다
  })

  it('반등이 진짜면 반등 사다리가 하락 사다리보다 주식이 많다 — 이걸 노린 설계다', () => {
    const dip = buildAverageDownPlan({ ...HYNIX, style: 'dip' })!
    // 안 빠지고 평단까지 쭉 오른 경우: dip은 1차밖에 못 사고 rebound는 세 칸을 산다.
    const r = evaluateScenario(HYNIX, plan, '', 1_280_000, HYNIX.avgCost, HYNIX.avgCost)
    const d = evaluateScenario({ ...HYNIX, style: 'dip' }, dip, '', 1_280_000, HYNIX.avgCost, HYNIX.avgCost)
    expect(r.executedSteps).toBeGreaterThan(d.executedSteps)
    expect(r.planPnl).toBeGreaterThan(d.planPnl)
  })

  it('반대로 그냥 빠지기만 하면 하락 사다리가 낫다 — 공짜 점심이 아니다', () => {
    const dip = buildAverageDownPlan({ ...HYNIX, style: 'dip' })!
    // 807,000까지 빠졌다가 지금 가격으로 돌아온 경우.
    const r = evaluateScenario(HYNIX, plan, '', 807_000, 1_280_000, 1_280_000)
    const d = evaluateScenario({ ...HYNIX, style: 'dip' }, dip, '', 807_000, 1_280_000, 1_280_000)
    expect(d.planPnl).toBeGreaterThan(r.planPnl)
  })
})

describe('defaultScenarios', () => {
  const plan = buildAverageDownPlan(HYNIX)!
  // 807,000원은 position_signals_probe가 찍은 **실제 구간 저가**다(2026-03-16~11-11).
  const scenarios = defaultScenarios(HYNIX, plan, 807_000)

  it('다섯 개를 돌려주고 전부 손에 있는 값에서 나온다', () => {
    expect(scenarios).toHaveLength(5)
    expect(scenarios[0].label).toBe('여기서 15% 더 빠진 채로 끝')
    expect(scenarios.map((s) => s.lowPrice)).toEqual([
      1_088_000, 807_000, 807_000, 1_280_000, 1_280_000,
    ])
    expect(scenarios.map((s) => s.endPrice)).toEqual([
      1_088_000, 1_280_000, 2_032_230, 2_032_230, 1_570_000,
    ])
  })

  it('마지막 시나리오의 기준점은 **사다리 자신의 맨 위 차수**다 (지어낸 가격이 아니다)', () => {
    const top = Math.max(...plan.tranches.filter((t) => t.direction === 'rebound').map((t) => t.triggerPrice))
    expect(scenarios[4].endPrice).toBe(top)
    expect(scenarios[4].highPrice).toBe(top)
  })

  it('구간 저가가 현재가보다 높으면(=저가 정보가 쓸모없으면) 측정 중간값으로 대신한다', () => {
    const s = defaultScenarios(HYNIX, plan, 9_999_999)
    expect(s[1].lowPrice).toBe(1_088_000)
  })

  it('평단까지 회복하면 계획 쪽은 플러스다 — 평단을 낮춰 놨으니까', () => {
    const recovered = scenarios[2]
    expect(recovered.planPnl).toBeGreaterThan(0)
    expect(recovered.holdPnl).toBeCloseTo(0, 0)
  })
})


describe("사다리 상수 — cycle (지금 깊이에서 직접 잰 분포)", () => {
  it('간격이 실측 분위수 그대로다 (-9 / -20 / -33%)', () => {
    // pipeline/research/semi_cycle_probe.py · 국내 반도체 20종목 10년,
    // 이미 -45~-60% 빠져 있던 85개월의 그 뒤 24개월 추가 하락폭:
    //   중간값 -9.2% · 25%분위 -19.7% · 10%분위 -32.6% · 최악 -41.8%
    // 임의로 고른 값이 아니라 분포에서 읽어온 값이라, 바꾸려면 측정을 다시 해야 한다.
    expect(LADDERS.cycle.map((d) => d.offset)).toEqual([0, -0.09, -0.2, -0.33])
  })

  it('1차가 가장 크다 — 중간값이 -9%뿐이라 아래에서 기다릴 이유가 약하다', () => {
    expect(LADDERS.cycle[0].weight).toBe(0.4)
    expect(LADDERS.cycle[0].weight).toBe(Math.max(...LADDERS.cycle.map((d) => d.weight)))
  })

  it('아래로 갈수록 비중이 줄어든다 — dip과 정반대 모양이다', () => {
    const w = LADDERS.cycle.map((d) => d.weight)
    for (let i = 1; i < w.length; i += 1) expect(w[i]).toBeLessThan(w[i - 1])
    const dw = LADDERS.dip.map((d) => d.weight)
    for (let i = 1; i < dw.length; i += 1) expect(dw[i]).toBeGreaterThan(dw[i - 1])
  })

  it('현재가 위에는 두지 않는다', () => {
    expect(LADDERS.cycle.every((d) => d.offset <= 0)).toBe(true)
  })

  it('SK하이닉스 실제 보유 상태에서의 집행 가격·수량이 고정돼 있다', () => {
    const c = buildAverageDownPlan({ ...HYNIX, style: 'cycle' })!
    expect(c.tranches.map((t) => [t.triggerPrice, t.qty])).toEqual([
      [1_280_000, 9],
      [1_160_000, 6],
      [1_020_000, 6],
      [857_000, 6],
    ])
    expect(Math.round(c.finalAvgCost)).toBe(1_404_025)
  })
})
