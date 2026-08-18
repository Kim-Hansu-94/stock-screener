import type { PriceBar } from './risk'
import type { Market } from './types'

/**
 * 스크리너 성적 집계.
 *
 * 기존 집계(getScreenerTrackRecord)의 두 가지 문제를 고친다.
 *
 * 1) 미청산 편향 — 손절은 가깝고(1R) 목표는 멀어서(보통 2R+) 손절이 훨씬 빨리
 *    걸린다. 그래서 "청산된 것만" 평균 내면 빨리 끝난 손절만 표본에 들어가고,
 *    아직 굴러가는 좋은 트레이드는 계속 빠진다. 평균 수익률이 구조적으로
 *    음수 쪽으로 치우치는 원인.
 *    → MAX_HOLD_BARS가 지나면 그 시점 종가로 강제 청산해 결론을 낸다.
 *      아직 그만큼 지나지 않은 추천은 'pending'으로 집계에서 통째로 뺀다
 *      (결과를 아직 모르는 걸 0으로 세면 그것도 편향이다).
 *
 * 2) 기준선 부재 — 목표가 2R이면 실력이 없어도 손절이 2배 자주 걸린다.
 *    손절률 67%는 '본전'이지 '실패'가 아닌데, 화면에 기준선이 없어 큰 숫자만
 *    보였다. → breakevenHitRate를 같이 계산해 항상 나란히 보여준다.
 */

// 강제 청산까지 보유하는 거래일 수. 눌림목은 수주~수개월 호흡이라 3개월(약 60거래일)이면
// 목표든 손절이든 결론이 났다고 본다. 이보다 짧으면 아직 살아 있는 트레이드를 죽은 걸로
// 세고, 길면 판정 대기가 쌓여 표본이 안 모인다.
export const MAX_HOLD_BARS = 60

export type TradeOutcome = 'target' | 'stop' | 'timeout' | 'pending'

export interface TradeInput {
  date: string
  market: Market
  ticker: string
  name: string
  nameKr?: string
  sector: string
  entry: number
  stop: number
  target: number
  /** 추천일 '이후' 봉만. 추천일 당일은 이미 진입가로 반영돼 있으므로 넣지 않는다. */
  futureBars: PriceBar[]
  regime: 'bull' | 'bear' | null
}

export interface ResolvedTrade extends Omit<TradeInput, 'futureBars'> {
  outcome: TradeOutcome
  /** 판정 완료된 트레이드만. pending이면 null. */
  exitPrice: number | null
  /** 실현 손익을 손절폭(1R) 배수로. pending이면 null. */
  r: number | null
  holdingDays: number | null
  /** 진입 시점에 걸려 있던 목표 배수 = (목표-진입)/(진입-손절). 기준선 계산에 쓴다. */
  rewardR: number
}

export function resolveTrade(input: TradeInput): ResolvedTrade {
  const { entry, stop, target, futureBars, ...meta } = input
  const risk = entry - stop
  const rewardR = risk > 0 ? (target - entry) / risk : 0
  const base = { ...meta, entry, stop, target, rewardR }

  const horizon = futureBars.slice(0, MAX_HOLD_BARS)

  for (let i = 0; i < horizon.length; i++) {
    const bar = horizon[i]
    // 한 봉에서 둘 다 닿으면 손절 우선. 일봉만으로는 장중 순서를 알 수 없으므로
    // 불리한 쪽을 택해 성적을 부풀리지 않는다.
    if (bar.low <= stop) {
      return { ...base, outcome: 'stop', exitPrice: stop, r: risk > 0 ? -1 : null, holdingDays: i + 1 }
    }
    if (bar.high >= target) {
      return {
        ...base, outcome: 'target', exitPrice: target,
        r: risk > 0 ? rewardR : null, holdingDays: i + 1,
      }
    }
  }

  // 아직 MAX_HOLD_BARS를 채우지 못했다 = 결과를 모른다. 집계에서 뺀다.
  if (futureBars.length < MAX_HOLD_BARS) {
    return { ...base, outcome: 'pending', exitPrice: null, r: null, holdingDays: null }
  }

  // 기간을 다 채웠는데 목표도 손절도 안 걸림 → 그 시점 종가로 청산 처리.
  const last = horizon[horizon.length - 1]
  return {
    ...base, outcome: 'timeout', exitPrice: last.close,
    r: risk > 0 ? (last.close - entry) / risk : null,
    holdingDays: horizon.length,
  }
}

