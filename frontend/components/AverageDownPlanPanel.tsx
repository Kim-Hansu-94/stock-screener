'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_LADDER_STYLE,
  LADDERS,
  CYCLE_TIMELINE,
  buildActionPlan,
  monthsSince,
  troughStatus,
  LADDER_INFO,
  LADDER_ORDER,
  buildAverageDownPlan,
  defaultScenarios,
  roundTrigger,
  type AverageDownPlan,
  type TroughStatus,
  type LadderStyle,
} from '@/lib/averageDownPlan'
import type { Market } from '@/lib/types'

/**
 * **추가 매수 분할 계획** — "얼마에 얼마씩 살지"를 미리 정해 보여 준다.
 *
 * 계산은 전부 `lib/averageDownPlan.ts`(순수 함수, 테스트 23개)에 있고 여기서는 그리기만
 * 한다. 그 파일의 docstring에 왜 목표가를 안 쓰는지, 사다리 숫자가 어디서 나왔는지가
 * 적혀 있다 — 요약하면 **예측하지 않고, 측정된 "추가 매수 후 중간값 -15%" 하나 위에
 * 세운다.**
 *
 * 예산은 `AverageCostCalculator`와 같은 원칙으로 **브라우저 localStorage에만** 둔다.
 * 얼마를 더 넣을 수 있는지는 개인 사정이라 서버에 올릴 이유가 없고, 파이프라인도 안 쓴다.
 * 카드를 펼쳐야 마운트되므로 첫 렌더에서 localStorage를 바로 읽어도 SSR 불일치가 없다.
 *
 * 화면이 반드시 같이 말해야 하는 것: **물타기는 손실률을 낮추지 손실액을 낮추지 않는다.**
 * 손익률만 보여 주면 "물탈수록 좋아진다"로 읽힌다 — 시나리오 표가 금액과 비율을
 * 나란히 놓는 이유다.
 */
