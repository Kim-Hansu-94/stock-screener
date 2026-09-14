import type { PriceBar } from './risk'
import type { Verdict } from './scorecard'

/**
 * 저점 매집 후보(Gold Standard 패턴) 추천 성적 집계.
 *
 * 눌림목 성적(`scorecard.ts`)과 **다른 틀**이다. 섞지 말 것:
 *
 * - 눌림목은 진입할 때 손절·목표가가 정해지므로 손익을 R(손절폭 배수)로 잰다.
 *   저점 매집 후보는 손절·목표를 계산하지 않는다(`pattern_discovery.py`에 없다).
 *   그래서 여기서는 **단순 보유 수익률(%)** 로 잰다.
 * - 눌림목은 "며칠 만에 목표/손절에 닿았나"가 결론이지만, 바닥 후보는 닿을 선이
 *   없어서 "정해진 기간 뒤 얼마였나"가 결론이다.
 *
 * **분포가 한쪽으로 쏠린다는 점이 이 탭의 핵심 성질이다.** 55% 이상 빠진 종목을
 * 고르는 전략이라 대부분은 그대로 눕거나 더 빠지고, 소수가 몇 배로 튄다. 그래서
 * 평균만 보면 한두 종목에 끌려가 실제보다 좋아 보인다 — `summarizePattern`이
 * 평균과 **중간값을 항상 같이** 내고, 둘의 부호가 갈리면 `skewed`로 표시하는 이유다.
 *
 * ⚠️ 기준선(벤치마크)이 없다. 같은 기간 지수 수익률과 비교하는 것이 맞지만
 * `market_index_snapshot`은 지수당 1행만 들고 있어(현재 시황 위젯용) 과거 시계열이
 * 없다. 그래서 지금은 "0%보다 위인가"와 승률 50%만 기준으로 쓴다. 화면에도 그렇게
 * 밝혀 둘 것 — 없는 기준선을 있는 척하면 +3%가 좋은 값인지 나쁜 값인지 모른 채
 * 알고리즘을 고치게 된다.
 */

/**
 * 판정까지 관찰하는 거래일 수. 3개월이라 눌림목의 `MAX_HOLD_BARS`와 값이 같은데,
 * **같은 상수를 공유하지 않는다** — 한쪽 화면의 호흡을 바꾼다고 다른 쪽 판정 기간이
 * 따라 움직여선 안 된다. 근거도 다르다(저쪽은 스윙 보유 기간, 이쪽은 바닥 탈출이
 * 시작됐는지 보는 관찰 기간).
 */
export const PATTERN_HOLD_BARS = 60

/** 중간 점검용 — 1개월. 바닥 후보는 반등이 늦게 오기도 해서 둘을 같이 본다. */
export const PATTERN_EARLY_BARS = 20

/** "크게 먹었다 / 크게 잃었다"의 경계. 바닥 후보는 변동이 커서 ±10%로는 구분이 안 된다. */
export const BIG_MOVE_PCT = 30

/** 추천 시점에 pattern_discovery가 계산한 근거. 마이그레이션 전 추천은 전부 null이다. */
export interface PatternFeatures {
  /** 복합 점수 0~1 */
  score: number | null
  drawdownPct: number | null
  daysSinceLow: number | null
  volRatio: number | null
  vcp: boolean | null
  higherLow: boolean | null
  volumeTriggered: boolean | null
}

export interface PatternRecInput {
  date: string
  ticker: string
  name: string
  nameKr?: string
  sector: string | null
  rank: number
  /** 추천일 종가 = 진입가 */
  entry: number
  /** 추천일 '이후' 봉만. 추천일 당일은 진입가로 이미 반영돼 있다. */
  futureBars: PriceBar[]
  features: PatternFeatures
}

