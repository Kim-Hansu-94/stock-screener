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
import { createServerSupabaseClient } from '../lib/supabase.ts'
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

/**
 * 기댓값의 **표준오차와 95% 신뢰구간**.
 *
 * 왜 이걸 같이 찍나 — 이게 없으면 "마이너스다"를 단정할 수 없다
 * ------------------------------------------------------------
 * 눌림목 성적은 손절 -1R과 목표 +2R 이상이 섞인 분포라 **건당 변동이 1R을 넘는다.**
 * 그런 분포에서 55건의 평균은 표준오차가 0.2R 가까이 나오므로, -0.163R이라는 숫자
 * 하나만 보고 "따라가면 손해"라고 말하면 **표본 잡음을 알고리즘 성질로 착각**할 수 있다.
 * (이 저장소가 세 번 겪은 실수와 같은 모양이다 — 부호가 표본·지평선마다 뒤집히는 것.)
 *
 * 그래서 구간이 0을 품으면 "마이너스로 확인됐다"가 아니라 **"플러스라고도 마이너스라고도
 * 말할 수 없다"**가 정직한 결론이고, 그 경우 필요한 건 조건 수정이 아니라 표본이다.
 * `needed`는 지금 관측된 변동폭에서 그 크기의 효과를 95%로 가리려면 몇 건이 필요한지다.
 */
function confidence(trades: ResolvedTrade[]) {
  const rs = trades.filter((t) => t.outcome !== 'pending' && t.r !== null).map((t) => t.r as number)
  const n = rs.length
  if (n < 2) return null
  const mean = rs.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
  const se = sd / Math.sqrt(n)
  return {
    n, mean, sd, se,
    lo: mean - 1.96 * se,
    hi: mean + 1.96 * se,
    straddlesZero: mean - 1.96 * se < 0 && mean + 1.96 * se > 0,
    needed: mean === 0 ? Infinity : Math.ceil((1.96 * sd / Math.abs(mean)) ** 2),
  }
}

function printConfidence(trades: ResolvedTrade[], indent = '  ') {
  const ci = confidence(trades)
  if (!ci) {
    console.log(`${indent}신뢰구간: 표본 2건 미만 — 계산 불가`)
    return
  }
  console.log(
    `${indent}건당 변동 ±${ci.sd.toFixed(3)}R (표준편차) → 표준오차 ${ci.se.toFixed(3)}R`,
  )
  console.log(
    `${indent}**95% 신뢰구간 ${num(ci.lo)}R ~ ${num(ci.hi)}R** → ${
      ci.straddlesZero
        ? `0을 품는다: 플러스인지 마이너스인지 **이 표본으로는 말할 수 없다** (가리려면 약 ${ci.needed}건 필요)`
        : ci.hi < 0
          ? '구간이 전부 0 아래 — 마이너스가 표본 탓은 아니다'
          : '구간이 전부 0 위 — 플러스가 표본 탓은 아니다'
    }`,
  )
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
  // winRate·bigWinRate·bigLossRate는 **0~1 비율**이다(patternScorecard의 `rate`가
  // n/done.length를 돌려준다). 처음에 .toFixed(1)에 %를 붙여 승률 36%가 '0.4%'로
  // 찍혔다 — scorecard 쪽 hitRate는 pct()로 ×100 하는데 여기만 빠뜨린 것이다.
  console.log(
    `  **중간값 ${num2(card.medianReturnPct)}% · 평균 ${num2(card.avgReturnPct)}%** · 승률 ${pct(card.winRate)} (기준선 50%)`,
  )
  console.log(
    `  크게 오름(+30% 이상) ${pct(card.bigWinRate)} · 크게 빠짐(-30% 이하) ${pct(card.bigLossRate)}`,
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
    `승률 ${pct(card.winRate).padStart(6)}  최저 ${num2(card.avgMaxDropPct).padStart(7)}%`
  )
}

