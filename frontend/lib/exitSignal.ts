import type { PriceBar } from './risk'
import { computeSMA, TREND_SMA_PERIOD } from './risk'

/**
 * "이제 팔 때"를 판정한다. 자동 매도는 하지 않고 알려주기만 한다.
 *
 * 신호가 뜬 날의 가격을 따로 저장하지 않는 게 설계의 핵심이다. 판정에 쓰는 재료
 * (장세·주도 섹터·일봉)가 전부 날짜별로 DB에 있어서, 진입일부터 하루씩 걸어가면
 * "언제 처음 신호가 떴는지"를 언제든 다시 계산할 수 있다. 스냅샷을 저장하는 방식은
 * 사이트에 안 들어온 날의 신호를 놓치고, 이미 사둔 종목에는 소급 적용도 안 된다.
 *
 * ── 컨셉별로 규칙이 다르다 ──────────────────────────────────────────
 * 눌림목(`pullback`)과 횡보·조정(`opportunity`)은 애초에 다른 것을 노리고 산 종목이라
 * 같은 잣대로 팔면 한쪽이 망가진다.
 *
 * - **눌림목**: 상승 추세 종목의 조정을 노린 단기 매매. 추세가 꺾이면 나와야 하므로
 *   장세·섹터·60일선 같은 정황 신호가 전부 의미가 있다.
 * - **횡보·조정**: 3년 고점 대비 20~60% 빠진 종목을 바닥에서 사서 오래 들고 가는 컨셉.
 *   이런 종목은 **구조상 60일선 아래에 있고 주도 섹터도 아니다**. 눌림목 규칙을 그대로
 *   적용하면 진입 다음 날 바로 매도 신호가 떴다(실제로 그랬다). 그래서 가격이 실제로
 *   닿은 것만 본다 — 손절·목표, 그리고 산 근거였던 바닥 자체가 무너졌을 때.
 */

/** 어느 화면에서 산 종목인지. `paper_trades.source`와 같은 값. */
export type TradeSource = 'pullback' | 'opportunity'

export type ExitReason =
  | 'stop'
  | 'target'
  | 'distribution'
  | 'breakdown'
  | 'bear'
  | 'sector'
  | 'trend'

/** 거래량이 최근 평균의 몇 배부터 "급증"으로 볼지. */
const VOLUME_SPIKE_MULT = 2
const VOLUME_AVG_WINDOW = 20
/** 바닥선을 잡는 창. opportunityScore의 BOX_WINDOW와 같은 값이어야 진입 논거와 대칭이 된다. */
const BASE_WINDOW = 60

export const EXIT_REASON_LABEL: Record<ExitReason, string> = {
  stop: '손절가 이탈',
  target: '목표가 도달',
  distribution: '대량거래 음봉 (물량 출회)',
  breakdown: '바닥 이탈 (박스 하단 하회)',
  bear: '시장이 하락장으로 전환',
  sector: '주도 섹터에서 이탈',
  trend: `${TREND_SMA_PERIOD}일 이동평균선 하회`,
}

/** 손절·목표는 가격이 실제로 닿은 것이라 확정 신호, 나머지는 정황 신호다. */
export const HARD_REASONS: ReadonlySet<ExitReason> = new Set<ExitReason>(['stop', 'target'])

export interface ExitSignal {
  date: string
  /** 그날 종가. 손절/목표에 닿은 경우엔 그 가격(체결 가정). */
  price: number
  reasons: ExitReason[]
}

export interface ExitScanInput {
  /** 진입일 이후 봉만. 60일선 계산에 필요한 과거 봉은 trailingBars로 따로 준다. */
  futureBars: PriceBar[]
  /** 진입일까지의 봉. 60일선을 진입 직후부터 계산할 수 있게 앞쪽 여유를 채운다. */
  trailingBars: PriceBar[]
  /** 눌림목이냐 횡보·조정이냐. 이 값에 따라 적용할 규칙이 갈린다. */
  source: TradeSource
  stop: number | null
  target: number | null
  sector: string
  /** 날짜 → 'bull' | 'bear' */
  regimeByDate: Record<string, string>
  /** 날짜 → 그날의 주도 섹터 집합. 그날 데이터가 없으면 판정을 건너뛴다. */
  leadingSectorsByDate: Record<string, string[]>
}

/**
 * 대량거래 음봉 — 『매매의 기술』 매도 1·2원칙.
 *
 * "5일선을 깨지 않고 상승하던 주식이 어느 날 거래량이 급증하면서 음봉을 만들면
 * 30~50% 정도 매도한다." 여기에 곰의 50% 룰(전일 봉의 중간값을 깨야 강한 매도)을
 * 더해 잔파동을 걸러낸다.
 *
 * open/volume이 없는 봉은 판정하지 않는다 — 주도 섹터 규칙과 같은 이유로,
 * 데이터 구멍을 매도 신호로 둔갑시키지 않기 위해서다.
 */
