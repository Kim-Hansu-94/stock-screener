import {
  BIG_MOVE_PCT,
  PATTERN_HOLD_BARS,
  type PatternScorecard,
  type PatternSegment,
  patternVerdictOf,
} from '@/lib/patternScorecard'
import { changeTextClass } from '@/lib/marketColors'
import { DivergingBarTable, VerdictBadge } from '@/components/Scorecard'

function signedPct(v: number, digits = 1): string {
  const sign = v > 0 ? '+' : v < 0 ? '−' : ''
  return `${sign}${Math.abs(v).toFixed(digits)}%`
}

/**
 * "저점 매집 후보를 그대로 샀다면 어땠나"에 대한 답.
 *
 * 눌림목 성적 카드(`ScorecardVerdict`)와 나란히 놓이지만 단위가 R이 아니라 %다 —
 * 이 탭은 손절·목표를 계산하지 않으므로 R로 잴 수 없다.
 *
 * **평균과 중간값을 항상 같이 보여준다.** 55% 이상 빠진 종목을 고르는 전략이라
 * 대부분은 눕고 소수가 몇 배 튀는 분포가 나온다. 평균만 크게 띄우면 "열에 아홉은
 * 손실인데 평균은 +8%"인 상태를 그대로 놓친다.
 */
export function PatternScorecardVerdict({ card, title }: { card: PatternScorecard; title: string }) {
  const verdict = patternVerdictOf(card)

  if (card.settled === 0) {
    return (
      <div className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          아직 {PATTERN_HOLD_BARS}거래일이 지난 추천이 없습니다
          {card.pending > 0 && ` (관찰 중 ${card.pending}건)`}.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <VerdictBadge verdict={verdict} />
      </div>

      <div>
        <p className="text-xs text-muted-foreground">
          추천 1건당 평균 수익률 ({PATTERN_HOLD_BARS}거래일 뒤)
        </p>
        {/* 표본이 부족하면 숫자를 무채색으로 낮춘다 — 등락 색을 입히면 못 믿을 값인데도
            '확실히 벌었다'로 읽혀 배지(아직 판단 못 함)와 화면이 엇갈린다. */}
        <p
          className={`text-4xl font-bold tracking-tight ${
            verdict === 'insufficient' ? 'text-muted-foreground' : changeTextClass(card.avgReturnPct)
          }`}
        >
          {signedPct(card.avgReturnPct)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {verdict === 'insufficient' ? (
            <>
              지금까지는 그랬지만 {card.settled}건뿐이라 운으로 뒤집히는 범위입니다. 20건은
              넘어야 방향을 말할 수 있습니다.
            </>
          ) : card.skewed ? (
            <>
              다만 <span className="font-medium text-foreground">중간값은 {signedPct(card.medianReturnPct)}</span>
              입니다. 평균이 소수 종목에 끌려간 상태라, 실제로 무작위로 한 종목을 골랐다면
              결과는 중간값 쪽에 가깝습니다.
            </>
          ) : (
            <>
              중간값은 {signedPct(card.medianReturnPct)}입니다. 평균과 방향이 같아 한두 종목이
              끌어올린 값은 아닙니다.
            </>
          )}
        </p>
      </div>

      <WinRateBar card={card} />

      <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted p-3 text-xs">
        <div>
          <dt className="text-muted-foreground">크게 오름 (+{BIG_MOVE_PCT}% 이상)</dt>
          <dd className="mt-0.5 font-semibold text-up">{(card.bigWinRate * 100).toFixed(0)}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">크게 빠짐 (−{BIG_MOVE_PCT}% 이하)</dt>
          <dd className="mt-0.5 font-semibold text-down">{(card.bigLossRate * 100).toFixed(0)}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">기간 중 최고점 평균</dt>
          <dd className={`mt-0.5 font-semibold ${changeTextClass(card.avgMaxGainPct)}`}>
            {signedPct(card.avgMaxGainPct)}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">기간 중 최저점 평균</dt>
          <dd className={`mt-0.5 font-semibold ${changeTextClass(card.avgMaxDropPct)}`}>
            {signedPct(card.avgMaxDropPct)}
          </dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">
        최고·최저점은 종가가 아니라 장중 고가·저가입니다 — 들고 있었다면 실제로 이만큼
        올랐다 내렸다 했다는 뜻입니다.
      </p>

      <p className="text-xs text-muted-foreground">
        판정 완료 {card.settled}건
        {card.pending > 0 && ` · 관찰 중 ${card.pending}건은 결과를 몰라 집계에서 뺐습니다`}
      </p>
    </div>
  )
}

/**
 * 승률을 50% 기준선과 나란히 놓는다.
 *
 * 눌림목 성적의 본전선(목표 배수에서 역산)과 달리 여기엔 계산으로 나오는 기준선이
 * 없다 — 손절·목표가 없어 "몇 %는 맞아야 본전"이 정의되지 않는다. 그래서 동전
 * 던지기(50%)를 눈금으로 쓴다. **같은 기간 지수 수익률이 진짜 기준선이지만
 * `market_index_snapshot`에 과거 시계열이 없어 아직 못 그린다.**
 */
function WinRateBar({ card }: { card: PatternScorecard }) {
  const win = card.winRate * 100
  const beats = card.winRate >= 0.5

  return (
    <div className="space-y-2 rounded-lg bg-muted p-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">오른 비율</span>
        <span className="font-semibold text-foreground">{win.toFixed(0)}%</span>
      </div>

      <div className="relative h-2 rounded-full bg-border">
        <div
          className={`h-2 rounded-full ${beats ? 'bg-up' : 'bg-down'}`}
          style={{ width: `${Math.min(100, win)}%` }}
        />
        {/* 50% 눈금 */}
        <div className="absolute left-1/2 top-[-3px] h-3.5 w-0.5 bg-foreground" />
      </div>

      <p className="text-xs text-muted-foreground">
        눈금은 동전 던지기(50%)입니다. 같은 기간 지수 수익률과 비교하는 것이 맞지만 지수
        일봉을 저장하지 않아 아직 그 기준선은 없습니다 — 그래서 이 숫자만으로
        &ldquo;시장보다 나았다&rdquo;고는 말할 수 없습니다.
      </p>
    </div>
  )
}

/** "어떤 특성의 후보가 잘 맞았나" — 수익률을 구간별로 쪼갠다. */
export function PatternSegmentTable({
  title,
  hint,
  segments,
}: {
  title: string
  hint?: string
  segments: PatternSegment[]
}) {
  return (
    <DivergingBarTable
      title={title}
      hint={hint}
      rows={segments.map((s) => ({
        key: s.key,
        label: s.label,
        value: s.card.avgReturnPct,
        count: s.card.settled,
      }))}
      format={(v) => signedPct(v, 0)}
      // 수익률은 R보다 눈금이 커서(수십 %) 최소 폭도 크게 잡아야 막대가 뻥튀기되지 않는다.
      minSpan={10}
    />
  )
}