export interface ResolvedPatternRec extends Omit<PatternRecInput, 'futureBars'> {
  /** PATTERN_EARLY_BARS 뒤 수익률(%). 봉이 부족하면 null. */
  earlyReturnPct: number | null
  /** PATTERN_HOLD_BARS 뒤 수익률(%). 판정의 주인공. 미달이면 null. */
  returnPct: number | null
  /** 관찰 기간 중 최고가 기준 최대 상승률(%) — "얼마까지 갔었나". */
  maxGainPct: number | null
  /** 관찰 기간 중 최저가 기준 최대 하락률(%) — "버티려면 얼마를 견뎌야 했나". */
  maxDropPct: number | null
  /** 관찰 기간을 다 채웠는가. false면 결과를 모르는 것이므로 집계에서 뺀다. */
  settled: boolean
}

const pct = (from: number, to: number) => ((to - from) / from) * 100

export function resolvePatternRec(input: PatternRecInput): ResolvedPatternRec {
  const { futureBars, ...meta } = input
  const { entry } = meta
  const empty = {
    ...meta,
    earlyReturnPct: null,
    returnPct: null,
    maxGainPct: null,
    maxDropPct: null,
    settled: false,
  }
  if (!(entry > 0)) return empty

  const horizon = futureBars.slice(0, PATTERN_HOLD_BARS)
  const early = futureBars[PATTERN_EARLY_BARS - 1]
  const earlyReturnPct = early ? pct(entry, early.close) : null

  // 기간을 못 채웠으면 '아직 모른다'. 그 시점 종가로 미리 결론을 내면 이 탭에 불리하게
  // 치우친다 — 바닥 후보는 반등 전 몇 달을 더 눕는 경우가 흔하다.
  if (futureBars.length < PATTERN_HOLD_BARS) {
    return { ...empty, earlyReturnPct }
  }

  const last = horizon[horizon.length - 1]
  return {
    ...meta,
    earlyReturnPct,
    returnPct: pct(entry, last.close),
    maxGainPct: pct(entry, Math.max(...horizon.map((b) => b.high))),
    maxDropPct: pct(entry, Math.min(...horizon.map((b) => b.low))),
    settled: true,
  }
}

export interface PatternScorecard {
  /** 판정이 끝나 집계에 들어간 건수. 모든 값의 분모. */
  settled: number
  /** 아직 관찰 기간이 안 찬 건수. 집계에서 빠졌음을 화면에 밝히려고 들고 다닌다. */
  pending: number
  /** 수익률 > 0 비율. 기준선은 50%다(벤치마크가 없어 이것밖에 없다). */
  winRate: number
  avgReturnPct: number
  medianReturnPct: number
  /** +BIG_MOVE_PCT 이상 오른 비율 — 이 전략이 노리는 결과 */
  bigWinRate: number
  /** -BIG_MOVE_PCT 이하로 더 빠진 비율 */
  bigLossRate: number
  avgMaxGainPct: number
  avgMaxDropPct: number
  /**
   * 평균은 플러스인데 중간값은 마이너스(또는 그 반대) = 소수 종목이 평균을 끌고 간 상태.
   * "평균 +8%"만 보고 따라가면 실제로는 대부분 손실인 상황을 놓친다.
   */
  skewed: boolean
}

