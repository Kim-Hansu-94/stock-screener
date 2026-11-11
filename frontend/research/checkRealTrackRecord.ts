/**
 * **사이트가 실제로 "사라"고 말한 것들의 실전 성적을 그대로 뽑는 진단.**
 *
 * 왜 필요한가
 * -----------
 * 2026-11-11에 지지신호 5개와 전환 신호 후보 7개를 백테스트로 재고 "우위가 없다"고
 * 보고했는데, 사용자가 **"그럼 지금까지 매수신호라고 보여준 게 전부 나쁜 신호였냐"**고
 * 물었다. 정직한 답은 "그 둘은 매수 추천이 아니었고(포지션 카드는 화면에 그렇게 적혀
 * 있다), 7개는 아예 사이트에 없었다 — 하지만 **실제 매수 추천 세 개는 내가 안 재봤다**"다.
 *
 * 그 세 개가 이것이다. 백테스트 가정이 아니라 **실제로 추천했던 종목의 실제 결과**다:
 *
 *   1. 눌림목 스크리너 (`screened_stocks`) → `scorecard.ts`로 R 기댓값
 *   2. 저점 매집 후보 (`recommendation_history`) → `patternScorecard.ts`로 보유 수익률
 *
 * **쿼리를 복붙하지 않는다.** 화면(`app/history/page.tsx`)이 쓰는 `getScorecardTrades`·
 * `getPatternRecommendations`를 그대로 import하고, 집계도 화면과 같은 `summarize`·
 * `summarizePattern`·`segmentBy`를 쓴다 — `next/cache`만 `stubNextCache.mjs`로
 * 무력화한다(캐시된 옛 값이 아니라 지금 DB를 읽게 되니 진단에는 오히려 맞다).
 * 그래서 이 출력은 **`/history` 탭이 지금 보여주는 숫자와 같아야 한다.**
 *
 * 읽기만 한다 — DB·사이트에 아무것도 쓰지 않는다.
 *
 * 실행: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
 *   node --import ./research/resolveTsImports.mjs \
 *        --import ./research/stubNextCache.mjs research/checkRealTrackRecord.ts
 */

import { getScorecardTrades, getPatternRecommendations } from '../lib/queries/performance.ts'
import {
  segmentBy,
  summarize,
  verdictOf,
  MAX_HOLD_BARS,
  MIN_SEGMENT_SAMPLE,
  type ResolvedTrade,
  type Scorecard,
} from '../lib/scorecard.ts'
import {
  segmentPatternBy,
  summarizePattern,
  patternVerdictOf,
  PATTERN_HOLD_BARS,
  MIN_PATTERN_SAMPLE,
  type ResolvedPatternRec,
  type PatternScorecard,
} from '../lib/patternScorecard.ts'

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY 가 필요합니다.')
  process.exit(1)
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const num = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
const num2 = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
const line = (c = '─') => console.log(c.repeat(92))

const VERDICT_LABEL: Record<string, string> = {
  insufficient: '표본 부족 — 판단 불가',
  negative: '마이너스 — 따라가면 손해',
  marginal: '간신히 본전권 — 우위 불명확',
  positive: '플러스 — 우위 있음',
}

function printScorecard(title: string, card: Scorecard) {
  console.log(`\n▶ ${title}`)
  if (card.resolved === 0) {
    console.log(`  판정 완료 0건 (판정 대기 ${card.pending}건) — 집계할 게 없다`)
    return
  }
  console.log(
    `  판정 완료 ${card.resolved}건 (대기 ${card.pending}건) · 목표도달 ${card.targetHits} / 손절 ${card.stops} / 기간만료 ${card.timeouts}`,
  )
  console.log(
    `  **기댓값 ${num(card.expectancyR)}R** (추천 1건당, 손절폭 배수) · 총 ${num(card.totalR)}R · 평균 보유 ${card.avgHoldingDays.toFixed(1)}일`,
  )
  console.log(
    `  목표도달률 ${pct(card.hitRate)} vs 손익분기선 ${pct(card.breakevenHitRate)} → ${
      card.hitRate > card.breakevenHitRate ? '기준선 위' : '기준선 아래'
    }`,
  )
  console.log(`  판정: ${VERDICT_LABEL[verdictOf(card)] ?? verdictOf(card)}`)
}

function printPatternCard(title: string, card: PatternScorecard) {
  console.log(`\n▶ ${title}`)
  if (card.settled === 0) {
    console.log(`  판정 완료 0건 (관찰 기간 미달 ${card.pending}건) — 집계할 게 없다`)
    return
  }
  console.log(`  판정 완료 ${card.settled}건 (기간 미달 ${card.pending}건)`)
  console.log(
    `  **중간값 ${num2(card.medianReturnPct)}% · 평균 ${num2(card.avgReturnPct)}%** · 승률 ${card.winRate.toFixed(1)}% (기준선 50%)`,
  )
  console.log(
    `  크게 오름(+30% 이상) ${card.bigWinRate.toFixed(1)}% · 크게 빠짐(-30% 이하) ${card.bigLossRate.toFixed(1)}%`,
  )
  console.log(
    `  관찰 중 최고 ${num2(card.avgMaxGainPct)}% / 최저 ${num2(card.avgMaxDropPct)}% (버티려면 견뎌야 했던 폭)`,
  )
  if (card.skewed) {
    console.log('  ⚠ 평균과 중간값의 부호가 다르다 — 소수 종목이 평균을 끌고 간 상태')
  }
  console.log(`  판정: ${VERDICT_LABEL[patternVerdictOf(card)] ?? patternVerdictOf(card)}`)
}

