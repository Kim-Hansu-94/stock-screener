// 등락 색 규칙 한 곳 모음.
//
// 한국 증권 관례는 상승=빨강, 하락=파랑이다(토스증권도 동일). 서양식(상승=초록)으로
// 쓰지 않는다. 예전에는 컴포넌트마다 text-green-600 / text-red-500을 직접 골라 써서
// TrackRecordCard만 한국식, 나머지는 서양식으로 갈라져 있었다. 색은 여기서만 정한다.
//
// 실제 색값은 globals.css의 --up / --down 토큰이다.

/** 등락률·수익률처럼 "가격이 어느 방향으로 움직였는지"를 나타내는 숫자의 글자색 */
export function changeTextClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-muted-foreground'
  return value > 0 ? 'text-up' : 'text-down'
}

/** 같은 의미의 알약 배지(연한 배경 + 진한 글자) */
export function changeTintClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'bg-muted text-muted-foreground'
  return value > 0 ? 'bg-up/10 text-up' : 'bg-down/10 text-down'
}

/** 상승장/하락장도 가격 방향이므로 같은 규칙을 따른다 */
export function regimeTintClass(isBull: boolean): string {
  return isBull ? 'bg-up/10 text-up' : 'bg-down/10 text-down'
}

// 손절가는 현재가보다 아래(하락), 목표가는 위(상승)다. "위험=빨강"이라는 서양식 감각을
// 끌어오면 앱 안에서 빨강이 '상승'과 '위험' 두 뜻을 갖게 되므로 여기서도 방향으로 통일한다.
// 즉 손절=파랑, 목표=빨강. 라벨에 '손절'/'목표'를 항상 붙여 어느 쪽인지 못 헷갈리게 한다.
export const STOP_TEXT = 'text-down'
export const TARGET_TEXT = 'text-up'

/** 부호를 항상 붙인 퍼센트 표기 (예: +2.14%, −4.10%) */
export function formatSignedPercent(pct: number, digits = 2): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : ''
  return `${sign}${Math.abs(pct).toFixed(digits)}%`
}

/** 두 가격의 차이를 퍼센트로 (목표가가 현재가보다 몇 % 위인지 등) */
export function signedPercentBetween(price: number, base: number, digits = 1): string {
  if (base === 0) return '—'
  return formatSignedPercent(((price - base) / base) * 100, digits)
}
