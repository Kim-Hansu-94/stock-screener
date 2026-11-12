import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LADDER_STYLE,
  CYCLE_TIMELINE,
  LADDERS,
  LADDER_INFO,
  LADDER_ORDER,
  MEDIAN_FURTHER_DROP,
  addMonths,
  buildActionPlan,
  monthsSince,
  buildAverageDownPlan,
  defaultScenarios,
  evaluateScenario,
  roundTrigger,
  troughStatus,
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

describe('사다리 상수 — 모든 모양 공통', () => {
  for (const style of ['dip', 'rebound', 'conviction', 'cycle', 'basing'] as const) {
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


describe('사다리 상수 — basing (바닥은 이미 지났다고 칠 때)', () => {
  it('간격·비중이 되돌려 재서 1등이었던 모양 그대로다 (0/-9/-18/-30, 50/25/15/10)', () => {
    // semi_cycle_probe.py 5부 — 4부가 고른 표본(= 바닥이 맞았던 경우)에 사다리를
    // 그대로 돌린 결과. 24개월 +51.6%로 '지금 다 사기'(+50.3%)보다 높았고,
    // 나쁜 25%도 -0.8%로 '지금 다 사기'(-9.9%)보다 나았다.
    expect(LADDERS.basing.map((d) => d.offset)).toEqual([0, -0.09, -0.18, -0.3])
    expect(LADDERS.basing.map((d) => d.weight)).toEqual([0.5, 0.25, 0.15, 0.1])
  })

  it('현재가 위에는 두지 않는다 — "바닥 지났다"의 올바른 실행은 지금 사는 것이다', () => {
    expect(LADDERS.basing.every((d) => d.offset <= 0)).toBe(true)
  })

  it('**1차가 절반이지만 전부는 아니다** — 분할이 사는 것은 중간값이 아니라 나쁜 25%다', () => {
    // 1.0으로 올리면 '지금 다 사기'가 되고, 그쪽은 24개월 25%분위가 -9.9%였다.
    expect(LADDERS.basing[0].weight).toBe(0.5)
    expect(LADDERS.basing[0].weight).toBeLessThan(1)
  })

  it('아래로 갈수록 비중이 줄어든다 — dip과 정반대 모양이다', () => {
    const w = LADDERS.basing.map((d) => d.weight)
    for (let i = 1; i < w.length; i += 1) expect(w[i]).toBeLessThan(w[i - 1])
  })

  it('**꼬리가 다섯 중 가장 얕다** — 깊은 꼬리가 손해였다는 것이 이 모양의 요점이다', () => {
    const last = (s: keyof typeof LADDERS) => LADDERS[s][LADDERS[s].length - 1].offset
    for (const other of ['dip', 'conviction', 'cycle'] as const) {
      expect(last('basing')).toBeGreaterThan(last(other))
    }
  })

  it('예산이 거의 놀지 않는다 (1% 미만) — 깊은 사다리를 버린 이유가 이것이다', () => {
    const b = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    expect(b.unusedBudget / HYNIX.budget).toBeLessThan(0.01)
  })

  it('SK하이닉스 실제 보유 상태에서의 집행 가격·수량이 고정돼 있다', () => {
    const b = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    expect(b.tranches.map((t) => [t.triggerPrice, t.qty])).toEqual([
      [1_280_000, 11],
      [1_160_000, 7],
      [1_040_000, 4],
      [896_000, 4],
    ])
    expect(Math.round(b.finalAvgCost)).toBe(1_445_205)
  })

  it('**4차가 8개월 전 바닥보다 위다** — 그 아래는 포기했다는 것을 박아 둔다', () => {
    // 바닥 재이탈 18%는 받지 않기로 했다. 그 칸을 두는 비용(노는 돈)이 효용보다
    // 컸다는 것이 5부의 결론이고, 전제를 믿지 않으면 cycle·dip을 고르면 된다.
    const b = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    expect(b.tranches[3].triggerPrice).toBeGreaterThan(807_000)
    expect(buildAverageDownPlan({ ...HYNIX, style: 'cycle' })!.tranches[3].triggerPrice).toBeLessThan(
      807_000 + 60_000,
    )
  })

  it('중간값(-15%)만큼 눌리면 1·2차가 걸리고 3차는 안 걸린다', () => {
    // 분위수에 차수를 "딱" 걸면 안 되는 이유를 고정해 둔다 — 2차를 -15%에 두면
    // 여기서 1이 나온다(실측: 8,000원 차이로 미체결). -9%라 여유 있게 걸린다.
    const b = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const medianDown = Math.round(HYNIX.price * (1 - MEDIAN_FURTHER_DROP))
    const o = evaluateScenario(HYNIX, b, '', medianDown, HYNIX.price, medianDown)
    expect(o.executedSteps).toBe(2)
  })
})

describe('LADDER_INFO — 모양별 설명', () => {
  it('모든 사다리가 자기 설명을 가진다 (새 모양을 추가하면 여기서 걸린다)', () => {
    for (const style of Object.keys(LADDERS) as (keyof typeof LADDERS)[]) {
      const i = LADDER_INFO[style]
      expect(i.label.length).toBeGreaterThan(1)
      expect(i.gist.length).toBeGreaterThan(10)
      expect(i.headline.length).toBeGreaterThan(10)
      expect(i.body.length).toBeGreaterThan(30)
    }
  })

  it('**모양마다 문구가 다르다** — 같은 설명을 돌려 쓰면 화면이 조용히 거짓말한다', () => {
    // 실제로 cycle·basing을 추가한 뒤 화면이 둘 다 dip의 근거를 적고 있었다.
    for (const key of ['label', 'gist', 'headline'] as const) {
      const all = Object.values(LADDER_INFO).map((i) => i[key])
      expect(new Set(all).size).toBe(all.length)
    }
  })

  it('마크다운 별표가 남아 있지 않다 — 평문으로 렌더된다', () => {
    for (const i of Object.values(LADDER_INFO)) {
      expect(i.label + i.gist + i.headline + i.body).not.toContain('**')
    }
  })

  it('basing의 근거가 모양을 정한 측정값을 그대로 인용한다', () => {
    // 되돌려 돌린 결과(5부)에서 이 모양이 나왔으므로, 그 세 숫자가 문구에 있어야 한다.
    // 하나라도 빠지면 "왜 이 모양인가"가 화면에서 사라진다.
    const t = LADDER_INFO.basing.headline + LADDER_INFO.basing.body
    expect(t).toContain('+51.6%') // 이 모양의 24개월 중간값
    expect(t).toContain('+50.3%') // 한 번에 다 사기 — 그보다 높았다
    expect(t).toContain('−9.9%') // 한 번에 다 사기의 나쁜 25% — 나눠 사는 이유
  })

  it('판단에서 나온 모양은 rebound 하나뿐이고, 그렇게 표시된다', () => {
    const judged = LADDER_ORDER.filter((s) => LADDER_INFO[s].basis === 'judgement')
    expect(judged).toEqual(['rebound'])
  })

  it('LADDER_ORDER가 모든 모양을 정확히 한 번씩 담는다', () => {
    expect([...LADDER_ORDER].sort()).toEqual(Object.keys(LADDERS).sort())
  })
})

describe('CYCLE_TIMELINE — 시간축 측정 (semi_cycle_probe 6부)', () => {
  it('측정값이 그대로 들어 있다', () => {
    // 국내 반도체 55건 · 미국 30건, 바닥을 0개월로 맞춰 포갠 결과.
    expect(CYCLE_TIMELINE.monthsAfterTrough).toBe(8)
    expect(CYCLE_TIMELINE.dipMonthsAhead).toBe(3)
    expect(CYCLE_TIMELINE.dipRangeAhead).toEqual([1, 5])
    expect(CYCLE_TIMELINE.dipProbabilityPct).toBe(64)
    expect(CYCLE_TIMELINE.dipDepthPct).toBeCloseTo(-16.1, 5)
  })

  it('**미룰수록 나빠진다 — 이게 뒤집히면 시한의 근거가 사라진다**', () => {
    // 이 단조성이 "기다리는 것 자체가 비용"의 유일한 근거다.
    const kr = CYCLE_TIMELINE.entryByMonth.map((r) => r.kr)
    const us = CYCLE_TIMELINE.entryByMonth.map((r) => r.us)
    for (let i = 1; i < kr.length; i += 1) {
      expect(kr[i]).toBeLessThan(kr[i - 1])
      expect(us[i]).toBeLessThan(us[i - 1])
    }
  })

  it('지금 자리가 표의 첫 줄이다 — 화면이 "(지금)"을 거기 붙인다', () => {
    expect(CYCLE_TIMELINE.entryByMonth[0].month).toBe(CYCLE_TIMELINE.monthsAfterTrough)
  })

  it('시한이 눌림 구간보다 뒤다 — 기다리기 전에 시한이 끝나면 안 된다', () => {
    expect(CYCLE_TIMELINE.deadlineMonthsAhead).toBeGreaterThanOrEqual(CYCLE_TIMELINE.dipMonthsAhead)
  })

  it('**사다리의 눌림 칸이 측정된 눌림 깊이를 감싼다**', () => {
    // 쌀 때 깊이 중간값 -16.1% — 2차(-9%)와 3차(-18%) 사이에 들어와야
    // "그 자리를 노린다"는 화면 문구가 참이 된다.
    const offs = LADDERS.basing.map((d) => d.offset * 100)
    expect(offs[1]).toBeGreaterThan(CYCLE_TIMELINE.dipDepthPct)
    expect(offs[2]).toBeLessThan(CYCLE_TIMELINE.dipDepthPct)
  })
})

describe('buildActionPlan — 실행 계획', () => {
  const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
  const TODAY = new Date(2026, 10, 12) // 2026-11-12
  const steps = buildActionPlan(plan, TODAY, 807_000)

  it('addMonths가 말일을 넘기지 않는다', () => {
    expect(addMonths(new Date(2026, 2, 31), 1).getMonth()).toBe(3) // 3/31 + 1개월
    expect(addMonths(new Date(2026, 2, 31), 1).getDate()).toBe(30) // → 4/30
    expect(addMonths(new Date(2026, 10, 12), 4).getFullYear()).toBe(2027) // 해를 넘긴다
  })

  it('**다섯 단계가 순서대로 나온다** — 오늘 / 예약 / 시한 / 중단 / 금지', () => {
    expect(steps.map((s) => s.kind)).toEqual(['now', 'order', 'deadline', 'stop', 'never'])
  })

  it('첫 단계가 1차 수량·금액을 그대로 말한다', () => {
    expect(steps[0].title).toContain('11주')
    expect(steps[0].title).toContain('1,280,000')
    expect(steps[0].by).toBe('2026-11-12')
  })

  it('예약 단계가 2~4차를 전부 적는다 — 하나라도 빠지면 계획이 아니다', () => {
    for (const p of ['1,160,000원 7주', '1,040,000원 4주', '896,000원 4주']) {
      expect(steps[1].title).toContain(p)
    }
  })

  it('시한이 시간 계획의 개월 수만큼 뒤다', () => {
    expect(steps[2].by).toBe('2027-03-12') // 2026-11-12 + 4개월
    expect(steps[2].title).toContain('2027-03-12')
  })

  it('**중단선이 구간 저가다** — 이게 깨지면 사다리를 바꿔야 한다', () => {
    // 예전엔 이 줄이 "전제로 삼은 바닥이다 … 18%는 바닥 아래로 되돌아갔다"였다.
    // 그런데 저가 뒤에 고가를 찍은 종목에는 그 '18%'(바닥 이후 표본)가 해당하지
    // 않는다 — 안 맞는 근거를 붙이느니 구간 저가라고만 말한다.
    expect(steps[3].title).toContain('807,000')
    expect(steps[3].why).toContain('가장 낮은 가격')
    expect(steps[3].why).not.toContain('18%')
  })

  it('평단 위에서는 사지 않는다고 못 박는다', () => {
    expect(steps[4].title).toContain('2,032,230')
  })

  it('모든 단계에 이유가 붙어 있다 — 근거 없는 지시를 내리지 않는다', () => {
    for (const s of steps) expect(s.why.length).toBeGreaterThan(15)
  })
})

describe('monthsSince — "바닥에서 몇 개월차"를 날짜에서 센다', () => {
  it('상수가 아니라 계산이다 — 시간이 지나면 값이 늘어난다', () => {
    expect(monthsSince('2026-03-12', new Date(2026, 10, 12))).toBe(8)
    expect(monthsSince('2026-03-12', new Date(2026, 11, 12))).toBe(9)
    expect(monthsSince('2026-03-12', new Date(2027, 2, 12))).toBe(12)
  })

  it('날이 모자라면 한 달을 안 센다', () => {
    expect(monthsSince('2026-03-20', new Date(2026, 10, 12))).toBe(7)
  })

  it('날짜를 모르면 null — 그때만 측정 시점 값으로 떨어진다', () => {
    expect(monthsSince(undefined, new Date())).toBeNull()
    expect(monthsSince('이상한값', new Date())).toBeNull()
  })

  it('**시한이 바닥에서 12개월차로 고정된다** — 시간이 지나면 남은 기간이 줄어든다', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const at = (today: Date, trough: string) =>
      buildActionPlan(plan, today, 807_000, trough).find((s) => s.kind === 'deadline')!.by
    // 바닥 2026-03-12 → 12개월차는 2027-03-12. 오늘이 언제든 같은 날을 가리킨다.
    expect(at(new Date(2026, 10, 12), '2026-03-12')).toBe('2027-03-12')
    expect(at(new Date(2027, 0, 12), '2026-03-12')).toBe('2027-03-12')
  })

  it('이미 12개월차를 넘겼으면 시한이 오늘이다 — 더 기다릴 근거가 없다', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const s = buildActionPlan(plan, new Date(2027, 5, 12), 807_000, '2026-03-12')
    expect(s.find((x) => x.kind === 'deadline')!.by).toBe('2027-06-12')
  })
})

describe('차수 가격은 예산 없이도 정해진다 (금액 입력 전 미리보기의 근거)', () => {
  it('**가격은 현재가와 사다리 모양만으로 나온다** — 예산은 수량·금액에만 쓰인다', () => {
    // 화면이 금액 입력 전에 차수 가격을 보여 줄 수 있는 근거. 이게 깨지면
    // 미리보기가 실제 계획과 다른 가격을 말하게 된다.
    for (const style of LADDER_ORDER) {
      const plan = buildAverageDownPlan({ ...HYNIX, style })!
      const preview = LADDERS[style].map((d) => roundTrigger(HYNIX.price * (1 + d.offset)))
      // 평단 위라서 건너뛴 차수는 계획에 없다 — 있는 것끼리만 맞댄다.
      for (const t of plan.tranches) {
        expect(preview).toContain(t.triggerPrice)
      }
    }
  })

  it('예산을 바꿔도 차수 가격은 그대로다', () => {
    const a = buildAverageDownPlan({ ...HYNIX, budget: 10_000_000, style: 'basing' })!
    const b = buildAverageDownPlan({ ...HYNIX, budget: 50_000_000, style: 'basing' })!
    expect(a.tranches.map((t) => t.triggerPrice)).toEqual(b.tranches.map((t) => t.triggerPrice))
  })

  it('**사다리를 바꾸면 가격이 실제로 바뀐다** — 버튼이 일한다는 것의 근거', () => {
    const priceOf = (style: (typeof LADDER_ORDER)[number]) =>
      LADDERS[style].map((d) => roundTrigger(HYNIX.price * (1 + d.offset))).join(',')
    const all = LADDER_ORDER.map(priceOf)
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('**집행 후 평단은 기존 보유분과 섞은 값이다** (2026-11-12 사용자 지적)', () => {
  it('보유 수량이 늘면 집행 후 평단이 올라간다 — 안 그러면 기존 보유분을 안 센 것이다', () => {
    const one = buildAverageDownPlan({ ...HYNIX, shares: 1, style: 'basing' })!
    const real = buildAverageDownPlan({ ...HYNIX, shares: 13, style: 'basing' })!
    expect(real.finalAvgCost).toBeGreaterThan(one.finalAvgCost)
  })

  it('1차 집행 후 평단이 손으로 낸 가중평균과 같다', () => {
    // (2,032,230 × 13 + 1,280,000 × 11) ÷ 24 = 1,687,457.9…
    const p = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const t = p.tranches[0]
    const byHand = (HYNIX.avgCost * HYNIX.shares + t.triggerPrice * t.qty) / (HYNIX.shares + t.qty)
    expect(Math.round(t.avgCostAfter)).toBe(Math.round(byHand))
    expect(Math.round(t.avgCostAfter)).toBe(1_687_458)
  })

  it('**화면이 1주로 가정하면 평단이 얼마나 틀리는지 박아 둔다**', () => {
    // 예전 화면이 `shares: 1`을 넘겨서 13주 보유인데 1,342,686원으로 찍혔다.
    // 이 두 값이 같아지면 또 같은 버그가 들어온 것이다.
    const wrong = buildAverageDownPlan({ ...HYNIX, shares: 1, style: 'basing' })!
    expect(Math.round(wrong.tranches[0].avgCostAfter)).toBe(1_342_686)
    expect(Math.round(wrong.tranches[0].avgCostAfter)).not.toBe(1_687_458)
  })

  it('총 수량도 기존 보유분을 포함한다', () => {
    const p = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const added = p.tranches.reduce((a, t) => a + t.qty, 0)
    expect(p.finalQty).toBe(HYNIX.shares + added)
    expect(p.finalQty).toBe(39)
  })

  it('수량이 0이면 계획을 만들지 않는다 — 틀린 평단을 내느니 안 낸다', () => {
    expect(buildAverageDownPlan({ ...HYNIX, shares: 0 })).toBeNull()
  })
})

describe('troughStatus — 그 저가를 아직 "바닥"이라고 불러도 되는가', () => {
  it('**저가 뒤에 고가를 찍었으면 바닥이 아니다** (SK하이닉스 실측)', () => {
    // position_signals_probe 실측: 806,000(2026-03-31) → 2,987,000(2026-06-25) → 1,251,000
    expect(troughStatus('2026-03-31', '2026-06-25')).toBe('superseded')
  })

  it('고가가 먼저이고 저가가 나중이면 "바닥 이후"가 성립할 수 있다', () => {
    expect(troughStatus('2026-06-25', '2026-03-31')).toBe('confirmed')
  })

  it('날짜를 모르거나 같은 날이면 confirmed로 밀지 않는다', () => {
    expect(troughStatus(undefined, '2026-06-25')).toBe('unknown')
    expect(troughStatus('2026-03-31', undefined)).toBe('unknown')
    expect(troughStatus('2026-03-31', '2026-03-31')).toBe('unknown')
  })

  it('**전제가 깨지면 실행 계획이 "과거 평균 경로 위"라고 말하지 않는다**', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const now = (st: Parameters<typeof buildActionPlan>[4]) =>
      buildActionPlan(plan, new Date(2026, 10, 12), 807_000, '2026-03-31', st).find(
        (s) => s.kind === 'now',
      )!.why
    expect(now('confirmed')).toContain('과거 평균 경로 위')
    expect(now('superseded')).not.toContain('과거 평균 경로 위')
    expect(now('superseded')).toContain('당신의 판단')
  })

  it('**전제가 깨지면 시한도 측정을 근거로 대지 않는다**', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const why = (st: Parameters<typeof buildActionPlan>[4]) =>
      buildActionPlan(plan, new Date(2026, 10, 12), 807_000, '2026-03-31', st).find(
        (s) => s.kind === 'deadline',
      )!.why
    expect(why('confirmed')).toContain('+50.4%')
    expect(why('superseded')).not.toContain('+50.4%')
    expect(why('superseded')).toContain('스스로 정한 기한')
  })

  it('전제가 깨지면 시한을 "오늘부터 4개월"로 잡는다 — 바닥 기준점이 없다', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const by = (st: Parameters<typeof buildActionPlan>[4]) =>
      buildActionPlan(plan, new Date(2026, 10, 12), 807_000, '2026-03-31', st).find(
        (s) => s.kind === 'deadline',
      )!.by
    // 바닥 2026-03-31 기준 7개월차 → 12개월차까지 5개월 남음 → 2027-04-12
    expect(by('confirmed')).toBe('2027-04-12')
    // 전제가 깨졌으면 바닥을 기준점으로 쓰지 않는다 → 오늘(2026-11-12) + 4개월
    expect(by('superseded')).toBe('2027-03-12')

    // **바닥 날짜를 옮기면 confirmed만 따라 움직인다** — 이게 둘의 차이다.
    const moved = (st: Parameters<typeof buildActionPlan>[4]) =>
      buildActionPlan(plan, new Date(2026, 10, 12), 807_000, '2026-01-31', st).find(
        (s) => s.kind === 'deadline',
      )!.by
    expect(moved('confirmed')).toBe('2027-02-12')
    expect(moved('superseded')).toBe('2027-03-12')
  })

  it('중단선 설명이 "전제로 삼은 바닥"이라고 단정하지 않는다', () => {
    const plan = buildAverageDownPlan({ ...HYNIX, style: 'basing' })!
    const stop = buildActionPlan(plan, new Date(2026, 10, 12), 807_000, '2026-03-31', 'superseded')
      .find((s) => s.kind === 'stop')!
    expect(stop.why).toContain('가장 낮은 가격')
    expect(stop.why).not.toContain('전제로 삼은 바닥')
  })
})

describe('사다리 설명에 한 종목 전용 숫자를 박지 않는다', () => {
  it('**설명문에 특정 종목의 가격·개월 수가 들어가면 안 된다**', () => {
    // basing 설명에 "4차가 896,000원", "바닥에서 8개월"이 박혀 있었다. 그 패널은
    // 어떤 보유 종목에도 뜨므로, 다른 종목을 보면 그대로 틀린 말이 된다.
    // 측정 결과 수치(+51.6% 등)는 종목과 무관하므로 그대로 둔다.
    for (const [style, info] of Object.entries(LADDER_INFO)) {
      const t = `${info.gist} ${info.headline} ${info.body}`
      expect(t, `${style}에 원 단위 가격이 박혀 있다`).not.toMatch(/\d{3},\d{3}원/)
      expect(t, `${style}에 '바닥에서 N개월'이 박혀 있다`).not.toMatch(/바닥에서 \d+개월/)
    }
  })
})
