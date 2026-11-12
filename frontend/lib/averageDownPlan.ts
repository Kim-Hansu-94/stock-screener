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

/**
 * 사다리 한 칸. `offset`은 **현재가 대비 비율**이고 부호가 방향을 정한다.
 *   0보다 작으면 "그 가격까지 **떨어지면** 산다"(dip)
 *   0보다 크면   "그 가격까지 **올라오면** 산다"(rebound)
 *   0이면        지금 바로
 */
export interface LadderStep {
  offset: number
  weight: number
}

export type LadderStyle = 'dip' | 'rebound' | 'conviction' | 'cycle'

/**
 * 두 가지 사다리를 **둘 다 코드에 둔다.** 어느 쪽이 맞는지는 데이터가 못 정해 주고
 * (아래 참조), 그렇다고 한쪽을 지우면 왜 그 모양인지 근거가 사라진다.
 *
 * ## `dip` — 측정이 뒷받침하는 기본값
 * "더 빠진다"를 전제로 아래로 갈수록 크게 산다. 근거는 `backtestTurnSignals.ts`의
 * 104,119건: **이미 15% 이상 빠진 종목을 추가 매수하면 60거래일 안에 중간값 -15%까지
 * 더 빠진다.** 2·3차가 그 중간값을 양옆에서 감싼다.
 *
 * ## `rebound` — 사용자가 고른 모양 (2026-11-11)
 * "지금이 바닥권이고 저점을 다지는 중이라, 반등에 크게 싣고 싶다"는 판단을 그대로
 * 옮긴 것이다. 1차를 키우고(25%), 아래쪽은 한 칸만 남기고(20%), **나머지 55%를
 * 현재가 위에** 둔다 — 반등이 확인되면 그때 크게 사는 모양이다.
 *
 * **이 모양은 측정이 뒷받침하지 않는다는 것을 분명히 해 둔다.** 같은 날 잰 두 가지가
 * 반대를 가리킨다: (1) 위의 -15% 기본값은 "지금이 바닥"이라는 전제와 어긋나고,
 * (2) `backtestTurnSignals.ts`가 "하락이 멈추고 상승 전환"을 잡는 트리거 후보 7개를
 * 재서 **전부 기준선을 못 넘었다**(20거래일에서 7개 중 5개가 기준선보다 나빴고,
 * 60일 1·2등이 20일 꼴찌권이었다). 즉 **반등 확인 매수에 측정된 우위가 없다.**
 * 그래도 이 모양을 넣는 이유는, 돈을 넣는 사람이 시장을 어떻게 보는지가 데이터로
 * 정해지지 않는 선택이고 **사용자가 그 선택을 했기 때문**이다. 바꿀 때도 같은
 * 원칙으로 — 성적을 맞추려고 숫자를 돌리지 말 것.
 *
 * ## `conviction` — "바닥권이다"를 데이터와 어긋나지 않게 실행하는 모양 (2026-11-12)
 *
 * 2026-11-12 측정이 `rebound`의 전제를 직접 반박했다. "저점 대비 X% 올라오고 저점이
 * D일 안 깨졌을 때 산다"는 격자를 한국(16칸)·미국(16칸) **32칸 전부** 재 보니
 * 하나도 기준선을 못 넘었고, **X가 커질수록(= 반등을 많이 확인할수록) 정확히 그만큼
 * 나빠졌다**(한국 -0.4%~-4.2%, 미국 -0.2%~-3.5%, 종목 A/B 분리에서도 32칸 모두 같은 부호).
 *
 * 여기서 나오는 결론이 이 모양의 근거다: **"지금이 바닥권"이라고 믿는다면 그 믿음의
 * 올바른 실행은 '지금 많이 사는 것'이지 '반등을 확인하고 사는 것'이 아니다.** 이미
 * 싸다고 보면서 +8%·+23% 확인을 기다리는 건, 자기가 싸다고 판단한 가격을 두고 더 비싸게
 * 사겠다는 뜻이라 전제와 앞뒤가 안 맞는다.
 *
 * 그래서 1차를 35%로 키우고(= 바닥권 확신을 금액으로 표현) 나머지를 전부 아래에 둔다.
 * 아래 간격이 -12/-24/-36%인 것은 같은 날 잰 **추가 하락폭 분포**에서 나왔다:
 * 국내 전체 중간값 -17.2%(25%분위 -30.1%), 국내 대형주 -11.5%, **미국 IT -30.1%
 * (25%분위 -45.3%)**. SK하이닉스는 대형 기술주라 두 분포 사이에 있고, 4차(-36%)가
 * 그 종목의 8개월 전 실제 바닥(807,000원 ≈ -37%)과 거의 같은 자리에 떨어진다.
 *
 * ## `cycle` — **지금 서 있는 깊이에서 직접 잰** 분포 (2026-11-12)
 *
 * 앞 세 모양의 간격은 전부 "고점 대비 -15% 지점에서 출발한" 측정에서 나왔다.
 * 그런데 물타기를 고민하는 사람은 보통 그보다 훨씬 깊이 빠진 자리에 서 있다
 * (SK하이닉스는 -56%였다). **출발점이 다른 숫자로 간격을 잡으면 사다리가 통째로
 * 어긋난다** — 그래서 깊이 구간별로 다시 쟀다(`pipeline/research/semi_cycle_probe.py`).
 *
 * 국내 반도체 20종목 10년, **이미 -45~-60% 빠져 있던 85개월**에서 그 뒤 24개월간:
 *
 *   추가 하락폭  중간값 -9.2% · 25%분위 -19.7% · 10%분위 -32.6% · 최악 -41.8%
 *
 * 차수 가격이 이 분위수 그대로다(-9 / -20 / -33%). 임의로 고른 간격이 아니라
 * **분포에서 읽어온 값**이고, 깊이가 깊을수록 추가 하락이 **작아진다**는 것도
 * 같은 측정에서 나왔다(-15~-30% 구간은 중간값 -27.6%인데 -45~-60%는 -9.2%다).
 *
 * 비중을 1차에 40%로 몰아 둔 것도 그 분포 때문이다 — 중간값이 -9.2%뿐이라
 * 아래에서 기다릴 이유가 약하다. 2~4차는 꼬리에 대한 보험이다.
 *
 * **반드시 같이 알아야 할 두 가지.**
 * (1) **삼성전자·SK하이닉스는 10년간 -45% 아래로 간 적이 0번이다.** 그래서
 *     -45~-60% 구간의 85개월은 전부 **소부장 15종목**이고, 그쪽이 대형주보다
 *     변동이 크다. 지금 SK하이닉스의 -56%는 **10년 데이터에 선례가 없다.**
 * (2) 같은 구간의 "24개월 +122.2% · 회복 100%"는 **생존 편향이 극심하다** —
 *     그만큼 빠지고도 지금까지 살아남은 종목만 세기 때문이다. 간격을 잡는 데는
 *     썼지만 수익률 기대치로는 쓰지 않았다.
 *
 * 두 모양의 성격 차이는 시나리오 표에 그대로 드러난다: `rebound`는 평단을 덜 낮추는
 * 대신 반등이 진짜일 때 주식 수가 많고, `dip`은 그 반대다. **어느 쪽이 "좋다"가
 * 아니라 어느 쪽에 걸겠느냐의 문제다.**
 */
