import type { PriceBar } from './risk'
import { computeSMA, TREND_SMA_PERIOD } from './risk'

/**
 * "이제 팔 때"를 판정한다. 자동 매도는 하지 않고 알려주기만 한다.
 *
 * 신호가 뜬 날의 가격을 따로 저장하지 않는 게 설계의 핵심이다. 판정에 쓰는 재료
 * (장세·주도 섹터·일봉)가 전부 날짜별로 DB에 있어서, 진입일부터 하루씩 걸어가면
 * "언제 처음 신호가 떴는지"를 언제든 다시 계산할 수 있다. 스냅샷을 저장하는 방식은
 * 사이트에 안 들어온 날의 신호를 놓치고, 이미 사둔 종목에는 소급 적용도 안 된다.
 */

export type ExitReason = 'stop' | 'target' | 'bear' | 'sector' | 'trend'

export const EXIT_REASON_LABEL: Record<ExitReason, string> = {
  stop: '손절가 이탈',
  target: '목표가 도달',
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
  stop: number | null
  target: number | null
  sector: string
  /** 날짜 → 'bull' | 'bear' */
  regimeByDate: Record<string, string>
  /** 날짜 → 그날의 주도 섹터 집합. 그날 데이터가 없으면 판정을 건너뛴다. */
  leadingSectorsByDate: Record<string, string[]>
}

/**
 * 진입 후 처음으로 매도 신호가 뜬 날을 찾는다. 없으면 null(계속 보유).
 *
 * 주의: 주도 섹터는 매일 다시 뽑히므로 하루 이틀 들락날락할 수 있다. 여기서는 "처음
 * 걸린 날"을 그대로 신호로 본다 — 며칠 연속 유지를 요구하면 신호가 늦어져서, 빨리
 * 알려주는 쪽을 택했다. 대신 사유를 같이 보여주니 사람이 판단할 수 있다.
 */
export function findExitSignal(input: ExitScanInput): ExitSignal | null {
  const { futureBars, trailingBars, stop, target, sector, regimeByDate, leadingSectorsByDate } = input

  // 60일선은 진입 이전 봉까지 이어 붙여야 진입 직후에도 계산된다.
  const window: PriceBar[] = [...trailingBars]

  for (const bar of futureBars) {
    window.push(bar)
    const reasons: ExitReason[] = []

    // 가격이 실제로 닿은 것 — 그 가격에 체결됐다고 본다.
    if (stop !== null && bar.low <= stop) {
      return { date: bar.date, price: stop, reasons: ['stop'] }
    }
    if (target !== null && bar.high >= target) {
      return { date: bar.date, price: target, reasons: ['target'] }
    }

    if (regimeByDate[bar.date] === 'bear') reasons.push('bear')

    const leaders = leadingSectorsByDate[bar.date]
    // 그날 주도 섹터 데이터가 없으면(파이프라인 미실행 등) 판정하지 않는다.
    // 없는 걸 '이탈'로 세면 데이터 구멍이 매도 신호로 둔갑한다.
    if (leaders && leaders.length > 0 && sector && !leaders.includes(sector)) {
      reasons.push('sector')
    }

    const sma = computeSMA(window, TREND_SMA_PERIOD)
    if (sma !== null && bar.close < sma) reasons.push('trend')

    if (reasons.length > 0) return { date: bar.date, price: bar.close, reasons }
  }

  return null
}

/** 신호가 뜬 날 팔았다면 몇 %였을지. */
export function signalReturnPct(entryPrice: number, signal: ExitSignal): number {
  return ((signal.price - entryPrice) / entryPrice) * 100
}
