import type { RiskFrame } from './risk'

// 손익비 색상 기준.
//
// 목표가를 "진입가 위 가장 가까운 저항"에서 "임팩트 투영"으로 바꾸면서 목표가
// 전반적으로 멀어졌고, 그만큼 손익비 수치도 함께 올라갔다. 예전 기준(2.0 초록)을
// 그대로 두면 대부분이 초록이 되어 변별력이 사라지므로 한 단계씩 올린다.
//
// 박스 기준(횡보 종목)은 목표가 박스 상단으로 제한돼 구조적으로 낮게 나오므로
// 같은 잣대를 대면 전부 빨강이 된다. 틀에 맞는 기준을 따로 둔다.
export const RR_THRESHOLDS: Record<RiskFrame, { good: number; fair: number }> = {
  trend: { good: 3.0, fair: 2.0 },
  range: { good: 2.0, fair: 1.5 },
}

export type RiskGrade = 'good' | 'fair' | 'poor'

export function riskGrade(riskReward: number, frame: RiskFrame): RiskGrade {
  const { good, fair } = RR_THRESHOLDS[frame]
  if (riskReward >= good) return 'good'
  if (riskReward >= fair) return 'fair'
  return 'poor'
}

export const RISK_GRADE_CLASS: Record<RiskGrade, string> = {
  good: 'text-green-600',
  fair: 'text-amber-500',
  poor: 'text-red-500',
}

/** 계산 틀 라벨 — 추세 종목과 횡보 종목의 숫자를 섞어 읽지 않도록 표시한다. */
export const RISK_FRAME_LABEL: Record<RiskFrame, string> = {
  trend: '추세 기준',
  range: '박스 기준',
}
