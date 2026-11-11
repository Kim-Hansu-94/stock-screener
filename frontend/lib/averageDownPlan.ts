/**
 * **추가 매수(물타기) 분할 계획** — "얼마에, 얼마씩" 을 미리 정해 두는 계산.
 *
 * 이 파일은 주가를 예측하지 않는다
 * --------------------------------
 * 목표가를 넣지 않는다. 넣을 수가 없다 — 이 저장소가 세 번(지지신호 5개 · 전환 신호
 * 7개 · 490590 A/B/C) 백테스트로 확인한 것은 **앞날을 가리키는 신호를 못 찾았다**는
 * 것이었고, 그 자리에 숫자를 지어 넣으면 근거 없는 확신을 화면에 띄우게 된다.
 *
 * 대신 **측정된 사실 하나** 위에 세운다(`research/backtestTurnSignals.ts`, 104,119건):
 *
 *   이미 15% 이상 빠진 종목을 추가 매수하면, 60거래일 안에 중간값 **-15%까지 더** 빠진다.
 *
 * 이건 신호가 아니라 **각오해야 할 기본값**이다. 그래서 계획은 "더 빠질 것"을 전제로
 * 짠다 — 지금 다 쓰지 않고, 아래로 갈수록 더 크게 산다. 분할매수가 예측이 아니라
 * 변동성 관리인 근거가 여기 있다.
 *
 * 쓰지 않기로 한 것
 * -----------------
 * **지지신호 충족 개수를 게이트로 쓰지 않는다.** 물타기 상황(이미 깊이 빠진 종목)에서
 * 충족 개수와 60거래일 성과 사이에 단조성이 없다는 것이 실측됐다(중앙값 0개 -0.43% ·
 * 1개 -1.47% · 2개 -2.57% · 3개 -1.79%, `supportSignals.ts` 참조). 개수를 조건으로
 * 걸면 근거 없는 숫자로 매수를 막거나 허락하게 된다. 지지신호는 **읽을 참고 자료**로
 * 화면에 남기고, 집행 여부는 가격만으로 정한다.
 *
 * 왜 가격 사다리인가
 * ------------------
 * 가격은 예측이 아니다. "1,000,000원이 되면 산다"는 맞고 틀리고가 없는 규칙이고,
 * 증권사 조건주문에 그대로 걸어 둘 수 있어 **사람이 그날의 기분으로 바꾸지 못한다.**
 * 물타기가 실패하는 전형적인 경로가 "더 빠지면 사야지" 하다가 막상 빠지면 무서워서
 * 못 사고, 오르면 조급해서 비싸게 사는 것이다.
 *
 * 차수별 하락률 [0%, -11%, -22%, -34%]
 *   측정된 중간값(-15%)을 2·3차가 **양옆에서 감싼다**. 4차는 그보다 뚜렷하게 나쁜
 *   경우를 맡는다. 중간값에 딱 맞춰 한 번에 사면 절반의 경우에 더 싼 값을 놓친다.
 *
 * 차수별 금액 비중 [18%, 20%, 25%, 37%]
 *   아래로 갈수록 키운다. 그래야 싸게 산 수량이 평단을 끌어내린다. 1차를 0으로 두지
 *   않는 이유는, 안 빠지고 올라가 버리면 예산이 통째로 노는 쪽도 손해이기 때문이다.
 *
 * **이 두 배열은 백테스트로 최적화한 값이 아니다.** 측정된 중간값 한 개를 기준으로
 * 고른 설계값이다 — 상수를 바꿔 성적을 맞추는 짓은 하지 않았다(그건 과최적화다).
 * 바꾸려면 근거를 적고 `averageDownPlan.test.ts`를 같이 고칠 것.
 */
import { computeAverageCost, DEFAULT_SELL_COST_PCT, type BuyLot } from './averageCost'
import type { Market } from './types'

/** 차수별 "현재가 대비 하락률". 0 = 지금 바로. */
export const LADDER_DROPS = [0, 0.11, 0.22, 0.34] as const
/** 차수별 예산 비중. 합이 1이다. */
export const LADDER_WEIGHTS = [0.18, 0.2, 0.25, 0.37] as const

/**
 * 다음 차수가 이 거래일 수 동안 안 걸리면 사람을 부른다(자동 집행이 아니다).
 * 측정 지평선이 60거래일이므로 그 두 배를 기다려 본다 — 그만큼 안 빠졌다면
 * 이 사다리가 가정한 상황이 아니었다는 뜻이다.
 */