export interface Scorecard {
  /** 판정이 끝나 집계에 들어간 건수. 모든 비율의 분모. */
  resolved: number
  /** 아직 기간이 안 찬 건수. 집계에서 제외됐음을 화면에 밝히기 위해 들고 다닌다. */
  pending: number
  targetHits: number
  stops: number
  timeouts: number
  /** 주인공. 추천 1건당 평균 손익(손절폭 배수). 0보다 크면 따라갈 가치가 있다. */
  expectancyR: number
  /** 판정 완료분의 R 합계. "이만큼의 위험을 걸어 이만큼 벌었다"의 총량. */
  totalR: number
  /** 목표 도달 비율. 이 값만으로는 좋고 나쁨을 알 수 없어 항상 기준선과 같이 쓴다. */
  hitRate: number
  /**
   * 손익분기 도달률 = 1/(1+평균 목표배수). 목표가 2R이면 33%.
   * hitRate가 이보다 높으면 우위가 있다는 뜻.
   */
  breakevenHitRate: number
  avgHoldingDays: number
}

const EMPTY: Scorecard = {
  resolved: 0, pending: 0, targetHits: 0, stops: 0, timeouts: 0,
  expectancyR: 0, totalR: 0, hitRate: 0, breakevenHitRate: 0, avgHoldingDays: 0,
}

export function summarize(trades: ResolvedTrade[]): Scorecard {
  const pending = trades.filter((t) => t.outcome === 'pending').length
  const done = trades.filter((t) => t.outcome !== 'pending' && t.r !== null)
  if (done.length === 0) return { ...EMPTY, pending }

  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
  const totalR = sum(done.map((t) => t.r as number))
  const avgRewardR = sum(done.map((t) => t.rewardR)) / done.length

  return {
    resolved: done.length,
    pending,
    targetHits: done.filter((t) => t.outcome === 'target').length,
    stops: done.filter((t) => t.outcome === 'stop').length,
    timeouts: done.filter((t) => t.outcome === 'timeout').length,
    expectancyR: totalR / done.length,
    totalR,
    hitRate: done.filter((t) => t.outcome === 'target').length / done.length,
    breakevenHitRate: avgRewardR > 0 ? 1 / (1 + avgRewardR) : 0,
    avgHoldingDays: sum(done.map((t) => t.holdingDays ?? 0)) / done.length,
  }
}

export interface Segment {
  key: string
  label: string
  card: Scorecard
}

/** "어떤 종류의 추천이 잘 맞나"용. 표본이 너무 적은 구간은 착시라 잘라낸다. */
export const MIN_SEGMENT_SAMPLE = 5

export function segmentBy(
  trades: ResolvedTrade[],
  keyFn: (t: ResolvedTrade) => string | null,
  labelFn: (key: string) => string = (k) => k,
): Segment[] {
  const groups = new Map<string, ResolvedTrade[]>()
  for (const t of trades) {
    const key = keyFn(t)
    if (key === null) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(t)
    else groups.set(key, [t])
  }

  return [...groups.entries()]
    .map(([key, ts]) => ({ key, label: labelFn(key), card: summarize(ts) }))
    .filter((s) => s.card.resolved >= MIN_SEGMENT_SAMPLE)
    .sort((a, b) => b.card.expectancyR - a.card.expectancyR)
}

export type Verdict = 'insufficient' | 'negative' | 'marginal' | 'positive'

/**
 * "이 스크리너를 따라가면 돈을 버나"에 대한 한 줄 답.
 * 표본이 적으면 숫자가 좋아도 단정하지 않는다 — 20건 미만은 운으로 뒤집히는 범위다.
 */
export function verdictOf(card: Scorecard): Verdict {
  if (card.resolved < 20) return 'insufficient'
  if (card.expectancyR <= 0) return 'negative'
  if (card.expectancyR < 0.2) return 'marginal'
  return 'positive'
}