export const LADDERS: Record<LadderStyle, readonly LadderStep[]> = {
  dip: [
    { offset: 0, weight: 0.18 },
    { offset: -0.11, weight: 0.2 },
    { offset: -0.22, weight: 0.25 },
    { offset: -0.34, weight: 0.37 },
  ],
  rebound: [
    { offset: 0, weight: 0.25 },
    { offset: -0.12, weight: 0.2 },
    { offset: 0.08, weight: 0.22 },
    { offset: 0.23, weight: 0.33 },
  ],
  conviction: [
    { offset: 0, weight: 0.35 },
    { offset: -0.12, weight: 0.25 },
    { offset: -0.24, weight: 0.2 },
    { offset: -0.36, weight: 0.2 },
  ],
  cycle: [
    { offset: 0, weight: 0.4 },
    { offset: -0.09, weight: 0.25 },
    { offset: -0.2, weight: 0.2 },
    { offset: -0.33, weight: 0.15 },
  ],
} as const

export const DEFAULT_LADDER_STYLE: LadderStyle = 'rebound'

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
  /** 사다리 모양. 생략하면 `DEFAULT_LADDER_STYLE`. */
  style?: LadderStyle
}

export interface Tranche {
  /** 1부터. */
  step: number
  /**
   * 집행 가격. `direction`이 'dip'이면 이 가격 **이하**로 내려올 때,
   * 'rebound'면 이 가격 **이상**으로 올라올 때 산다. 1차는 현재가(즉시).
   */
  triggerPrice: number
  direction: 'now' | 'dip' | 'rebound'
  /** 현재가 대비 비율. 음수면 아래, 양수면 위. */
  offsetPct: number
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
  /** 어떤 사다리로 만든 계획인지 — 화면이 밝혀 적어야 한다. */
  style: LadderStyle
  tranches: Tranche[]
  /** 계획대로 다 사도 남는 돈(1주 값보다 적어 못 쓰는 잔액). */
  unusedBudget: number
  /** 더 사지 않는 가격 — 지금 평단. 이 위에서 사면 평단이 올라간다. */
  stopBuyingAbove: number
  /** 모든 차수를 집행한 뒤의 총 수량·평단(한 가지 경로 기준 — 위 주석 참조). */
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
  const style = input.style ?? DEFAULT_LADDER_STYLE
  if (!(avgCost > 0) || !(shares > 0) || !(price > 0) || !(budget > 0)) return null

