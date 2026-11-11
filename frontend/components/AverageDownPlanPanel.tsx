'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  LADDER_DROPS,
  MEDIAN_FURTHER_DROP,
  buildAverageDownPlan,
  defaultScenarios,
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
  className = '',
}: {
  market: Market
  ticker: string
  avgCost: number | null
  currentPrice: number
  periodLow: number
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

  const plan = useMemo(
    () =>
      avgCost != null && avgCost > 0
        ? buildAverageDownPlan({ avgCost, shares: 1, price: currentPrice, budget, market })
        : null,
    // shares는 사다리 가격·수량에 영향을 주지 않는다(평단 계산에만 쓰인다).
    // 실제 보유 수량은 아래에서 다시 넣는다.
    [avgCost, currentPrice, budget, market],
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

      {!plan ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {budget > 0
            ? '예산이 1주 값에도 못 미쳐 계획을 세울 수 없습니다.'
            : '금액을 넣으면 차수별 집행 가격과 수량이 나옵니다. 이 값은 이 기기에만 저장됩니다.'}
        </p>
      ) : (
        <PlanBody
          plan={plan}
          avgCost={avgCost}
          currentPrice={currentPrice}
          periodLow={periodLow}
          budget={budget}
          market={market}
          won={won}
          pct={pct}
        />
      )}
    </div>
  )
}

function PlanBody({
  plan,
  avgCost,
  currentPrice,
  periodLow,
  budget,
  market,
  won,
  pct,
}: {
  plan: NonNullable<ReturnType<typeof buildAverageDownPlan>>
  avgCost: number
  currentPrice: number
  periodLow: number
  budget: number
  market: Market
  won: (v: number) => string
  pct: (v: number) => string
}) {
  // 보유 수량은 평단·원금에서 역산할 수 없다(평단만 저장돼 있다). 시나리오 손익을
  // 금액으로 내려면 수량이 필요하므로 **사용자가 직접 넣게** 한다 — 지어내지 않는다.
  const [sharesText, setSharesText] = useState('')
  const shares = Number(sharesText.replace(/[^0-9]/g, '')) || 0

  const scenarios = useMemo(() => {
    if (shares <= 0) return null
    const input = { avgCost, shares, price: currentPrice, budget, market }
    const p = buildAverageDownPlan(input)
    return p ? defaultScenarios(input, p, periodLow) : null
  }, [avgCost, shares, currentPrice, budget, market, periodLow])

  return (
    <>
      <ol className="mt-2 space-y-1.5">
        {plan.tranches.map((t) => {
          const reached = currentPrice <= t.triggerPrice
          return (
            <li
              key={t.step}
              className={`rounded-md border px-2.5 py-1.5 text-xs ${
                reached ? 'border-primary/40 bg-primary/5' : 'border-border bg-muted/40'
              }`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="font-semibold">
                  {t.step}차 · {won(t.triggerPrice)} 이하
                  {reached && <span className="ml-1 text-primary">← 지금 집행 구간</span>}
                </span>
                <span className="font-mono text-muted-foreground">
                  {t.dropPct === 0 ? '지금' : `-${Math.round(t.dropPct * 100)}%`}
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
        다 집행하면 평단 <span className="font-mono">{won(plan.finalAvgCost)}</span> · 못 쓰고 남는 돈{' '}
        <span className="font-mono">{won(plan.unusedBudget)}</span> ·{' '}
        <span className="font-mono">{won(plan.stopBuyingAbove)}</span> 위에서는 사지 않습니다(평단이
        올라갑니다).
      </p>

      <p className="mt-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px] leading-relaxed text-secondary-foreground">
        차수 가격은 현재가에서 {LADDER_DROPS.slice(1).map((d) => `-${Math.round(d * 100)}%`).join(' · ')}를
        기계적으로 계산한 값입니다. 근거는 실측 한 가지뿐입니다 —{' '}
        <span className="font-semibold">
          이미 15% 이상 빠진 종목을 추가 매수하면 60거래일 안에 중간값{' '}
          {Math.round(MEDIAN_FURTHER_DROP * 100)}%만큼 더 빠집니다
        </span>
        (104,119건). 예측이 아니라 각오해야 할 기본값이라, 지금 다 쓰지 않고 아래로 갈수록 크게
        삽니다. 지지 신호 충족 개수는 집행 조건에 넣지 않았습니다 — 물타기 상황에서는 그 개수와
        성과 사이에 관계가 없다는 것이 측정됐습니다.
      </p>

      <label className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">지금 보유 수량(시나리오 계산용)</span>
        <input
          inputMode="numeric"
          value={sharesText}
          onChange={(e) => setSharesText(e.target.value.replace(/[^0-9]/g, ''))}
          placeholder="주"
          className="h-8 w-20 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring"
        />
      </label>

      {scenarios && (
        <>
          <div className="mt-2 space-y-1.5">
            {scenarios.map((s) => (
              <div key={s.label} className="rounded-md border border-border px-2.5 py-1.5 text-xs">
                <div className="font-semibold">{s.label}</div>
                <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  최저 {won(s.lowPrice)} → 끝 {won(s.endPrice)} · {s.executedSteps}차까지 집행
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
            <span className="font-semibold">물타기는 손실률을 낮추지 손실액을 낮추지 않습니다.</span>{' '}
            떨어진 채로 끝나는 시나리오를 보세요 — 손실 <span className="font-semibold">비율</span>은
            줄지만 잃는 <span className="font-semibold">금액</span>은 늘어납니다. 돈을 더 넣었기
            때문이고, 이건 계산 실수가 아니라 물타기의 성질입니다. 반대로 안 빠지고 바로 오르면
            지금 한 번에 사는 쪽이 낫습니다. 나눠 사는 건 공짜 점심이 아니라, 더 빠질 경우에
            대비해 그 경우를 유리하게 바꾸는 선택입니다.
          </p>
        </>
      )}
    </>
  )
}