export const STALE_TRADING_DAYS = 120

export interface PlanInput {
  /** 지금 평단가(원). */
  avgCost: number
  /** 지금 보유 수량(주). */
  shares: number
  /** 현재가(원). */
  price: number
  /** 추가로 쓸 수 있는 금액(원). */
  budget: number
  market?: Market
}

export interface Tranche {
  /** 1부터. */
  step: number
  /** 이 가격 **이하**가 되면 집행한다. 1차는 현재가(즉시). */
  triggerPrice: number
  /** 현재가 대비 하락률(0~1). */
  dropPct: number
  qty: number
  cost: number
  /** 이 차수까지 집행했을 때의 평단가. */
  avgCostAfter: number
  /** 이 차수까지 집행했을 때의 본전 가격(매도비용 포함). */
  breakevenAfter: number
  /** 이 차수까지 쓰고 남는 예산. */
  budgetLeft: number
}

export interface AverageDownPlan {
  tranches: Tranche[]
  /** 계획대로 다 사도 남는 돈(1주 값보다 적어 못 쓰는 잔액). */
  unusedBudget: number
  /** 더 사지 않는 가격 — 지금 평단. 이 위에서 사면 평단이 올라간다. */
  stopBuyingAbove: number
  /** 4차까지 다 집행한 뒤의 총 수량·평단. */
  finalQty: number
  finalAvgCost: number
}

/** 사람이 조건주문에 그대로 넣을 수 있도록 '읽히는 자리'에서 끊는다. */
export function roundTrigger(price: number): number {
  if (!(price > 0)) return 0
  const step = Math.max(1, 10 ** (Math.floor(Math.log10(price)) - 2))
  return Math.floor(price / step) * step
}

/**
 * 가격 사다리를 만든다.
 *
 * 수량은 **내림**한다 — 예산을 넘겨 사는 일이 없어야 한다. 그래서 마지막에 1주 값보다
 * 적은 잔액이 남고, 그 금액을 `unusedBudget`으로 그대로 드러낸다(조용히 어딘가에
 * 밀어 넣으면 계획과 실제가 어긋난다).
 */
export function buildAverageDownPlan(input: PlanInput): AverageDownPlan | null {
  const { avgCost, shares, price, budget } = input
  const market = input.market ?? 'KR'
  if (!(avgCost > 0) || !(shares > 0) || !(price > 0) || !(budget > 0)) return null

  const lots: BuyLot[] = [{ price: avgCost, qty: shares }]
  const tranches: Tranche[] = []
  let spent = 0

  for (let i = 0; i < LADDER_DROPS.length; i += 1) {
    const drop = LADDER_DROPS[i]
    const trigger = i === 0 ? roundTrigger(price) : roundTrigger(price * (1 - drop))
    const slice = budget * LADDER_WEIGHTS[i]
    const qty = Math.floor(slice / trigger)
    if (qty <= 0) continue
    const cost = qty * trigger
    spent += cost
    lots.push({ price: trigger, qty })
    // 평단·본전가는 기존 계산기를 그대로 쓴다 — 매도비용(KR 0.165%)까지 같은 규칙이다.
    // 세 번째 인자는 매도비용 **비율(%)** 이다 — 본전가가 평단보다 그만큼 위에 잡힌다.
    const agg = computeAverageCost(lots, trigger, DEFAULT_SELL_COST_PCT[market])
    if (!agg) continue
    tranches.push({
      step: i + 1,
      triggerPrice: trigger,
      dropPct: drop,
      qty,
      cost,
      avgCostAfter: agg.avgCost,
      breakevenAfter: agg.breakevenPrice,
      budgetLeft: budget - spent,
    })
  }

  if (tranches.length === 0) return null
  const last = tranches[tranches.length - 1]
  return {
    tranches,
    unusedBudget: budget - spent,
    stopBuyingAbove: avgCost,
    finalQty: shares + tranches.reduce((a, t) => a + t.qty, 0),
    finalAvgCost: last.avgCostAfter,
  }
}