async function main() {
  line('=')
  console.log('사이트가 실제로 "사라"고 말한 것들의 실전 성적')
  console.log(`(눌림목 판정기간 ${MAX_HOLD_BARS}거래일 · 저점매집 ${PATTERN_HOLD_BARS}거래일)`)
  line('=')

  // ── 0. 추천 이력이 얼마나 쌓여 있나 ──────────────────────────────────
  // 성적 화면은 기본 180일만 본다(`getScorecardTrades`의 days=180). 그 창에서 KR이
  // 55건뿐인 이유는 **하루 최대 5종목**(`pipeline.py`의 TOP_CANDIDATES)에 **종목당 첫
  // 추천 1건만** 세기 때문이다. 표가 더 길게 남아 있다면 같은 함수를 더 긴 창으로
  // 돌려 표본을 늘릴 수 있으므로, 먼저 실제 보유 기간을 찍는다.
  const supabase = createServerSupabaseClient()
  console.log('\n### 0. screened_stocks에 실제로 쌓인 추천 이력')
  for (const market of ['KR', 'US'] as const) {
    const [first, last, counted] = await Promise.all([
      supabase.from('screened_stocks').select('date').eq('market', market).order('date').limit(1),
      supabase.from('screened_stocks').select('date').eq('market', market)
        .order('date', { ascending: false }).limit(1),
      supabase.from('screened_stocks').select('*', { count: 'exact', head: true }).eq('market', market),
    ])
    const a = first.data?.[0]?.date
    const b = last.data?.[0]?.date
    const span = a && b
      ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000)
      : 0
    console.log(`  ${market}: ${counted.count ?? 0}행 · ${a ?? '?'} ~ ${b ?? '?'} (${span}일)`)
  }

  // ── 1. 눌림목 스크리너 ───────────────────────────────────────────────
  const [kr, us] = await Promise.all([getScorecardTrades('KR'), getScorecardTrades('US')])
  console.log(`\n### 1. 눌림목 스크리너 (화면 기본 창 180일) — 원본 추천 KR ${kr.length}건 / US ${us.length}건`)
  printScorecard('한국 시장', summarize(kr))
  printConfidence(kr, '    ')
  printScorecard('미국 시장', summarize(us))
  printConfidence(us, '    ')
  printScorecard('KR+US 합계', summarize([...kr, ...us]))
  printConfidence([...kr, ...us], '    ')

  // ── 1-a. 창 길이를 늘리면 결론이 유지되나 ───────────────────────────
  // 같은 함수에 days만 바꿔 넣는다 — 쿼리를 복붙하지 않는다. 주의: `getScorecardTrades`는
  // **창 안의 첫 추천만** 종목당 1건으로 세므로, 창을 늘리면 각 종목의 트레이드가 더
  // 이른 날짜로 옮겨 간다. 즉 긴 창은 짧은 창의 상위집합이 아니라 **다른 표본**이고,
  // 그래서 둘을 비교하는 것 자체가 의미 있다(부호가 창마다 뒤집히면 잡음이라는 뜻).
  line()
  console.log('\n### 1-a. 창 길이별 — 180일의 결론이 표본 탓인지 보는 가장 싼 방법')
  for (const market of ['KR', 'US'] as const) {
    console.log(`\n  [${market}]`)
    for (const days of [180, 365, 540, 730, 1095]) {
      const ts = await getScorecardTrades(market, days)
      const card = summarize(ts)
      const ci = confidence(ts)
      if (card.resolved === 0) {
        console.log(`    ${String(days).padStart(5)}일  판정완료 0건 (대기 ${card.pending}건)`)
        continue
      }
      console.log(
        `    ${String(days).padStart(5)}일  ${String(card.resolved).padStart(4)}건  ` +
          `기댓값 ${num(card.expectancyR)}R  목표도달 ${pct(card.hitRate).padStart(6)} (본전선 ${pct(card.breakevenHitRate)})  ` +
          (ci ? `95%CI ${num(ci.lo)} ~ ${num(ci.hi)}${ci.straddlesZero ? ' ⚠0품음' : ''}` : ''),
      )
    }
  }

  // 미달 조건 개수별 — 화면에 실제로 뜨는 건 미달이 적은 상위 후보들이다.
  for (const [label, trades] of [['한국', kr], ['미국', us]] as [string, ResolvedTrade[]][]) {
    const segs = segmentBy(trades, (t) => (t.missCount === 0 ? '전 조건 통과' : `미달 ${t.missCount}개`))
    if (segs.length === 0) continue
    console.log(`\n  [${label}] 미달 조건 개수별 (표본 ${MIN_SEGMENT_SAMPLE}건 미만은 빠짐)`)
    for (const seg of segs) {
      // 화면의 `Segment`는 집계값만 들고 다니므로(원본 트레이드가 없다) 신뢰구간용으로만
      // 같은 키 함수로 다시 묶는다. 집계는 여전히 화면과 같은 `summarize` 결과를 쓴다.
      const own = trades.filter(
        (t) => (t.missCount === 0 ? '전 조건 통과' : `미달 ${t.missCount}개`) === seg.key,
      )
      const ci = confidence(own)
      console.log(
        `    ${seg.label.padEnd(14)} ${String(seg.card.resolved).padStart(4)}건  기댓값 ${num(seg.card.expectancyR)}R  목표도달 ${pct(seg.card.hitRate).padStart(6)}  ` +
          (ci ? `95%CI ${num(ci.lo)} ~ ${num(ci.hi)}${ci.straddlesZero ? ' ⚠0품음' : ''}` : ''),
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

  // ── 1-b. SK하이닉스(000660)가 이 스크리너에 실제로 뜬 적이 있나 ──────
  // 사용자가 "눌림목 매수 스크리너에서 SK하이닉스 관련으로 보여주는 정보"를 물었는데,
  // SK하이닉스는 **스크리너 추천 종목이 아니라 포지션 관리 카드의 보유 종목**이다.
  // 둘이 같은 페이지에 있어 헷갈리기 쉬우므로, 실제로 추천된 적이 있는지 직접 찍는다.
  const hynix = kr.filter((t) => t.ticker === '000660')
  console.log(`\n  [SK하이닉스 000660] 최근 180일 눌림목 추천 ${hynix.length}건`)
  for (const t of hynix) {
    console.log(
      `    ${t.date}  진입 ${Math.round(t.entry).toLocaleString('ko-KR')} · 손절 ${Math.round(t.stop).toLocaleString('ko-KR')} · 목표 ${Math.round(t.target).toLocaleString('ko-KR')}` +
        ` → ${t.outcome}${t.r !== null ? ` (${num(t.r)}R)` : ''}`,
    )
  }
  if (hynix.length === 0) {
    console.log('    → 눌림목 스크리너는 SK하이닉스를 이 기간에 추천한 적이 없다.')
    console.log('      (화면의 SK하이닉스는 포지션 관리 카드의 보유 종목이고, 그쪽은 매수 추천이 아니다)')
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