  const lots: BuyLot[] = [{ price: avgCost, qty: shares }]
  const tranches: Tranche[] = []
  let spent = 0

  // **집행된 순서가 아니라 사다리에 적힌 순서대로** 쌓는다. 양방향 사다리에서는
  // 아래 차수와 위 차수 중 뭐가 먼저 걸릴지 알 수 없으므로, `avgCostAfter`는
  // "1차부터 이 차수까지 전부 샀다면"이라는 **한 가지 경로**의 값이다.
  // 실제 경로별 손익은 `evaluateScenario`가 따로 낸다.
  // 차수마다 주 수를 **내림**하면 끝에 쓸 수 없는 잔액이 남는다. 그 잔액을 그대로
  // 버리면 반등 사다리(비싼 가격에 사는 칸이 많다)에서 예산의 10%가 놀았다
  // (실측: 30,000,000원 중 3,060,000원). 그래서 **다음 차수로 넘긴다** — 비중은
  // 그대로 두고 자투리만 흘려보내는 것이라 설계 의도가 바뀌지 않는다.
  let carry = 0
  for (const [i, stepDef] of LADDERS[style].entries()) {
    const { offset, weight } = stepDef
    const trigger = roundTrigger(price * (1 + offset))
    if (!(trigger > 0)) continue
    // **평단 위에서는 사지 않는다.** 위쪽 차수는 반등을 쫓아 올라가므로 평단을 넘길
    // 수 있는데, 그 가격에 사면 평단이 **올라간다** — 이 계산기의 목적과 정반대다.
    // 건너뛴 몫은 `unusedBudget`으로 그대로 드러낸다(조용히 다른 차수로 밀어 넣으면
    // 사용자가 정한 비중이 아닌 계획이 된다).
    if (offset > 0 && trigger >= avgCost) continue
    const slice = budget * weight + carry
    const qty = Math.floor(slice / trigger)
    carry = slice - qty * trigger
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
      direction: offset === 0 ? 'now' : offset < 0 ? 'dip' : 'rebound',
      offsetPct: offset,
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
    style,
    tranches,
    unusedBudget: budget - spent,
    stopBuyingAbove: avgCost,
    finalQty: shares + tranches.reduce((a, t) => a + t.qty, 0),
    finalAvgCost: last.avgCostAfter,
  }
}

