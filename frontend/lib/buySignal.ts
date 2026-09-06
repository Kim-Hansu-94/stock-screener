// 횡보·조정 매력도 점수를 매수 판단 등급으로 환산한다.
// 횡보·조정 카드와 감시 종목 카드가 같은 기준을 쓰도록 이 파일 하나로 모은다.
//
// 저점 높이기를 점수와 별개의 필수 조건으로 둔 이유: 나머지 항목(매도 소진 ·
// 변동성 수축 · 거래량 소진)은 "조용해졌다"만 말해줄 뿐, 하락이 멈추고 방향이
// 돌았다는 것을 직접 보는 항목은 저점 높이기뿐이다. 점수만 높고 저점이 계속
// 낮아지는 종목은 아직 바닥이 아니다.

export type BuyGrade = 'strong' | 'consider' | 'watch'

/** 적극 검토 하한 — 4대 요소가 대부분 충족되고 전환 신호까지 붙은 수준 */
export const STRONG_SCORE = 0.8
/** 매수 검토 하한 — 저점 높이기 + 매도 소진 + 수축 + 거래량 소진이 모두 모여야 도달 */
export const CONSIDER_SCORE = 0.7

export function buyGrade(score: number | null, higherLows: boolean | null): BuyGrade {
  if (score === null || !higherLows) return 'watch'
  if (score >= STRONG_SCORE) return 'strong'
  if (score >= CONSIDER_SCORE) return 'consider'
  return 'watch'
}

export const BUY_GRADE_LABEL: Record<BuyGrade, string> = {
  strong: '적극 검토',
  consider: '매수 검토',
  watch: '관망',
}

/** 배지 스타일 — 등급이 한눈에 구분되도록 색을 달리한다. */
export const BUY_GRADE_CLASS: Record<BuyGrade, string> = {
  strong: 'bg-primary text-primary-foreground',
  consider: 'bg-accent text-accent-foreground',
  watch: 'bg-muted text-muted-foreground',
}

/** 기준을 화면에 그대로 노출할 때 쓰는 설명 문구 */
export const BUY_GRADE_CRITERIA =
  `매력도 ${Math.round(STRONG_SCORE * 100)}점 이상 = 적극 검토, ` +
  `${Math.round(CONSIDER_SCORE * 100)}점 이상 = 매수 검토. ` +
  `두 등급 모두 "저점 높이기"가 충족돼야 하며, 미충족 시 점수와 무관하게 관망입니다.`

// ── 후보 신선도 ──
// 매력도 점수는 저점 이후 최소 몇 달은 조용해야 오르는 구조라(opportunityScore.ts의
// EXHAUSTION_CAP_DAYS 등), 점수만 보면 항상 "어느 정도 오른 뒤"에야 눈에 띈다.
// qualified_since(하드필터를 이어서 계속 통과 중인 구간의 시작일)를 따로 노출해,
// 점수가 아직 낮아도 "오늘 막 바닥을 다지기 시작한" 종목을 구분해 보여준다.

/** 이 안이면 "신규 진입"으로 강조 표시한다. */
export const NEW_ENTRY_WINDOW_DAYS = 3

/** qualifiedSince(YYYY-MM-DD)부터 오늘까지 며칠째인지. 데이터 없으면 null. */
export function daysSinceQualified(qualifiedSince: string | null, today: Date = new Date()): number | null {
  if (!qualifiedSince) return null
  const then = new Date(`${qualifiedSince}T00:00:00Z`)
  if (Number.isNaN(then.getTime())) return null
  const startOfToday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  return Math.max(0, Math.round((startOfToday.getTime() - then.getTime()) / 86_400_000))
}

/** 후보로 처음 뜬 지 NEW_ENTRY_WINDOW_DAYS일 이내인지 — 참/거짓 판정에 데이터 없음(null)까지 포함. */
export function isNewEntry(qualifiedSince: string | null, today?: Date): boolean {
  const days = daysSinceQualified(qualifiedSince, today)
  return days !== null && days <= NEW_ENTRY_WINDOW_DAYS
}
