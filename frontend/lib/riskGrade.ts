import type { RiskFrame } from './risk'

// 손익비 색상 기준.
//
// 목표가는 차트에 실제로 있는 저항을 우선 쓰고(최소 1R 이상 떨어진 것만),
// 위쪽에 그런 저항이 없을 때만 임팩트를 투영하며 어떤 경우에도 4R을 넘지 않는다.
// 그 결과 손익비는 대체로 1.0~3.0 범위에 들어온다.
//
// 박스 기준(횡보 종목)은 목표가 박스 상단으로 제한돼 구조적으로 낮게 나오므로
// 같은 잣대를 대면 전부 빨강이 된다. 틀에 맞는 기준을 따로 둔다.
export const RR_THRESHOLDS: Record<RiskFrame, { good: number; fair: number }> = {
  trend: { good: 2.5, fair: 1.5 },
  range: { good: 2.0, fair: 1.5 },
}

export type RiskGrade = 'good' | 'fair' | 'poor'

export function riskGrade(riskReward: number, frame: RiskFrame): RiskGrade {
  const { good, fair } = RR_THRESHOLDS[frame]
  if (riskReward >= good) return 'good'
  if (riskReward >= fair) return 'fair'
  return 'poor'
}

// 빨강·파랑은 등락 방향 전용이다(상승=빨강, 하락=파랑). 손익비 품질에 그 두 색을 쓰면
// 숫자가 등락률로 오독되므로, 품질은 색조가 아니라 글자의 진하기로 표현한다.
// 좋은 손익비는 진하게 눈에 들어오고, 낮은 손익비는 흐리게 물러난다.
export const RISK_GRADE_CLASS: Record<RiskGrade, string> = {
  good: 'text-foreground',
  fair: 'text-secondary-foreground',
  poor: 'text-muted-foreground',
}

/** 계산 틀 라벨 — 추세 종목과 횡보 종목의 숫자를 섞어 읽지 않도록 표시한다. */
export const RISK_FRAME_LABEL: Record<RiskFrame, string> = {
  trend: '추세 기준',
  range: '박스 기준',
}
