/**
 * 하락률 → **권장 관찰 기간** 배지.
 *
 * 근거는 `DailyReport.tsx`의 `CriteriaLegend`가 보여주는 깊이별 승률 표와 **같은 백테스트**다 — 3개월(60일) 승률은
 * 깊어질수록 떨어지고(64.1% → 60.3%) 1년(250일) 승률은 올라간다(74.5% → 81.0%).
 * 즉 깊게 빠진 종목은 나쁜 게 아니라 느리다. 점수는 보유 기간을 모르므로, 기간 힌트만
 * 카드에 따로 붙인다.
 *
 * 경계값(65%·70%)은 안내 문구에 적힌 것과 **반드시 같아야** 한다 — 갈라지면 카드와 설명이
 * 다른 말을 한다. 65~70%는 두 규칙 사이 구간이라 어느 쪽도 단정하지 않는다.
 * `drawdownPct`는 컬럼 추가(`supabase/pattern_match_results_drawdown.sql`) 전에는 null이고,
 * 그때는 배지를 아예 안 붙인다(모르는 값을 '3개월'로 단정하지 않는다).
 */
export function holdHint(
  drawdownPct: number | null,
): { label: string; title: string; className: string } | null {
  if (drawdownPct === null || !Number.isFinite(drawdownPct)) return null
  const pct = Math.abs(drawdownPct)
  if (pct < 65) {
    return {
      label: '⏳ 3개월',
      title: `하락률 ${pct.toFixed(0)}% — 얕은 편입니다. 백테스트에서 이 구간은 3개월 승률이 가장 높았습니다(64.1%). 3개월 안에 결판이 나는 편입니다.`,
      className: 'border-sky-300 text-sky-700',
    }
  }
  if (pct < 70) {
    return {
      label: '⏳ 3~12개월',
      title: `하락률 ${pct.toFixed(0)}% — 3개월 규칙과 1년 규칙의 경계 구간입니다. 3개월 승률 62.1%, 1년 승률 78.8%.`,
      className: 'border-indigo-300 text-indigo-700',
    }
  }
  return {
    label: '⏳ 1년',
    title: `하락률 ${pct.toFixed(0)}% — 깊습니다. 3개월로 보면 승률이 가장 낮지만(60.3%) 1년으로 보면 가장 높습니다(81.0%). 나쁜 게 아니라 느린 종목이니 1년을 보고 들어가야 합니다.`,
    className: 'border-violet-300 text-violet-700',
  }
}