function isDistribution(window: PriceBar[]): boolean {
  const bar = window.at(-1)
  const prev = window.at(-2)
  if (!bar || !prev) return false
  if (bar.open === undefined || bar.volume === undefined) return false
  if (bar.close >= bar.open) return false // 음봉이 아니다

  const prior = window.slice(-(VOLUME_AVG_WINDOW + 1), -1)
  const vols = prior.map((b) => b.volume).filter((v): v is number => v !== undefined)
  if (vols.length < VOLUME_AVG_WINDOW) return false

  const avgVolume = vols.reduce((a, b) => a + b, 0) / vols.length
  if (avgVolume <= 0 || bar.volume < avgVolume * VOLUME_SPIKE_MULT) return false

  // 곰의 50% 룰 — 전일 봉의 50% 지점을 종가가 깨야 매도세가 이긴 것으로 본다.
  return bar.close < (prev.high + prev.low) / 2
}

/**
 * 진입 시점의 바닥선. 포지션이 늙어도 이 값은 움직이지 않아야 "내가 산 근거였던
 * 바닥이 무너졌나"를 그대로 검증할 수 있다.
 *
 * 이게 필요한 이유: 횡보·조정에서 정황 신호를 빼고 나면 손절·목표만 남는데,
 * `computeStopTarget`은 `stop_above_entry`/`no_upside`일 때 둘 다 null을 준다.
 * 그 경우 매도 신호가 아예 없어지므로 바닥선이 최후의 방어선이 된다.
 */
function entryBaseLow(trailingBars: PriceBar[]): number | null {
  if (trailingBars.length < BASE_WINDOW) return null
  return Math.min(...trailingBars.slice(-BASE_WINDOW).map((b) => b.low))
}

/**
 * 진입 후 처음으로 매도 신호가 뜬 날을 찾는다. 없으면 null(계속 보유).
 *
 * 주의: 주도 섹터는 매일 다시 뽑히므로 하루 이틀 들락날락할 수 있다. 여기서는 "처음
 * 걸린 날"을 그대로 신호로 본다 — 며칠 연속 유지를 요구하면 신호가 늦어져서, 빨리
 * 알려주는 쪽을 택했다. 대신 사유를 같이 보여주니 사람이 판단할 수 있다.
 */
export function findExitSignal(input: ExitScanInput): ExitSignal | null {
  const { futureBars, trailingBars, source, stop, target, sector } = input
  const { regimeByDate, leadingSectorsByDate } = input

  // 60일선은 진입 이전 봉까지 이어 붙여야 진입 직후에도 계산된다.
  const window: PriceBar[] = [...trailingBars]
  const baseLow = source === 'opportunity' ? entryBaseLow(trailingBars) : null

  for (const bar of futureBars) {
    window.push(bar)
    const reasons: ExitReason[] = []

    // 가격이 실제로 닿은 것 — 그 가격에 체결됐다고 본다. 두 컨셉 공통.
    if (stop !== null && bar.low <= stop) {
      return { date: bar.date, price: stop, reasons: ['stop'] }
    }
    if (target !== null && bar.high >= target) {
      return { date: bar.date, price: target, reasons: ['target'] }
    }

    if (source === 'opportunity') {
      // 장기 보유 컨셉 — 가격만 본다. 하락장·섹터 이탈은 오히려 매수 근거에 가깝고,
      // 60일선 하회는 이 종목들의 정상 상태라 신호가 될 수 없다.
      if (baseLow !== null && bar.close < baseLow) reasons.push('breakdown')
    } else {
      if (isDistribution(window)) reasons.push('distribution')

      if (regimeByDate[bar.date] === 'bear') reasons.push('bear')

      const leaders = leadingSectorsByDate[bar.date]
      // 그날 주도 섹터 데이터가 없으면(파이프라인 미실행 등) 판정하지 않는다.
      // 없는 걸 '이탈'로 세면 데이터 구멍이 매도 신호로 둔갑한다.
      if (leaders && leaders.length > 0 && sector && !leaders.includes(sector)) {
        reasons.push('sector')
      }

      const sma = computeSMA(window, TREND_SMA_PERIOD)
      if (sma !== null && bar.close < sma) reasons.push('trend')
    }

    if (reasons.length > 0) return { date: bar.date, price: bar.close, reasons }
  }

  return null
}

/** 신호가 뜬 날 팔았다면 몇 %였을지. */
export function signalReturnPct(entryPrice: number, signal: ExitSignal): number {
  return ((signal.price - entryPrice) / entryPrice) * 100
}