export interface ScenarioOutcome {
  label: string
  /** 1년 사이 **최저가** — 아래쪽(dip) 차수가 걸렸는지를 정한다. */
  lowPrice: number
  /** 1년 사이 **최고가** — 위쪽(rebound) 차수가 걸렸는지를 정한다. */
  highPrice: number
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
 * "1년 동안 이렇게 움직이면 얼마"를 계산한다. **확률은 붙이지 않는다** — 어느 시나리오가
 * 얼마나 그럴듯한지는 이 코드가 알 수 없고, 숫자를 붙이면 예측처럼 읽힌다.
 *
 * 최저가·최고가·끝 가격을 **따로** 받는다. 아래쪽 차수는 지나간 **최저가**로,
 * 위쪽 차수는 지나간 **최고가**로 걸리는지가 정해지고, 손익은 **끝 가격**으로 정해진다.
 * 하나로 뭉치면 "바닥을 찍고 회복한 경우"도 "반등했다가 되밀린 경우"도 표현할 수 없다.
 *
 * **순서는 모른다는 것을 알고 쓴다** — 같은 1년이라도 "먼저 빠졌다 오른" 경우와
 * "먼저 올랐다 빠진" 경우에 실제 집행 결과가 다를 수 있다. 여기서는 걸린 차수를
 * 전부 집행한 것으로 보므로, 양방향 사다리에서는 **가장 많이 산 경우**에 해당한다.
 */
export function evaluateScenario(
  input: PlanInput,
  plan: AverageDownPlan,
  label: string,
  lowPrice: number,
  highPrice: number,
  endPrice: number,
): ScenarioOutcome {
  const { avgCost, shares, price, budget } = input
  const executed = plan.tranches.filter((t) =>
    t.direction === 'rebound' ? highPrice >= t.triggerPrice : lowPrice <= t.triggerPrice,
  )
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
    highPrice,
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
 * 화면에 띄울 기본 시나리오 다섯 개.
 *
 * **가격을 지어내지 않는다** — 전부 손에 있는 값에서 나온다: 현재가, 측정된 중간
 * 하락폭(-15%), 이 종목의 **실제 구간 저가**, 사용자의 평단, 그리고 **사다리 자신의
 * 마지막 위쪽 차수**(반등 시나리오의 기준점). 목표가나 컨센서스는 넣지 않는다
 * (이 라이브러리는 예측을 다루지 않는다).
 *
 * 확률은 붙이지 않는다. 어느 쪽이 얼마나 그럴듯한지 이 코드는 모르고, 숫자를 붙이면
 * 예측처럼 읽힌다. 다섯 개를 고른 기준은 **서로 다른 결론을 내는 경우**를 덮는 것이다:
 * 더 빠지는 경우 / 바닥을 재확인하는 경우 / 회복하는 경우 / 안 빠지고 오르는 경우 /
 * 반등만 하고 평단까지는 못 가는 경우.
 */
export function defaultScenarios(
  input: PlanInput,
  plan: AverageDownPlan,
  periodLow: number,
): ScenarioOutcome[] {
  const { price, avgCost } = input
  const medianDown = Math.round(price * (1 - MEDIAN_FURTHER_DROP))
  const low = periodLow > 0 && periodLow < price ? periodLow : medianDown
  // 사다리의 가장 높은 위쪽 차수 — 없으면(dip 사다리) 현재가.
  const topTrigger = plan.tranches.reduce(
    (hi, t) => (t.direction === 'rebound' && t.triggerPrice > hi ? t.triggerPrice : hi),
    price,
  )
  const S = (label: string, lo: number, hi: number, end: number) =>
    evaluateScenario(input, plan, label, lo, hi, end)
  return [
    S(`여기서 ${Math.round(MEDIAN_FURTHER_DROP * 100)}% 더 빠진 채로 끝`, medianDown, price, medianDown),
    S('구간 저가까지 갔다가 지금 가격 회복', low, price, price),
    S('구간 저가까지 갔다가 내 평단 회복', low, avgCost, avgCost),
    S('안 빠지고 바로 평단 회복', price, avgCost, avgCost),
    // 반등 사다리가 노리는 바로 그 경우 — 마지막 위쪽 차수까지 올라와서 거기서 멈춤.
    S('안 빠지고 반등해서 마지막 차수 가격에서 끝', price, topTrigger, topTrigger),
  ]
}