function patternRow(label: string, card: PatternScorecard): string {
  return (
    `    ${label.padEnd(12)}${String(card.settled).padStart(4)}건  ` +
    `중간값 ${num2(card.medianReturnPct).padStart(7)}%  평균 ${num2(card.avgReturnPct).padStart(7)}%  ` +
    `승률 ${card.winRate.toFixed(1).padStart(5)}%  최저 ${num2(card.avgMaxDropPct).padStart(7)}%`
  )
}

async function main() {
  line('=')
  console.log('사이트가 실제로 "사라"고 말한 것들의 실전 성적')
  console.log(`(눌림목 판정기간 ${MAX_HOLD_BARS}거래일 · 저점매집 ${PATTERN_HOLD_BARS}거래일)`)
  line('=')

  // ── 1. 눌림목 스크리너 ───────────────────────────────────────────────
  const [kr, us] = await Promise.all([getScorecardTrades('KR'), getScorecardTrades('US')])
  console.log(`\n### 1. 눌림목 스크리너 — 원본 추천 KR ${kr.length}건 / US ${us.length}건`)
  printScorecard('한국 시장', summarize(kr))
  printScorecard('미국 시장', summarize(us))
  printScorecard('KR+US 합계', summarize([...kr, ...us]))

  // 미달 조건 개수별 — 화면에 실제로 뜨는 건 미달이 적은 상위 후보들이다.
  for (const [label, trades] of [['한국', kr], ['미국', us]] as [string, ResolvedTrade[]][]) {
    const segs = segmentBy(trades, (t) => (t.missCount === 0 ? '전 조건 통과' : `미달 ${t.missCount}개`))
    if (segs.length === 0) continue
    console.log(`\n  [${label}] 미달 조건 개수별 (표본 ${MIN_SEGMENT_SAMPLE}건 미만은 빠짐)`)
    for (const s of segs) {
      console.log(
        `    ${s.label.padEnd(14)} ${String(s.card.resolved).padStart(4)}건  기댓값 ${num(s.card.expectancyR)}R  목표도달 ${pct(s.card.hitRate)}`,
      )
    }
  }

  // 장세별 — "어떤 상황에서 잘 맞나"
  for (const [label, trades] of [['한국', kr], ['미국', us]] as [string, ResolvedTrade[]][]) {
    const segs = segmentBy(trades, (t) => (t.regime === 'bull' ? '상승장' : t.regime === 'bear' ? '하락장' : '중립'))
    if (segs.length === 0) continue
    console.log(`\n  [${label}] 장세별`)
    for (const s of segs) {
      console.log(
        `    ${s.label.padEnd(14)} ${String(s.card.resolved).padStart(4)}건  기댓값 ${num(s.card.expectancyR)}R  목표도달 ${pct(s.card.hitRate)}`,
      )
    }
  }

  // ── 2. 저점 매집 후보 ────────────────────────────────────────────────
  line()
  const recs: ResolvedPatternRec[] = await getPatternRecommendations()
  console.log(`\n### 2. 저점 매집 후보 — 원본 추천 ${recs.length}건`)
  printPatternCard('전체', summarizePattern(recs))

  // 점수 구간별 — 2026-09-14에 "점수 상위가 오히려 나쁘다"를 고친 그 축이다.
  // **점수 스케일을 가정하지 않는다**: 타입 주석은 0~1인데 CLAUDE.md는 '70점 이상'으로
  // 적혀 있어 둘이 어긋난다. 실제 값의 범위를 먼저 찍고 그에 맞춰 구간을 나눈다.
  const scores = recs
    .map((r) => r.features.score)
    .filter((v): v is number => v != null)
  if (scores.length === 0) {
    console.log('\n  점수 구간별: features.score가 전부 비어 있다 (특성 컬럼이 안 채워졌을 수 있다)')
  } else {
    const lo = Math.min(...scores)
    const hi = Math.max(...scores)
    console.log(`\n  점수 실측 범위: ${lo.toFixed(3)} ~ ${hi.toFixed(3)} (${scores.length}건에 값 있음)`)
    const scale = hi <= 1.5 ? 100 : 1 // 0~1 스케일이면 100을 곱해 점수로 본다
    const bands = segmentPatternBy(recs, (r) => {
      const v = r.features.score
      if (v == null) return null
      const pts = v * scale
      return pts >= 70 ? '70점 이상' : pts >= 60 ? '60~70점' : '60점 미만'
    })
    if (bands.length > 0) {
      console.log(`  점수 구간별 (표본 ${MIN_PATTERN_SAMPLE}건 미만은 빠짐)`)
      for (const b of bands) console.log(patternRow(b.label, b.card))
    }
  }

  // 하락률 구간별 — "깊게 빠진 종목은 나쁜 게 아니라 느리다"가 실전에서도 보이는지.
  const ddBands = segmentPatternBy(recs, (r) => {
    const d = r.features.drawdownPct
    if (d == null) return null
    const depth = Math.abs(d)
    return depth >= 70 ? '70% 이상 하락' : depth >= 50 ? '50~70% 하락' : '50% 미만 하락'
  })
  if (ddBands.length > 0) {
    console.log(`\n  추천 시점 하락률 구간별`)
    for (const b of ddBands) console.log(patternRow(b.label, b.card))
  }

  line('=')
  console.log('※ 이 숫자는 백테스트 가정이 아니라 실제로 추천했던 종목의 실제 결과다.')
  console.log('※ 화면이 쓰는 쿼리·집계 함수를 그대로 돌렸으므로 /history 탭과 같아야 한다.')
  console.log('※ 판정 대기(pending)는 집계에서 빠진다 — 손절이 목표보다 먼저 걸리는 구조라')
  console.log('  "청산된 것만" 세면 기댓값이 음수 쪽으로 치우치기 때문이다.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