export function AverageDownPlanPanel({
  market,
  ticker,
  avgCost,
  currentPrice,
  periodLow,
  periodLowDate,
  periodHighDate,
  className = '',
}: {
  market: Market
  ticker: string
  avgCost: number | null
  currentPrice: number
  periodLow: number
  /** 그 저가를 찍은 날('YYYY-MM-DD'). 실행 계획이 '바닥에서 몇 개월차'를 여기서 센다. */
  periodLowDate?: string
  /** 구간 고가를 찍은 날. 저가보다 나중이면 '바닥 지남' 전제가 깨진다. */
  periodHighDate?: string
  className?: string
}) {
  const key = `avgdownbudget:${market}:${ticker}`
  const [budgetText, setBudgetText] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      return window.localStorage.getItem(key) ?? ''
    } catch {
      // 사파리 프라이빗 모드 등에서 막혀도 패널은 떠야 한다.
      return ''
    }
  })

  useEffect(() => {
    try {
      if (budgetText) window.localStorage.setItem(key, budgetText)
      else window.localStorage.removeItem(key)
    } catch {
      /* 저장 실패는 계산을 막지 않는다 */
    }
  }, [key, budgetText])

  const budget = Number(budgetText.replace(/[^0-9]/g, '')) || 0

  // **보유 수량은 평단에서 역산할 수 없다** — DB에 평단만 있고 수량은 없다
  // (`AverageCostCalculator`가 차수별 내역을 기기에만 두고 평단만 올리기 때문).
  // 그런데 사다리의 "집행 후 평단"은 **기존 보유분과 섞은 값**이라 수량이 반드시
  // 필요하다. 예전엔 여기서 `shares: 1`을 넣고 "가격·수량에는 영향이 없다"고 적어
  // 뒀는데, 영향이 없는 건 가격·수량뿐이고 **평단은 통째로 틀린 값이 나왔다**
  // (13주 보유 기준 1,687,458원이 1,342,686원으로 찍혔다, 2026-11-12 사용자 지적).
  // 그래서 수량을 못 받았으면 평단을 **아예 계산하지 않는다** — 틀린 평단을
  // 보여 주느니 "수량을 넣어 달라"고 하는 편이 낫다.
  const sharesKey = `avgdownshares:${market}:${ticker}`
  const [sharesText, setSharesText] = useState<string>(() => {
    if (typeof window === 'undefined') return ''
    try {
      return window.localStorage.getItem(sharesKey) ?? ''
    } catch {
      return ''
    }
  })
  useEffect(() => {
    try {
      if (sharesText) window.localStorage.setItem(sharesKey, sharesText)
      else window.localStorage.removeItem(sharesKey)
    } catch {
      /* 저장 실패는 계산을 막지 않는다 */
    }
  }, [sharesKey, sharesText])
  const shares = Number(sharesText.replace(/[^0-9]/g, '')) || 0

  // 사다리 모양도 기기에만 둔다 — 시장을 어떻게 보는지는 개인 판단이고 서버가 알 이유가 없다.
  const styleKey = `avgdownstyle:${market}:${ticker}`
  const [style, setStyle] = useState<LadderStyle>(() => {
    if (typeof window === 'undefined') return DEFAULT_LADDER_STYLE
    try {
      const v = window.localStorage.getItem(styleKey)
      // **LADDERS의 키로 검사한다.** 예전엔 'dip'|'rebound'를 손으로 적어 둬서,
      // 뒤에 추가한 모양을 고르면 저장은 되는데 새로고침하면 조용히
      // 기본값으로 돌아갔다(화면·테스트 어디에도 안 걸린다).
      return v != null && Object.hasOwn(LADDERS, v) ? (v as LadderStyle) : DEFAULT_LADDER_STYLE
    } catch {
      return DEFAULT_LADDER_STYLE
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(styleKey, style)
    } catch {
      /* 저장 실패는 계산을 막지 않는다 */
    }
  }, [styleKey, style])

  const plan = useMemo(
    () =>
      avgCost != null && avgCost > 0 && shares > 0
        ? buildAverageDownPlan({ avgCost, shares, price: currentPrice, budget, market, style })
        : null,
    [avgCost, shares, currentPrice, budget, market, style],
  )

  const won = (v: number) => `${Math.round(v).toLocaleString('ko-KR')}원`
  const pct = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`

  if (avgCost == null || avgCost <= 0) {
    return (
      <div className={className}>
        <h4 className="text-sm font-bold">추가 매수 분할 계획</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          평단가를 먼저 입력하면 “얼마에 얼마씩 살지”를 계산해 드립니다.
        </p>
      </div>
    )
  }

  return (
    <div className={className}>
      {/* 폰 폭에서 제목과 한 줄에 두면 부제가 잘린다 — 줄을 나눈다. */}
      <h4 className="text-sm font-bold">추가 매수 분할 계획</h4>
      <p className="text-xs text-muted-foreground">예측이 아니라 가격 사다리입니다</p>

      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">추가로 쓸 수 있는 금액</span>
        <input
          inputMode="numeric"
          value={budgetText}
          onChange={(e) => setBudgetText(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="예: 30000000"
          className="h-8 w-36 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring"
        />
        {budget > 0 && <span className="font-mono text-muted-foreground">{won(budget)}</span>}
      </label>

      <label className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">지금 보유 수량</span>
        <input
          inputMode="numeric"
          value={sharesText}
          onChange={(e) => setSharesText(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="예: 13"
          className="h-8 w-36 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring"
        />
        {shares > 0 && (
          <span className="font-mono text-muted-foreground">
            {won(avgCost * shares)} 어치
          </span>
        )}
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">사다리 모양</span>
        {LADDER_ORDER.map((v) => (
          <button
            key={v}
            type="button"
            title={LADDER_INFO[v].gist}
            onClick={() => setStyle(v)}
            className={`rounded-md border px-2.5 py-1 font-medium ${
              style === v
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-input text-secondary-foreground hover:border-ring'
            }`}
          >
            {LADDER_INFO[v].label}
          </button>
        ))}
      </div>

      {/* 고른 모양이 무엇이 다른지 한 줄 — title 속성은 폰에서 안 보인다. */}
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
        {LADDER_INFO[style].gist}
      </p>

      <LadderComparison
        selected={style}
        onSelect={setStyle}
        avgCost={avgCost ?? 0}
        currentPrice={currentPrice}
        budget={budget}
        market={market}
        won={won}
      />

      {!plan ? (
        budget > 0 && shares > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            예산이 1주 값에도 못 미쳐 계획을 세울 수 없습니다.
          </p>
        ) : (
          // **금액·수량이 없어도 차수 가격은 보여 준다.** 가격은 현재가와 사다리 모양만으로
          // 정해진다 — 예산은 수량·금액에, 보유 수량은 평단에만 쓰인다. 예전엔 여기서
          // "금액을 넣으면…" 한 줄만 띄웠는데, 그러면 사다리 모양을 눌러도 **눈에 보이는
          // 것이 글자 한 줄뿐**이라 "버튼이 안 먹는다"로 읽힌다(실제 신고가 들어왔다).
          <LadderPreview
            currentPrice={currentPrice}
            style={style}
            budget={budget}
            shares={shares}
            won={won}
          />
        )
      ) : (
        <PlanBody
          key={style}
          plan={plan}
          avgCost={avgCost}
          currentPrice={currentPrice}
          periodLow={periodLow}
          periodLowDate={periodLowDate}
          periodHighDate={periodHighDate}
          shares={shares}
          budget={budget}
          market={market}
          style={style}
          won={won}
          pct={pct}
        />
      )}
    </div>
  )
}

/**
 * **다섯 모양이 무엇이 다른지 한 화면에서** 보여 준다.
 *
 * 왜 필요한가: 토글만 있으면 하나씩 눌러 가며 기억해야 비교가 되는데, 차이가
 * 드러나는 자리가 네 군데(차수 가격·비중·마지막 칸 깊이·전부 집행 시 평단)라
 * 머리로 합쳐지지 않는다. `title` 속성에 설명을 달아 뒀지만 **폰에서는 보이지도
 * 않는다**(마우스가 없다).
 *
 * 예산을 안 넣었으면 금액 대신 **현재가 대비 %**만 보여 준다 — 비어 있는 표를
 * 그리는 것보다 그쪽이 비교에 쓸모 있다.
 */
function LadderComparison({
  selected,
  onSelect,
  avgCost,
  currentPrice,
  budget,
  market,
  won,
}: {
  selected: LadderStyle
  onSelect: (s: LadderStyle) => void
  avgCost: number
  currentPrice: number
  budget: number
  market: Market
  won: (n: number) => string
}) {
  const [open, setOpen] = useState(false)

  const rows = useMemo(
    () =>
      LADDER_ORDER.map((style) => {
        const plan =
          avgCost > 0 && currentPrice > 0 && budget > 0
            ? buildAverageDownPlan({
                avgCost,
                shares: 1,
                price: currentPrice,
                budget,
                market,
                style,
              })
            : null
        return { style, info: LADDER_INFO[style], steps: LADDERS[style], plan }
      }),
    [avgCost, currentPrice, budget, market],
  )

  const stepText = (offset: number) =>
    offset === 0 ? '지금' : `${offset > 0 ? '+' : '−'}${Math.abs(Math.round(offset * 100))}%`

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-[11px] font-medium text-primary hover:underline"
      >
        {open ? '모양 비교 접기 ▴' : `${LADDER_ORDER.length}가지 모양이 뭐가 다른지 한눈에 보기 ▾`}
      </button>

      {open && (
        <div className="mt-1.5 rounded-md border border-input p-2">
          <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
            같은 예산으로 <span className="font-semibold">어디에 얼마씩 걸어 두느냐</span>만
            다릅니다. 가격 아래 숫자가 그 차수에 쓰는 예산 비중이고,{' '}
            <span className="underline decoration-dotted">밑줄 친 칸</span>은 현재가보다 위에서 사는
            차수입니다.
            {budget > 0 ? '' : ' 금액을 넣으면 실제 가격이 함께 나옵니다.'}
          </p>

          <div className="flex flex-col gap-1.5">
            {rows.map(({ style, info, steps, plan }) => {
              const on = style === selected
              return (
                <button
                  key={style}
                  type="button"
                  onClick={() => onSelect(style)}
                  className={`rounded-md border p-2 text-left ${
                    on ? 'border-primary bg-primary/5' : 'border-input hover:border-ring'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className={`text-xs font-bold ${on ? 'text-primary' : ''}`}>
                      {info.label}
                    </span>
                    {on && (
                      <span className="text-[10px] font-semibold text-primary">지금 보는 중</span>
                    )}
                    <span
                      className={`rounded px-1 py-px text-[10px] font-semibold ${
                        info.basis === 'measured'
                          ? 'bg-secondary text-secondary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {info.basis === 'measured' ? '측정에서 나온 간격' : '내 판단으로 고른 간격'}
                    </span>
                  </div>

                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {info.gist}
                  </p>

                  <div className="mt-1 grid grid-cols-4 gap-1">
                    {steps.map((d, i) => {
                      const t = plan?.tranches[i]
                      return (
                        <div
                          key={i}
                          className={`rounded bg-muted/60 px-1 py-1 text-center ${
                            d.offset > 0 ? 'underline decoration-dotted' : ''
                          }`}
                        >
                          <div className="font-mono text-[11px] font-semibold tabular-nums">
                            {t ? won(t.triggerPrice) : stepText(d.offset)}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {t ? `${stepText(d.offset)} · ` : ''}
                            {Math.round(d.weight * 100)}%
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {plan && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      전부 집행하면{' '}
                      <span className="font-mono font-semibold text-secondary-foreground">
                        {plan.finalQty}주 · 평단 {won(Math.round(plan.finalAvgCost))}
                      </span>
                      {plan.unusedBudget > 0 && <> · 못 쓰는 돈 {won(plan.unusedBudget)}</>}
                    </p>
                  )}
                </button>
              )
            })}
          </div>

          {/* 예산이 없으면 '전부 집행하면' 줄 자체가 없다 — 없는 것을 설명하지 않는다. */}
          {budget > 0 && (
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              <span className="font-semibold">&ldquo;전부 집행하면&rdquo;은 비교용 숫자입니다</span>{' '}
              — 네 차수가 다 걸리는 경우는 흔치 않고, 아래쪽 차수가 깊은 모양일수록 그 평단은 더
              드물게 나옵니다. 평단이 낮다고 좋은 모양이 아니라, 그만큼 더 빠져야 도달하는 값입니다.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function PlanBody({
  plan,
  avgCost,
  currentPrice,
  periodLow,
  periodLowDate,
  periodHighDate,
  shares,
  budget,
  market,
  style,
  won,
  pct,
}: {
  plan: NonNullable<ReturnType<typeof buildAverageDownPlan>>
  avgCost: number
  currentPrice: number
  periodLow: number
  /** 그 저가를 찍은 날('YYYY-MM-DD'). 실행 계획이 '바닥에서 몇 개월차'를 여기서 센다. */
  periodLowDate?: string
  /** 구간 고가를 찍은 날. 저가보다 나중이면 '바닥 지남' 전제가 깨진다. */
  periodHighDate?: string
  /** 지금 보유 수량. 0이면 부모가 애초에 plan을 만들지 않는다. */
  shares: number
  budget: number
  market: Market
  style: LadderStyle
  won: (v: number) => string
  pct: (v: number) => string
}) {
  // 구간 저가가 아직 '바닥'인지 — 뒤에 고가를 찍었으면 아니다.
  const status = troughStatus(periodLowDate, periodHighDate)

  const scenarios = useMemo(() => {
    if (shares <= 0) return null
    const input = {
      avgCost,
      shares,
      price: currentPrice,
      budget,
      market,
      style,
    }
    const p = buildAverageDownPlan(input)
    return p ? defaultScenarios(input, p, periodLow) : null
  }, [avgCost, shares, currentPrice, budget, market, periodLow, style])

  return (
    <>
      <ol className="mt-2 space-y-1.5">
        {plan.tranches.map((t) => {
          // 아래쪽 차수는 '그 가격까지 내려오면', 위쪽 차수는 '그 가격까지 올라오면' 산다.
          const reached =
            t.direction === 'rebound'
              ? currentPrice >= t.triggerPrice
              : currentPrice <= t.triggerPrice
          const when =
            t.direction === 'now'
              ? '지금 바로'
              : t.direction === 'dip'
                ? '이하로 내려오면'
                : '이상으로 올라오면'
          return (
            <li
              key={t.step}
              className={`rounded-md border px-2.5 py-1.5 text-xs ${
                reached ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/40'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="font-semibold">
                  {t.step}차 · {won(t.triggerPrice)} {when}
                  {reached && <span className="ml-1 text-primary">← 지금 조건 충족</span>}
                </span>
                <span className="font-mono text-muted-foreground">
                  {t.offsetPct === 0
                    ? '지금'
                    : `${t.offsetPct > 0 ? '+' : ''}${Math.round(t.offsetPct * 100)}%`}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-secondary-foreground">
                <span>{t.qty.toLocaleString('ko-KR')}주</span>
                <span>{won(t.cost)}</span>
                <span className="text-muted-foreground">→ 평단 {won(t.avgCostAfter)}</span>
              </div>
            </li>
          )
        })}
      </ol>

      <p className="mt-1.5 text-[11px] text-muted-foreground">
        다 집행하면 평단 <span className="font-mono">{won(plan.finalAvgCost)}</span> · 못 쓰고 남는
        돈 <span className="font-mono">{won(plan.unusedBudget)}</span> ·{' '}
        <span className="font-mono">{won(plan.stopBuyingAbove)}</span> 위에서는 사지 않습니다(평단이
        올라갑니다).
      </p>

      {plan.style === 'basing' && (
        <ActionPlanBox
          plan={plan}
          won={won}
          troughPrice={periodLow}
          troughDate={periodLowDate}
          status={status}
        />
      )}
      {plan.style === 'basing' && (
        <CycleTimelineBox won={won} troughDate={periodLowDate} status={status} />
      )}

      <p className="mt-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-secondary-foreground">
        차수 가격은 현재가에서{' '}
        {LADDERS[plan.style]
          .filter((d) => d.offset !== 0)
          .map((d) => `${d.offset > 0 ? '+' : ''}${Math.round(d.offset * 100)}%`)
          .join(' · ')}
        를 기계적으로 계산한 값입니다. 근거는 사다리마다 다릅니다 —{' '}
        <span className="font-semibold">{LADDER_INFO[plan.style].headline}</span>{' '}
        {LADDER_INFO[plan.style].body} 지지 신호 충족 개수는 집행 조건에 넣지 않았습니다 — 물타기
        상황에서는 그 개수와 성과 사이에 관계가 없다는 것이 측정됐습니다.
      </p>

      {scenarios && (
        <>
          <div className="mt-2 space-y-1.5">
            {scenarios.map((s) => (
              <div key={s.label} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
                <div className="font-semibold">{s.label}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  최저 {won(s.lowPrice)} · 최고 {won(s.highPrice)} → 끝 {won(s.endPrice)} ·{' '}
                  {s.executedSteps}개 차수 집행
                </div>
                <dl className="mt-1 grid grid-cols-1 gap-x-3 gap-y-0.5 font-mono text-[11px] sm:grid-cols-2">
                  <div className="flex justify-between gap-2">
                    <dt className="shrink-0 text-muted-foreground">계획대로</dt>
                    <dd className={s.planPnl >= 0 ? 'text-up' : 'text-down'}>
                      {won(s.planPnl)} ({pct(s.planPnlPct)})
                    </dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="shrink-0 text-muted-foreground">안 사면</dt>
                    <dd className={s.holdPnl >= 0 ? 'text-up' : 'text-down'}>
                      {won(s.holdPnl)} ({pct(s.holdPnlPct)})
                    </dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <p className="mt-1.5 border-l-2 border-down pl-2 text-[11px] leading-relaxed text-secondary-foreground">
            <span className="font-semibold">
              물타기는 손실률을 낮추지 손실액을 낮추지 않습니다.
            </span>{' '}
            떨어진 채로 끝나는 시나리오를 보세요 — 손실 <span className="font-semibold">비율</span>
            은 줄지만 잃는 <span className="font-semibold">금액</span>은 늘어납니다. 돈을 더 넣었기
            때문이고, 이건 계산 실수가 아니라 물타기의 성질입니다. 반대로 안 빠지고 바로 오르면 지금
            한 번에 사는 쪽이 낫습니다. 나눠 사는 건 공짜 점심이 아니라, 더 빠질 경우에 대비해 그
            경우를 유리하게 바꾸는 선택입니다.
          </p>
        </>
      )}
    </>
  )
}

/**
 * **시간 계획** — "그래서 언제 사야 하나".
 *
 * 가격 사다리만 보여 주면 "얼마에"는 알아도 "언제까지 기다릴지"를 모른다. 그래서
 * 눌림을 기다리는 기간에 **시한**을 붙이고, 미룰수록 나빠진다는 측정을 같이 적는다
 * (`CYCLE_TIMELINE` 주석 참조). 전제가 "바닥은 이미 지났다"이므로 `basing`에서만 뜬다.
 */
function CycleTimelineBox({
  won,
  troughDate,
  status,
}: {
  won: (n: number) => string
  troughDate?: string
  status: TroughStatus
}) {
  const t = CYCLE_TIMELINE
  // **전제가 깨졌으면 회복 경로 표를 아예 보여 주지 않는다.** 저가 뒤에 고가를 찍고
  // 내려온 종목에 "바닥에서 N개월차, 늦지도 이르지도 않습니다"를 띄우는 것은 조용히
  // 틀린 게 아니라 큰 소리로 틀린 말이다(2026-11-12 사용자 지적).
  if (status !== 'confirmed') {
    return (
      <div className="mt-2 rounded-md border-l-4 border-destructive bg-destructive/5 p-2.5">
        <p className="text-xs font-bold">&ldquo;언제 사야 하나&rdquo; 표는 이 종목에 못 씁니다</p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          그 표는 <span className="font-semibold">바닥을 지나 회복하는 중</span>인 종목을 과거
          사이클에 겹쳐 본 것입니다. 그런데 이 종목은{' '}
          <span className="font-semibold">구간 저가 뒤에 구간 고가를 찍고 다시 내려온 자리</span>라,
          그 저가는 이미 지나간 바닥이고 지금은 <span className="font-semibold">새 고점에서 내려온
          국면</span>입니다 — 전혀 다른 상황이라 그 숫자를 갖다 대면 틀립니다.
          {status === 'unknown' && ' (저가·고가 날짜를 가릴 수 없어 보수적으로 막았습니다.)'}
        </p>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          <span className="font-semibold">그래도 저점다지기형 사다리는 쓸 수 있습니다</span> — 다만
          근거가 측정이 아니라 <span className="font-semibold">&ldquo;여기가 바닥권&rdquo;이라는 당신의
          판단</span>이라는 점만 분명히 해 둡니다. 판단 없이 측정만 따르겠다면{' '}
          <span className="font-semibold">사이클 실측형</span>이나{' '}
          <span className="font-semibold">더 빠질 때 싣기</span>가 지금 상황에 맞습니다.
        </p>
      </div>
    )
  }
  // 개월 수는 일봉의 저가 날짜에서 센다 — 상수로 두면 시간이 지나는 것만으로 틀려진다.
  const now = monthsSince(troughDate, new Date()) ?? t.monthsAfterTrough
  // now가 표에 없는 달이면 표식이 통째로 사라진다 — 가장 가까운 줄에 붙인다.
  const nearest = t.entryByMonth.reduce((a, b) =>
    Math.abs(b.month - now) < Math.abs(a.month - now) ? b : a,
  ).month
  return (
    <div className="mt-2 rounded-md border border-input p-2">
      <p className="text-xs font-bold">언제 사야 하나 — 과거 사이클에 지금을 겹쳐 보면</p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
        과거 반도체 바닥 85건(국내 55 · 미국 30)을 바닥=0개월로 맞춰 포갠 결과입니다. 이 종목은
        바닥에서 <span className="font-semibold text-secondary-foreground">{now}개월차</span>입니다.
        {now === t.monthsAfterTrough ? (
          <>
            {' '}그때의 과거 중간값이 바닥 대비 1.45배(국내)·1.56배(미국)인데{' '}
            <span className="font-semibold text-secondary-foreground">지금 1.59배</span> —{' '}
            <span className="font-semibold text-secondary-foreground">늦지도 이르지도 않습니다.</span>
          </>
        ) : (
          <>
            {' '}아래 숫자는 <span className="font-semibold">{t.measuredOn}에 {t.monthsAfterTrough}개월차
            기준으로 잰 것</span>이라 지금과 한 칸 어긋나 있습니다 — 방향은 그대로지만 정확한 비교는
            다시 재야 합니다.
          </>
        )}
      </p>

      <ol className="mt-1.5 flex flex-col gap-1">
        <li className="rounded bg-muted/60 px-2 py-1.5 text-[11px] leading-snug">
          <span className="font-semibold">지금 바로</span> — 1차를 집행합니다. 미룰 이유가 측정에
          없습니다(아래 표).
        </li>
        <li className="rounded bg-muted/60 px-2 py-1.5 text-[11px] leading-snug">
          <span className="font-semibold">
            앞으로 {t.dipRangeAhead[0]}~{t.dipRangeAhead[1]}개월
          </span>{' '}
          — 가장 쌌던 달이 <span className="font-semibold">{t.dipMonthsAhead}개월 뒤</span>였습니다.
          지금보다 싸진 경우가 <span className="font-semibold">{t.dipProbabilityPct}%</span>, 그때 깊이가
          중간값 <span className="font-semibold text-down">{t.dipDepthPct}%</span> — 2·3차 자리가 바로
          여기입니다.
        </li>
        <li className="rounded bg-muted/60 px-2 py-1.5 text-[11px] leading-snug">
          <span className="font-semibold">{t.deadlineMonthsAhead}개월이 지나도 안 빠지면</span> — 남은
          돈을 그냥 집행합니다. <span className="font-semibold">기다리는 것 자체가 비용</span>이기
          때문입니다(아래 표).
        </li>
      </ol>

      <p className="mt-2 text-[11px] font-semibold">바닥에서 N개월차에 사서 24개월차까지 (중간값)</p>
      <div className="mt-1 overflow-x-auto">
        <table className="w-full min-w-0 text-[11px] tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-0.5 text-left font-medium">바닥 이후</th>
              <th className="py-0.5 text-right font-medium">국내 반도체</th>
              <th className="py-0.5 text-right font-medium">미국 반도체</th>
            </tr>
          </thead>
          <tbody>
            {t.entryByMonth.map((r) => (
              <tr key={r.month} className={r.month === nearest ? 'font-bold text-primary' : ''}>
                <td className="py-0.5">
                  {r.month}개월차{r.month === nearest ? (now === r.month ? ' (지금)' : ' (지금에 가장 가까움)') : ''}
                </td>
                <td className={`py-0.5 text-right font-mono ${r.kr >= 0 ? 'text-up' : 'text-down'}`}>
                  {r.kr >= 0 ? '+' : ''}
                  {r.kr.toFixed(1)}%
                </td>
                <td className={`py-0.5 text-right font-mono ${r.us >= 0 ? 'text-up' : 'text-down'}`}>
                  {r.us >= 0 ? '+' : ''}
                  {r.us.toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        <span className="font-semibold">표가 아래로 갈수록 나빠지는 것이 핵심입니다</span> — 바닥에서
        멀어질수록 같은 종목을 사도 남는 게 줄었습니다. 다만 이 숫자들은{' '}
        <span className="font-semibold">&ldquo;{won(807_000)}원이 진짜 바닥이었다&rdquo;</span>가 맞아야
        뜻이 있고, 바닥인지는 지나고 나서야 알 수 있습니다. 지금 살아남은 종목만 세었으므로 수익률은
        실제보다 높게 잡혀 있습니다.
      </p>
    </div>
  )
}

/**
 * **실행 계획** — 패널 맨 위. "그래서 오늘 뭘 하면 되나"에 바로 답한다.
 *
 * 사다리(얼마에)와 타임라인(언제)을 사람이 머릿속에서 합치게 두지 않는다 —
 * 합치는 일을 떠넘기면 대개 아무것도 안 하거나 그날 기분대로 산다.
 *
 * `today`를 렌더 시점에 만든다. 이 패널은 카드를 펼쳐야만 마운트되는 클라이언트
 * 컴포넌트라 서버 렌더와 비교될 일이 없다(`AverageCostCalculator`가 localStorage를
 * 바로 읽는 것과 같은 이유).
 */
function ActionPlanBox({
  plan,
  won,
  troughPrice,
  troughDate,
  status,
}: {
  plan: AverageDownPlan
  won: (n: number) => string
  troughPrice: number
  troughDate?: string
  status: TroughStatus
}) {
  const steps = useMemo(
    () => buildActionPlan(plan, new Date(), troughPrice, troughDate, status),
    [plan, troughPrice, troughDate, status],
  )
  const STYLE: Record<string, { tag: string; cls: string }> = {
    now: { tag: '오늘', cls: 'bg-primary/10 text-primary' },
    order: { tag: '예약', cls: 'bg-secondary text-secondary-foreground' },
    deadline: { tag: '시한', cls: 'bg-secondary text-secondary-foreground' },
    stop: { tag: '중단', cls: 'bg-destructive/10 text-destructive' },
    never: { tag: '금지', cls: 'bg-destructive/10 text-destructive' },
  }
  return (
    <div className="mt-2 rounded-md border-l-4 border-primary bg-primary/5 p-2.5">
      <p className="text-xs font-bold">지금부터 어떻게 할 것인가</p>
      <ol className="mt-1.5 flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const st = STYLE[s.kind] ?? STYLE.order
          return (
            <li key={i} className="rounded-md bg-background/70 px-2 py-1.5">
              <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <span className={`rounded px-1.5 py-px text-[10px] font-bold ${st.cls}`}>{st.tag}</span>
                {s.by && <span className="font-mono text-[10px] text-muted-foreground">{s.by}</span>}
                <span className="text-[11px] font-semibold leading-snug">{s.title}</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{s.why}</p>
            </li>
          )
        })}
      </ol>
      <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
        전부 집행하면 <span className="font-mono font-semibold">{plan.finalQty}주 · 평단 {won(Math.round(plan.finalAvgCost))}원</span>
        {plan.unusedBudget > 0 && <> (못 쓰는 돈 {won(plan.unusedBudget)}원)</>}. 네 칸이 다 걸리는 경우는
        흔치 않으니 <span className="font-semibold">그 평단은 목표가 아니라 최대치</span>입니다.
      </p>
    </div>
  )
}

/**
 * **금액을 넣기 전에도 보이는 차수 가격.**
 *
 * 차수 가격은 `현재가 × (1 + 차수 비율)`이라 **예산과 무관하게 정해진다** — 예산은
 * 수량·금액에만 쓰인다. 그런데 예전엔 금액이 비면 "금액을 넣으면 차수별 집행 가격과
 * 수량이 나옵니다"라는 **흐린 글씨 한 줄**만 띄웠다. 그 상태에서 사다리 모양 버튼을
 * 누르면 바뀌는 것이 버튼 테두리와 설명 한 줄뿐이라 **"버튼이 안 먹는다"로 읽힌다**
 * (2026-11-12 실제 신고). 가격을 먼저 보여 주면 버튼이 일한다는 것이 바로 보인다.
 */
function LadderPreview({
  currentPrice,
  style,
  budget,
  shares,
  won,
}: {
  currentPrice: number
  style: LadderStyle
  budget: number
  shares: number
  won: (n: number) => string
}) {
  const steps = LADDERS[style]
  const missing = [budget > 0 ? null : '추가로 쓸 수 있는 금액', shares > 0 ? null : '지금 보유 수량']
    .filter(Boolean)
    .join('과 ')
  return (
    <div className="mt-2">
      <ol className="space-y-1">
        {steps.map((d, i) => {
          const price = roundTrigger(currentPrice * (1 + d.offset))
          const when = d.offset === 0 ? '지금 바로' : d.offset < 0 ? '이하로 내려오면' : '이상으로 올라오면'
          return (
            <li
              key={i}
              className="flex flex-wrap items-baseline justify-between gap-x-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-xs"
            >
              <span className="font-semibold">
                {i + 1}차 · {won(price)} {when}
              </span>
              <span className="font-mono text-muted-foreground">
                {d.offset === 0 ? '지금' : `${d.offset > 0 ? '+' : ''}${Math.round(d.offset * 100)}%`}
                {' · '}
                {budget > 0 ? `${Math.floor((budget * d.weight) / price).toLocaleString('ko-KR')}주` : `예산 ${Math.round(d.weight * 100)}%`}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="mt-1.5 rounded-md border-l-4 border-primary bg-primary/5 px-2.5 py-1.5 text-[11px] leading-snug">
        <span className="font-semibold">위에 {missing}을 넣으면</span> 집행 후 평단과 시나리오별
        손익까지 채워집니다.{' '}
        {shares <= 0 && (
          <>
            <span className="font-semibold">집행 후 평단은 지금 들고 있는 주식과 섞은 값</span>이라
            보유 수량 없이는 계산할 수 없습니다 — 그래서 지어내지 않고 비워 둡니다.{' '}
          </>
        )}
        넣은 값은 이 기기에만 저장됩니다.
      </p>
    </div>
  )
}