export interface ScenarioOutcome {
  label: string
  /** 1년 사이 **최저가** — 어느 차수까지 걸렸는지를 정한다. */
  lowPrice: number
  /** 1년 뒤 **가격** — 손익을 정한다. */
  endPrice: number
  executedSteps: number
  /** 계획대로 샀을 때: 투입 원금·평가금액·손익(원). */
  planInvested: number
  planValue: number
  planPnl: number
  planPnlPct: number
  /** 아무것도 안 샀을 때(지금 그대로 보유). */
  holdInvested: number
  holdValue: number
  holdPnl: number
  holdPnlPct: number
  /** 지금 전액을 한 번에 샀을 때 — 나눠 사는 게 정말 나은지 비교하려고 같이 낸다. */
  allInPnl: number
}

/**
 * "1년 뒤 이 가격이면 얼마"를 계산한다. **확률은 붙이지 않는다** — 어느 시나리오가
 * 얼마나 그럴듯한지는 이 코드가 알 수 없고, 숫자를 붙이면 예측처럼 읽힌다.
 *
 * 최저가와 1년 뒤 가격을 **따로** 받는 이유: 차수가 걸리는 건 지나간 최저가로 정해지고
 * 손익은 끝 가격으로 정해진다. 하나로 뭉치면 "바닥을 찍고 회복한 경우"를 표현할 수 없다.
 */
export function evaluateScenario(
  input: PlanInput,
  plan: AverageDownPlan,
  label: string,
  lowPrice: number,
  endPrice: number,
): ScenarioOutcome {
  const { avgCost, shares, price, budget } = input
  const executed = plan.tranches.filter((t) => lowPrice <= t.triggerPrice)
  const addQty = executed.reduce((a, t) => a + t.qty, 0)
  const addCost = executed.reduce((a, t) => a + t.cost, 0)

  const holdInvested = avgCost * shares
  const planInvested = holdInvested + addCost
  const planValue = (shares + addQty) * endPrice
  const holdValue = shares * endPrice

  // 지금 전액 투입 — 같은 예산으로 현재가에 살 수 있는 만큼.
  const allInQty = Math.floor(budget / price)
  const allInInvested = holdInvested + allInQty * price
  const allInPnl = (shares + allInQty) * endPrice - allInInvested

  return {
    label,
    lowPrice,
    endPrice,
    executedSteps: executed.length,
    planInvested,
    planValue,
    planPnl: planValue - planInvested,
    planPnlPct: planInvested > 0 ? ((planValue - planInvested) / planInvested) * 100 : 0,
    holdInvested,
    holdValue,
    holdPnl: holdValue - holdInvested,
    holdPnlPct: holdInvested > 0 ? ((holdValue - holdInvested) / holdInvested) * 100 : 0,
    allInPnl,
  }
}

/** 매도비용 비율(화면이 '약'이라고 밝히는 데 쓴다). */
export const SELL_COST_PCT = DEFAULT_SELL_COST_PCT

/**
 * 측정된 중간값만큼 더 빠지는 경우의 가격. 시나리오의 기준점이자, 2·3차 사다리가
 * 감싸고 있는 바로 그 값이다.
 */
export const MEDIAN_FURTHER_DROP = 0.15

/**
 * 화면에 띄울 기본 시나리오 네 개.
 *
 * **가격을 지어내지 않는다** — 전부 손에 있는 값에서 나온다: 현재가, 측정된 중간
 * 하락폭(-15%), 이 종목의 **실제 구간 저가**, 그리고 사용자의 평단. 목표가나
 * 컨센서스는 넣지 않는다(이 라이브러리는 예측을 다루지 않는다).
 *
 * 확률은 붙이지 않는다. 어느 쪽이 얼마나 그럴듯한지 이 코드는 모르고, 숫자를 붙이면
 * 예측처럼 읽힌다.
 */
export function defaultScenarios(
  input: PlanInput,
  plan: AverageDownPlan,
  periodLow: number,
): ScenarioOutcome[] {
  const { price, avgCost } = input
  const medianDown = Math.round(price * (1 - MEDIAN_FURTHER_DROP))
  const low = periodLow > 0 && periodLow < price ? periodLow : medianDown
  const out: ScenarioOutcome[] = [
    evaluateScenario(input, plan, `${Math.round(MEDIAN_FURTHER_DROP * 100)}% 더 빠진 채로 끝`, medianDown, medianDown),
    evaluateScenario(input, plan, '구간 저가까지 갔다가 지금 가격 회복', low, price),
    evaluateScenario(input, plan, '구간 저가까지 갔다가 내 평단 회복', low, avgCost),
    evaluateScenario(input, plan, '안 빠지고 바로 평단 회복', price, avgCost),
  ]
  return out
}
