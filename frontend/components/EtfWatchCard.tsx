'use client'

import { useEffect, useState } from 'react'
import { LazyStockChart } from '@/components/LazyStockChart'
import { StockNewsFeed } from '@/components/StockNewsFeed'
import type { EtfHoldingsResult } from '@/lib/queries/etfHoldings'
import {
  ETF_MARKET,
  ETF_NAME,
  ETF_TICKER,
  MANUAL_STOP_CHECKS,
  describeTenYearYield,
  judgedHoldings,
  summarizeStopSignals,
  type ProxyBasketAssessment,
  type StageResult,
  type StopSignal,
  type TrancheStep,
} from '@/lib/etfEntryCheck'
import { formatKstDateTime, usBarStatus } from '@/lib/usMarketSession'
import type { MarketIndexSnapshotRow } from '@/lib/types'

/**
 * 490590 매수체크 — 사용자가 직접 정한 개인 체크리스트를 그대로 화면으로 옮긴 카드.
 *
 * 계산(A/B/C 단계 판정, 신호등, 분할매수 조건)은 전부 lib/etfEntryCheck.ts에서 서버
 * 컴포넌트(app/page.tsx — 2026-09-15부터 사이트 첫 화면)가 미리 끝내고, 여기는 결과만 받아 그린다 — 원본
 * 일봉을 클라이언트로 내려보내지 않는다("화면에 안 쓰는 일봉을 미리 내려보내지 말 것").
 *
 * 몇 차까지 매수를 실행했는지는 이 브라우저에만 저장한다(AverageCostCalculator와 같은
 * 원칙) — 실제 매수는 사용자가 증권사 앱에서 하고, 여기는 계획을 잊지 않게 기억만 한다.
 */

const TRANCHE_STORAGE_KEY = 'etf-watch:490590:tranche-done'

function loadTrancheDone(): boolean[] {
  const fallback = [false, false, false, false]
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(TRANCHE_STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return fallback
    return fallback.map((_, i) => Boolean(parsed[i]))
  } catch {
    return fallback
  }
}

function StageBadge({ stage }: { stage: StageResult['stage'] | null }) {
  if (stage === null) {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground/70">
        판정 불가
      </span>
    )
  }
  const style =
    stage === 'A' ? 'bg-down/10 text-down' : stage === 'C' ? 'bg-up/10 text-up' : 'bg-secondary text-secondary-foreground'
  const label = stage === 'A' ? '하락 중' : stage === 'C' ? '상승 전환' : '관찰'
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}>{label}</span>
}

