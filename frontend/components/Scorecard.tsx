import type { Scorecard, Segment, Verdict } from '@/lib/scorecard'
import { verdictOf } from '@/lib/scorecard'
import { changeTextClass } from '@/lib/marketColors'

const VERDICT_LABEL: Record<Verdict, string> = {
  positive: '따라갈 만합니다',
  marginal: '아주 약한 우위',
  negative: '우위 없음',
  insufficient: '아직 판단 못 함',
}

// 판정 배지는 방향(벌었나/잃었나)을 나타내므로 등락 색 규칙을 따른다.
// 표본 부족은 방향이 아니라 '모름'이라 무채색이다.
const VERDICT_TINT: Record<Verdict, string> = {
  positive: 'bg-up/10 text-up',
  marginal: 'bg-up/10 text-up',
  negative: 'bg-down/10 text-down',
  insufficient: 'bg-muted text-muted-foreground',
}

function signedR(r: number, digits = 2): string {
  const sign = r > 0 ? '+' : r < 0 ? '−' : ''
  return `${sign}${Math.abs(r).toFixed(digits)}R`
}

/**
 * "이 스크리너를 따라가면 돈을 버나"에 대한 답.
 *
 * 기댓값(추천 1건당 평균 R)이 주인공이다. 도달률·손절률은 목표 배수에 따라
 * 기준선이 달라져 단독으로는 좋고 나쁨을 알 수 없으므로 아래 보조 지표로 내린다.
 */
export function ScorecardVerdict({ card, title }: { card: Scorecard; title: string }) {
  const verdict = verdictOf(card)

  if (card.resolved === 0) {
    return (
      <div className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          아직 판정이 끝난 추천이 없습니다
          {card.pending > 0 && ` (진행 중 ${card.pending}건)`}.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted-foreground">{title}</p>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${VERDICT_TINT[verdict]}`}>
          {VERDICT_LABEL[verdict]}
        </span>
      </div>

      <div>
        <p className="text-xs text-muted-foreground">추천 1건당 평균 손익</p>
        {/* 표본이 부족하면 숫자를 무채색으로 낮춘다. 등락 색을 입히면 아직 못 믿을
            값인데도 '확실히 벌었다'로 읽혀 배지(아직 판단 못 함)와 화면이 엇갈린다. */}
        <p
          className={`text-4xl font-bold tracking-tight ${
            verdict === 'insufficient' ? 'text-muted-foreground' : changeTextClass(card.expectancyR)
          }`}
        >
          {signedR(card.expectancyR)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {verdict === 'insufficient' ? (
            <>
              지금까지는 그랬지만 {card.resolved}건뿐이라 운으로 뒤집히는 범위입니다. 20건은
              넘어야 방향을 말할 수 있습니다.
            </>
          ) : (
            <>
              손절 폭을 1칸이라 할 때, 추천 한 건마다 평균{' '}
              <span className={changeTextClass(card.expectancyR)}>
                {Math.abs(card.expectancyR).toFixed(2)}칸을{' '}
                {card.expectancyR >= 0 ? '벌었습니다' : '잃었습니다'}
              </span>
              .
            </>
          )}
        </p>
      </div>

      <HitRateBar card={card} />

      <p className="text-xs text-muted-foreground">
        판정 완료 {card.resolved}건 · 평균 보유 {card.avgHoldingDays.toFixed(0)}일
        {card.pending > 0 && ` · 진행 중 ${card.pending}건은 결과를 몰라 집계에서 뺐습니다`}
      </p>
    </div>
  )
}

/**
 * 도달률을 본전선과 나란히 놓는다.
 *
 * 목표가 2R이면 실력이 없어도 손절이 2배 자주 걸린다. 즉 도달률 33%가 본전선이고
 * 손절률 67%는 실패가 아니다. 예전 화면은 이 기준선 없이 손절률만 크게 보여줘서
 * 정상 범위인데도 고장난 것처럼 읽혔다.
 */
function HitRateBar({ card }: { card: Scorecard }) {
  const hit = card.hitRate * 100
  const breakeven = card.breakevenHitRate * 100
  const beats = card.hitRate >= card.breakevenHitRate

  return (
    <div className="space-y-2 rounded-lg bg-muted p-3">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">목표 도달률</span>
        <span className="font-semibold text-foreground">{hit.toFixed(0)}%</span>
      </div>

      <div className="relative h-2 rounded-full bg-border">
        <div
          className={`h-2 rounded-full ${beats ? 'bg-up' : 'bg-down'}`}
          style={{ width: `${Math.min(100, hit)}%` }}
        />
        {/* 본전선 눈금 */}
        <div
          className="absolute top-[-3px] h-3.5 w-0.5 bg-foreground"
          style={{ left: `${Math.min(100, breakeven)}%` }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        본전선 {breakeven.toFixed(0)}% (목표가 손절의 {(1 / card.breakevenHitRate - 1).toFixed(1)}배라 이만큼은
        맞아야 본전) · 지금은 {beats ? '본전선 위' : '본전선 아래'}입니다.
      </p>
      <p className="text-xs text-muted-foreground">
        목표 {card.targetHits}건 · 손절 {card.stops}건 · 기간 만료 {card.timeouts}건
      </p>
    </div>
  )
}

/** "어떤 종류의 추천이 잘 맞나" — 기댓값을 구간별로 쪼갠다. */
export function SegmentTable({ title, hint, segments }: { title: string; hint?: string; segments: Segment[] }) {
  if (segments.length === 0) return null

  const widest = Math.max(...segments.map((s) => Math.abs(s.card.expectancyR)), 0.5)

  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      <div className="space-y-1.5">
        {segments.map((seg) => {
          const r = seg.card.expectancyR
          return (
            <div key={seg.key} className="flex items-center gap-3">
              <span className="w-24 shrink-0 truncate text-sm text-foreground" title={seg.label}>
                {seg.label}
              </span>
              {/* 0을 가운데 두고 좌우로 뻗는 막대 — 부호를 길이가 아니라 방향으로 읽게 한다 */}
              <div className="relative h-5 flex-1">
                <div className="absolute left-1/2 top-0 h-5 w-px bg-border" />
                <div
                  className={`absolute top-1 h-3 rounded-sm ${r >= 0 ? 'bg-up' : 'bg-down'}`}
                  style={{
                    left: r >= 0 ? '50%' : `${50 - (Math.abs(r) / widest) * 50}%`,
                    width: `${(Math.abs(r) / widest) * 50}%`,
                  }}
                />
              </div>
              <span className={`w-16 shrink-0 text-right font-mono text-sm ${changeTextClass(r)}`}>
                {signedR(r)}
              </span>
              <span className="w-12 shrink-0 text-right text-xs text-muted-foreground">
                {seg.card.resolved}건
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