const EMPTY: PatternScorecard = {
  settled: 0, pending: 0, winRate: 0, avgReturnPct: 0, medianReturnPct: 0,
  bigWinRate: 0, bigLossRate: 0, avgMaxGainPct: 0, avgMaxDropPct: 0, skewed: false,
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export function summarizePattern(recs: ResolvedPatternRec[]): PatternScorecard {
  const pending = recs.filter((r) => !r.settled).length
  const done = recs.filter((r): r is ResolvedPatternRec & { returnPct: number } => r.returnPct !== null)
  if (done.length === 0) return { ...EMPTY, pending }

  const returns = done.map((r) => r.returnPct)
  const avgReturnPct = mean(returns)
  const medianReturnPct = median(returns)
  const rate = (n: number) => n / done.length

  return {
    settled: done.length,
    pending,
    winRate: rate(returns.filter((x) => x > 0).length),
    avgReturnPct,
    medianReturnPct,
    bigWinRate: rate(returns.filter((x) => x >= BIG_MOVE_PCT).length),
    bigLossRate: rate(returns.filter((x) => x <= -BIG_MOVE_PCT).length),
    avgMaxGainPct: mean(done.map((r) => r.maxGainPct ?? 0)),
    avgMaxDropPct: mean(done.map((r) => r.maxDropPct ?? 0)),
    skewed: Math.sign(avgReturnPct) !== Math.sign(medianReturnPct),
  }
}

export interface PatternSegment {
  key: string
  label: string
  card: PatternScorecard
}

/** 표본이 적은 구간은 착시라 잘라낸다. 눌림목 성적과 같은 기준을 쓴다. */
export const MIN_PATTERN_SAMPLE = 5

export function segmentPatternBy(
  recs: ResolvedPatternRec[],
  keyFn: (r: ResolvedPatternRec) => string | null,
  labelFn: (key: string) => string = (k) => k,
): PatternSegment[] {
  const groups = new Map<string, ResolvedPatternRec[]>()
  for (const rec of recs) {
    const key = keyFn(rec)
    if (key === null) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(rec)
    else groups.set(key, [rec])
  }

  return [...groups.entries()]
    .map(([key, rs]) => ({ key, label: labelFn(key), card: summarizePattern(rs) }))
    .filter((s) => s.card.settled >= MIN_PATTERN_SAMPLE)
    .sort((a, b) => b.card.avgReturnPct - a.card.avgReturnPct)
}

/**
 * "이 탭을 따라가면 돈을 버나"에 대한 한 줄 답. 눌림목과 같은 Verdict 어휘를 쓰되
 * 기준은 R이 아니라 %다. 표본 20건 미만은 운으로 뒤집히는 범위라 단정하지 않는다.
 */
export function patternVerdictOf(card: PatternScorecard): Verdict {
  if (card.settled < 20) return 'insufficient'
  if (card.avgReturnPct <= 0) return 'negative'
  // 평균은 플러스인데 중간값이 마이너스면 소수 종목이 끌어올린 것이라 '약한 우위'로만 본다.
  if (card.skewed || card.avgReturnPct < 5) return 'marginal'
  return 'positive'
}

// ── 특성별 구간 나누기 (2·3번 개선안 검증용) ────────────────────────────
//
// 『매매의 기술』("저점에서 오래 매수 기회를 주면 추가 하락한다")과 『친절한
// 주가차트책』("바닥권 장기 횡보 후 밀집하면 힘있게 상승")이 정면으로 충돌하는
// 지점이 소진일수다. 어느 쪽이 맞는지는 책으로 못 정하므로 이 구간별 성적으로 본다.

/** `days_since_low` 구간. 코드의 만점 기준이 60일이라 그 앞뒤로 나눈다. */
export function daysSinceLowBucket(days: number | null): string | null {
  if (days === null) return null
  if (days < 30) return '1'
  if (days < 45) return '2'
  if (days < 60) return '3'
  return '4'
}

export const DAYS_SINCE_LOW_LABEL: Record<string, string> = {
  '1': '15~29일',
  '2': '30~44일',
  '3': '45~59일',
  '4': '60일 이상',
}

/** 하락률 구간. 하드 필터가 55%부터라 그 위를 셋으로 나눈다. */
export function drawdownBucket(pct: number | null): string | null {
  if (pct === null) return null
  if (pct < 65) return '1'
  if (pct < 75) return '2'
  return '3'
}

export const DRAWDOWN_LABEL: Record<string, string> = {
  '1': '55~65%',
  '2': '65~75%',
  '3': '75% 이상',
}

/** 순위 구간. 점수가 높은 후보가 실제로 더 나았는지 = 점수 공식이 작동하는지. */
export function rankBucket(rank: number): string {
  if (rank <= 5) return '1'
  if (rank <= 10) return '2'
  return '3'
}

export const RANK_LABEL: Record<string, string> = {
  '1': '1~5위',
  '2': '6~10위',
  '3': '11위 이하',
}