function ConditionChip({ met, label }: { met: boolean; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        met ? 'bg-accent font-semibold text-accent-foreground' : 'bg-muted text-muted-foreground'
      }`}
    >
      {label} {met ? '✓' : '✗'}
    </span>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="text-base font-bold">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      <div className="pt-1.5">{children}</div>
    </section>
  )
}

export function EtfWatchCard({
  holdings,
  proxyAssessment,
  etfLatest,
  hasEtfData,
  tranches,
  stopSignals,
  tenYearYield,
  nasdaq,
}: {
  holdings: EtfHoldingsResult
  proxyAssessment: ProxyBasketAssessment
  etfLatest: { close: number; date: string } | null
  hasEtfData: boolean
  tranches: TrancheStep[]
  stopSignals: StopSignal[]
  tenYearYield: MarketIndexSnapshotRow | null
  nasdaq: MarketIndexSnapshotRow | null
}) {
  // 판정에 쓰는 건 비중 상위 8개뿐이다(JUDGED_HOLDINGS_COUNT). holdings.holdings는
  // ETF가 실제로 담고 있는 15개 전부라, 둘을 섞어 쓰면 "일봉 부족 7개"처럼 거짓말을 한다.
  const judged = judgedHoldings(holdings.holdings)
  const judgedWeight = judged.reduce((sum, h) => sum + h.weight, 0)
  const heldWeight = holdings.holdings.reduce((sum, h) => sum + h.weight, 0)
  const excluded = holdings.holdings.filter((h) => !judged.some((j) => j.ticker === h.ticker))
  const [done, setDone] = useState<boolean[]>([false, false, false, false])
  const [chartOpen, setChartOpen] = useState(false)

  // SSR 결과(전부 false)와 먼저 맞춘 뒤 마운트 후에 저장된 값으로 갱신한다 — hydration 불일치 방지.
  // localStorage는 브라우저에만 있는 외부 저장소라 렌더 중에는 못 읽고 마운트 후에만 읽을 수
  // 있다(React 문서가 말하는 "외부 시스템과 동기화"에 해당하는 경우다).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDone(loadTrancheDone())
  }, [])

  function toggleTranche(index: number) {
    setDone((prev) => {
      const next = [...prev]
      next[index] = !next[index]
      try {
        window.localStorage.setItem(TRANCHE_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 저장이 막힌 브라우저에서도 화면은 계속 동작해야 한다.
      }
      return next
    })
  }

  const investedManwon = tranches.reduce((sum, t, i) => (done[i] ? sum + t.amountManwon : sum), 0)
  const stopVerdict = summarizeStopSignals(stopSignals)
  // ^TNX는 퍼센트 값 그대로다(5.02 = 5.02%). 예전엔 10으로 나눠서 5.02%가 0.50%로
  // 떴다 — 뉴스의 "10년물 5.02%"와 대조해 잡았다(2026-09-15).
  const tenYearPct = tenYearYield ? tenYearYield.close : null
  const tenYearChangePct = tenYearYield ? tenYearYield.close - tenYearYield.prev_close : null
  const yieldMeaning = tenYearPct !== null ? describeTenYearYield(tenYearPct) : null
  // 확정 종가인지 장중 값인지 — date와 updated_at으로 판정한다(lib/usMarketSession.ts).
  const yieldStatus = tenYearYield ? usBarStatus(tenYearYield.date, tenYearYield.updated_at) : 'unknown'
  const yieldFetchedAt = tenYearYield ? formatKstDateTime(tenYearYield.updated_at) : ''
  const nasdaqChangePct =
    nasdaq && nasdaq.prev_close !== 0 ? ((nasdaq.close - nasdaq.prev_close) / nasdaq.prev_close) * 100 : null

  return (
    <div className="space-y-4">
      {/*
        490590 자체를 20일선·구조적 추세 같은 주식 기술적 기준으로 A/B/C 판정하던 절을
        뺐다 (2026-09-17, 사용자 판단). 490590은 커버드콜(콜옵션 매도) 파생 상품이라
        구성종목처럼 순수한 주가 흐름이 아니고, `research/checkTrancheGates.ts` 실측으로도
        그 판정이 매수 타이밍을 절반 가까이 늦추고 있었다(buildTrancheGuide 주석 참고) —
        "이 상품 자체를 이런 기준으로 판단하는 게 의미 없다"는 결론. 이제 490590 자체
        가격은 현재가와 차트로만 보여주고(원본 데이터), 판정(A/B/C·상승 전환 조건)은
        구성종목 신호등 쪽에만 둔다. `classifyStage`도 이제 구성종목에만 쓰인다.
      */}
      <Section title={`${ETF_NAME} 현재가`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">{ETF_TICKER}</span>
          {etfLatest && (
            <span className="text-sm font-semibold">
              {Math.round(etfLatest.close).toLocaleString('ko-KR')}원
              <span className="ml-1 font-normal text-muted-foreground">({etfLatest.date} 기준)</span>
            </span>
          )}
        </div>

        {!hasEtfData && (
          <p className="mt-2 text-sm text-muted-foreground">
            아직 490590 일봉 데이터가 없습니다. 종목 발굴 → 감시 종목에서 490590을 관심 종목으로
            추가하면, 다음 파이프라인 실행부터 자동으로 데이터가 쌓입니다.
          </p>
        )}

        {hasEtfData && (
          <button
            type="button"
            onClick={() => setChartOpen((v) => !v)}
            className="mt-2 text-xs text-muted-foreground hover:text-primary"
          >
            {chartOpen ? '차트 접기 ▴' : '차트 보기 ▾'}
          </button>
        )}
        {chartOpen && (
          <div className="mt-2 border-t border-border pt-3">
            {/* 위 판정이 20일선·거래량·저점을 보므로, 차트도 그걸 눈으로 확인할 수 있게
                20일선(기본 표시)·거래량에 매물대와 RSI를 함께 켠다. */}
            <LazyStockChart
              market={ETF_MARKET}
              ticker={ETF_TICKER}
              expanded={chartOpen}
              volume
              volumeProfile
              rsi
            />
            <dl className="mt-3 space-y-1.5 rounded-lg bg-muted/50 p-3 text-xs">
              <div>
                <dt className="font-semibold text-secondary-foreground">매물대 (왼쪽 회색 가로 막대)</dt>
                <dd className="text-muted-foreground">
                  어느 가격대에서 거래가 많았는지 보여줍니다. 막대가 길수록 그 가격에 사고판 사람이
                  많다는 뜻이라, 지금 가격보다 위에 있으면 저항(올라갈 때 물린 사람들의 매도),
                  아래에 있으면 지지로 작용하는 경향이 있습니다. 가장 두꺼운 가격대에는 ‘매물대’
                  점선이 그어집니다.
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-secondary-foreground">RSI (아래 보라색 선)</dt>
                <dd className="text-muted-foreground">
                  최근 14거래일 동안 오른 힘과 내린 힘의 비율을 0~100으로 나타낸 값입니다. 보통
                  30 아래면 “너무 많이 팔렸다(과매도)”, 70 위면 “너무 많이 샀다(과매수)”로 봅니다.
                  단, 하락 추세에서는 30 아래에 오래 머무를 수 있으니 이것만으로 사지 마세요.
                </dd>
              </div>
            </dl>
          </div>
        )}

        <p className="mt-3 text-xs leading-relaxed text-muted-foreground/70">
          NAV(순자산가치) 대비 시장가격 괴리율은 이 사이트가 아직 자동으로 확인하지 못합니다.{' '}
          <a
            href="https://finance.naver.com/item/main.naver?code=490590"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline"
          >
            네이버 금융에서 직접 확인
          </a>
          하세요.
        </p>
      </Section>

      <Section
        title="구성종목 신호등"
        subtitle={`비중 상위 ${judged.length}개로 판정합니다 — 개수가 아니라 비중으로 가늠합니다.`}
      >
        <div className="flex items-center gap-3">
          <span className="text-3xl leading-none">{proxyAssessment.trafficLight}</span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              상승 전환 비중 {(proxyAssessment.cStageWeightShare * 100).toFixed(0)}%
              <span className="ml-1 font-normal text-muted-foreground">
                ({proxyAssessment.cStageCount}/{proxyAssessment.evaluatedCount}종목)
              </span>
            </p>
            <p className="text-xs text-muted-foreground">{proxyAssessment.trafficLabel}</p>
          </div>
        </div>
        {/* 비중이 어느 시점 값인지 숨기지 않는다. 리밸런싱을 모르고 지나가 화면이
            조용히 틀린 바구니로 계산한 적이 있어서(2026-09-25) 만든 표시다. */}
        <p className="mt-1.5 text-xs text-muted-foreground/70">
          구성 {holdings.asOf} 기준 · 490590이 담은 미국 개별주는 {holdings.holdings.length}종목
          (ETF의 {heldWeight.toFixed(2)}%)이고, 그중 <b>비중 상위 {judged.length}개
          (ETF의 {judgedWeight.toFixed(2)}%)</b>로만 판정합니다. 아래 비중 %는 ETF 전체 기준이고,
          신호등은 이 {judged.length}개 안에서의 비중으로 매깁니다.
          나머지는 NASDAQ100 선물·원화현금과, 여기서 뺀 RISE 미국AI밸류체인TOP3Plus
          (엔비디아·알파벳·마벨을 다시 담아 중복), 그리고 매도한 콜옵션입니다.
          {holdings.autoCheckedAt && (
            <> 자동 점검은 {holdings.autoCheckedAt}까지 돌았습니다.</>
          )}
        </p>
        {/* 자동 수집(네이버)은 상위 10개를 **주식 수 순**으로만 줘서 64%밖에 못 덮는다.
            그래서 비중 계산에는 안 쓰고, "새 종목이 보인다"는 알람으로만 쓴다. */}
        {holdings.staleNames.length > 0 && (
          <p className="mt-1.5 rounded-md border-l-2 border-down bg-muted/50 p-2 text-xs text-down">
            ⚠ 자동 점검에서 목록에 없는 종목이 보입니다: {holdings.staleNames.join(', ')}.
            리밸런싱된 것 같으니 증권사 앱의 구성종목 화면을 확인해 주세요.
          </p>
        )}
        {holdings.unresolved.length > 0 && (
          <p className="mt-1.5 text-xs text-down">
            {holdings.unresolved.join(', ')}는 종목을 특정하지 못해 판정에서 빠졌습니다
            (비중 계산에서도 제외).
          </p>
        )}
        {proxyAssessment.evaluatedCount < judged.length && (
          <p className="mt-1.5 text-xs text-down">
            {judged.length - proxyAssessment.evaluatedCount}개 종목은 일봉 부족으로 판정에서 빠졌습니다
            (빠진 종목은 비중 계산에서도 제외됩니다).
          </p>
        )}

        <div className="mt-3 space-y-2">
          {judged.map(({ ticker: t, name, weight }) => {
            const r = proxyAssessment.perTicker[t]
            return (
              <div key={t} className="rounded-lg bg-muted/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {name} <span className="font-mono text-xs text-muted-foreground">{t}</span>
                    <span className="ml-1.5 rounded-full bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">
                      {weight.toFixed(2)}%
                    </span>
                  </span>
                  <StageBadge stage={r?.stage ?? null} />
                </div>
                {r ? (
                  <>
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {r.reasons.map((x) => (
                        <li key={x}>· {x}</li>
                      ))}
                    </ul>
                    {/* 8종목 × 조건을 다 펼치면 화면이 너무 길어져서, 여기선 이름과
                        ✓/✗만 칩으로 보여준다(왜·근거 숫자는 안 보여줌 — 개별 종목별로
                        보려면 너무 많다). */}
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {r.upturnConditions.map((c) => (
                        <ConditionChip key={c.label} met={c.met} label={c.label} />
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">일봉 부족으로 판정 불가</p>
                )}
              </div>
            )
          })}
        </div>
        {/* 판정에서 뺀 종목을 감추지 않는다. 개수만 적으면 "뭘 빼고 본 건지" 알 수 없고,
            나중에 리밸런싱으로 순위가 바뀌었을 때 바뀐 줄도 모르게 된다. */}
        {excluded.length > 0 && (
          <p className="mt-2.5 text-xs text-muted-foreground/70">
            판정에서 뺀 {excluded.length}종목 (합 {excluded.reduce((sum, h) => sum + h.weight, 0).toFixed(2)}%):{' '}
            {excluded.map((h) => `${h.name} ${h.weight.toFixed(2)}%`).join(' · ')}.
            비중이 서로 거의 같아 신호등을 흔들기만 하므로 제외했습니다 — 8위와 9위의
            차이는 {Math.abs(judged[judged.length - 1].weight - excluded[0].weight).toFixed(2)}%p라
            비중이 조금만 움직여도 자리가 바뀝니다.
          </p>
        )}
      </Section>

      <Section
        title="매수 중단 신호"
        subtitle="아래 중 하나라도 걸리면 추가 매수를 멈추기로 정해둔 기준입니다."
      >
        {/* 한 줄 결론을 맨 위에 — 항목을 다 읽고 머릿속에서 합치지 않아도 되게 한다.
            경고는 색만으로 구분하지 않는다: --accent(연한 파랑)와 --down(파랑)이 서로
            비슷해서 배경색만으로는 정상/경고가 한눈에 안 갈린다(2026-09-15 실측).
            그래서 정상은 중립 회색, 경고는 파랑 + 왼쪽 굵은 띠로 대비를 만든다. */}
        <div
          className={`rounded-lg p-3 ${
            stopVerdict.level === 'stop' ? 'border-l-4 border-down bg-down/10' : 'bg-muted'
          }`}
        >
          <p
            className={`text-sm font-bold ${
              stopVerdict.level === 'stop' ? 'text-down' : 'text-secondary-foreground'
            }`}
          >
            {stopVerdict.level === 'stop' ? '🚨 ' : '✅ '}
            {stopVerdict.headline}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-secondary-foreground">{stopVerdict.detail}</p>
        </div>

        <p className="mt-3 mb-1.5 text-xs font-semibold text-muted-foreground">자동으로 보는 4가지</p>
        <ul className="space-y-2">
          {stopSignals.map((s) => (
            <li
              key={s.id}
              className={`rounded-lg p-2.5 ${
                s.state === 'alert' ? 'border-l-4 border-down bg-down/10' : 'bg-muted/50'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <span className="text-xs text-muted-foreground">{s.topic}</span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    s.state === 'alert'
                      ? 'bg-down/10 text-down'
                      : s.state === 'ok'
                        ? 'bg-secondary text-secondary-foreground'
                        : 'bg-muted text-muted-foreground/70'
                  }`}
                >
                  {s.state === 'alert' ? '경고' : s.state === 'ok' ? '이상 없음' : '확인 불가'}
                </span>
              </div>
              <p
                className={`mt-0.5 text-sm font-medium ${
                  s.state === 'alert' ? 'text-down' : 'text-secondary-foreground'
                }`}
              >
                {s.headline}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">{s.detail}</p>
            </li>
          ))}
        </ul>

        {/* 자동 판정과 섞지 않고 따로 뗀다 — 여기 두 가지는 사용자가 직접 답해야 한다. */}
        <p className="mt-4 mb-1.5 text-xs font-semibold text-muted-foreground">
          직접 확인할 2가지 (뉴스를 봐야 알 수 있어 자동으로 판단하지 않습니다)
        </p>
        <ul className="space-y-2">
          {MANUAL_STOP_CHECKS.map((c) => (
            <li key={c.id} className="rounded-lg border border-dashed border-border p-2.5">
              <p className="text-sm font-medium text-secondary-foreground">🔎 {c.question}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{c.why}</p>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted-foreground/70">
          둘 중 하나라도 “그렇다”면, 위 4가지가 모두 이상 없어도 추가 매수를 멈추기로 한 기준입니다.
        </p>
      </Section>

      <Section title="분할매수 계획 (총 5,000만원)">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">지금까지 집행 표시</span>
          <span className="font-mono font-semibold">{investedManwon.toLocaleString('ko-KR')}만원</span>
        </div>
        <div className="mt-2 space-y-3">
          {tranches.map((t, i) => (
            <div
              key={t.order}
              className={`rounded-lg border p-3 ${done[i] ? 'border-primary bg-accent/40' : 'border-border bg-muted/30'}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold">
                  {t.order}차 · {t.amountManwon.toLocaleString('ko-KR')}만원{' '}
                  <span className="font-normal text-muted-foreground">
                    (누적 {t.cumulativeManwon.toLocaleString('ko-KR')}만원)
                  </span>
                </span>
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={done[i]}
                    onChange={() => toggleTranche(i)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  매수 완료로 표시
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {t.autoConditions.map((c) => (
                  <ConditionChip key={c.text} met={c.met} label={c.text} />
                ))}
              </div>
              {t.manualConditions.length > 0 && (
                <ul className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
                  {t.manualConditions.map((m) => (
                    <li key={m}>🔎 {m}</li>
                  ))}
                </ul>
              )}
              {t.autoReady && (
                <p className="mt-1.5 text-xs font-semibold text-up">
                  자동 조건은 충족 — 수동 확인 항목만 직접 판단하면 됩니다.
                </p>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground/70">
          “매수 완료로 표시”는 실제 주문을 넣지 않고 이 브라우저에만 기록하는 개인 체크입니다.
          조건이 충족돼도 매수를 강제하지 않습니다 — 최종 판단은 직접 하세요.
        </p>
      </Section>

      <Section title="FOMC 직후 체크 (직접 판단)">
        {/* 숫자만 던지면 "5.02%가 높은 건지 낮은 건지"를 알 수 없어, 수준과 그 뜻을
            바로 옆에 붙인다. 전일 대비는 −0.00처럼 반올림으로 생기는 가짜 부호를
            없애려고 0.005 미만이면 '거의 변동 없음'으로 적는다. */}
        <div className="rounded-lg bg-muted/50 p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xs text-muted-foreground">미국 10년물 국채 금리</span>
            <span className="font-mono text-lg font-bold">
              {tenYearPct !== null ? `${tenYearPct.toFixed(2)}%` : '데이터 없음'}
            </span>
            {yieldMeaning && (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">
                {yieldMeaning.level}
              </span>
            )}
            {tenYearChangePct !== null && (
              <span className="text-xs text-muted-foreground">
                (어제보다{' '}
                {Math.abs(tenYearChangePct) < 0.005
                  ? '거의 그대로'
                  : `${tenYearChangePct > 0 ? '+' : '−'}${Math.abs(tenYearChangePct).toFixed(2)}%p`}
                )
              </span>
            )}
          </div>
          {yieldMeaning && (
            <p className="mt-1.5 text-xs leading-relaxed text-secondary-foreground">
              미국 정부가 10년 동안 돈을 빌릴 때 주는 이자율입니다. {yieldMeaning.meaning}
            </p>
          )}
          {/* 언제 기준인지 반드시 밝힌다 — 날짜가 없으면 "뉴스는 5%인데 여기는 왜 4.96%냐"가
              된다(2026-09-15 실제 질문). 2026-09-15부터 4시간마다 받아오므로 미국장이 열려
              있는 동안(22:30~05:00 KST)에는 **아직 안 끝난 장중 값**이 들어온다 — 그걸
              "마감 종가"라고 적으면 거짓말이라 usBarStatus로 갈라 쓴다. */}
          {tenYearYield && (
            <p className="mt-1 text-xs text-muted-foreground/70">
              {yieldStatus === 'intraday' ? (
                <>
                  {tenYearYield.date} <span className="font-semibold">거래 중</span>인 값
                  {yieldFetchedAt && ` (한국시간 ${yieldFetchedAt} 기준)`} · 아직 그날이 끝나지
                  않아 더 움직일 수 있습니다.
                </>
              ) : yieldStatus === 'final' ? (
                <>{tenYearYield.date} 미국 채권시장이 닫힌 뒤 확정된 값입니다.</>
              ) : (
                <>{tenYearYield.date} 기준</>
              )}{' '}
              4시간마다 갱신됩니다. 미국 국채는 주식과 달리 한국 낮·저녁에도 거래되므로,
              주가지수와 기준일이 하루 다를 수 있습니다.
            </p>
          )}
          {nasdaqChangePct !== null && (
            <p className="mt-1 text-xs text-muted-foreground">
              나스닥 등락 {nasdaqChangePct >= 0 ? '+' : ''}
              {nasdaqChangePct.toFixed(2)}%
            </p>
          )}
        </div>
        <ul className="mt-3 space-y-1 text-xs text-secondary-foreground">
          <li>· 금리 결정이 시장 예상과 크게 다른가?</li>
          <li>· 연준 발언이 예상보다 매파적인가?</li>
          <li>· 나스닥이 FOMC 직후 급락하는가?</li>
          <li>· 다음 거래일에도 하락이 이어지는가?</li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          아래 뉴스는 네이버 뉴스검색 결과입니다. 직접 읽고 판단하세요 — 이 사이트가 대신 판단하지 않습니다.
        </p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <StockNewsFeed query="연준 FOMC 금리" />
          <StockNewsFeed query="AI 반도체 조정" />
        </div>
      </Section>

      <p className="text-xs leading-relaxed text-muted-foreground/70">
        이 화면은 매수 추천이 아니라 직접 정한 개인 매매 체크리스트를 자동화한 것입니다. 조건이 다
        맞아도 더 떨어질 수 있고, 하나도 안 맞아도 오를 수 있습니다. “많이 떨어졌으니 오르겠지”라는
        생각은 금지입니다.
      </p>
    </div>
  )
}
