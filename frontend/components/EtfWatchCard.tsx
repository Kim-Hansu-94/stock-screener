'use client'

import { useEffect, useState } from 'react'
import { LazyStockChart } from '@/components/LazyStockChart'
import { StockNewsFeed } from '@/components/StockNewsFeed'
import {
  ETF_MARKET,
  ETF_NAME,
  ETF_TICKER,
  PROXY_NAMES,
  PROXY_TICKERS,
  type ProxyBasketAssessment,
  type StageResult,
  type StopSignal,
  type TrancheStep,
} from '@/lib/etfEntryCheck'
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
  proxyAssessment,
  etfStage,
  etfLatest,
  hasEtfData,
  tranches,
  stopSignals,
  tenYearYield,
  nasdaq,
}: {
  proxyAssessment: ProxyBasketAssessment
  etfStage: StageResult | null
  etfLatest: { close: number; date: string } | null
  hasEtfData: boolean
  tranches: TrancheStep[]
  stopSignals: StopSignal[]
  tenYearYield: MarketIndexSnapshotRow | null
  nasdaq: MarketIndexSnapshotRow | null
}) {
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
  const autoTriggeredStop = stopSignals.some((s) => s.automatic && s.triggered === true)
  const tenYearPct = tenYearYield ? tenYearYield.close / 10 : null
  const tenYearChangePct = tenYearYield ? (tenYearYield.close - tenYearYield.prev_close) / 10 : null
  const nasdaqChangePct =
    nasdaq && nasdaq.prev_close !== 0 ? ((nasdaq.close - nasdaq.prev_close) / nasdaq.prev_close) * 100 : null

  return (
    <div className="space-y-4">
      <Section title={`${ETF_NAME} 자체 판정`}>
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-xs text-muted-foreground">{ETF_TICKER}</span>
          <StageBadge stage={etfStage?.stage ?? null} />
        </div>

        {!hasEtfData ? (
          <p className="mt-2 text-sm text-muted-foreground">
            아직 490590 일봉 데이터가 없습니다. 종목 발굴 → 감시 종목에서 490590을 관심 종목으로
            추가하면, 다음 파이프라인 실행부터 자동으로 데이터가 쌓입니다.
          </p>
        ) : etfStage === null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            일봉이 아직 부족해 단계를 판정할 수 없습니다 (최소 66거래일 필요).
            {etfLatest && ` 현재가 ${Math.round(etfLatest.close).toLocaleString('ko-KR')}원 (${etfLatest.date} 기준)`}
          </p>
        ) : (
          <>
            <p className="mt-1.5 text-xs text-muted-foreground">
              기준일 {etfStage.detail.date} · 종가 {Math.round(etfStage.detail.close).toLocaleString('ko-KR')}원
            </p>
            <ul className="mt-1.5 space-y-0.5 text-xs text-secondary-foreground">
              {etfStage.reasons.map((r) => (
                <li key={r}>· {r}</li>
              ))}
            </ul>
          </>
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
            <LazyStockChart market={ETF_MARKET} ticker={ETF_TICKER} expanded={chartOpen} volume />
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
        title="대장주 5개 신호등"
        subtitle="오라클·알파벳·엔비디아·AMD·마벨 테크놀로지 — 상승 전환한 종목 수로 매수 타이밍을 가늠합니다."
      >
        <div className="flex items-center gap-3">
          <span className="text-3xl leading-none">{proxyAssessment.trafficLight}</span>
          <div>
            <p className="text-sm font-semibold">{proxyAssessment.cStageCount}/5개 상승 전환</p>
            <p className="text-xs text-muted-foreground">{proxyAssessment.trafficLabel}</p>
          </div>
        </div>
        {proxyAssessment.evaluatedCount < PROXY_TICKERS.length && (
          <p className="mt-1.5 text-xs text-down">
            {PROXY_TICKERS.length - proxyAssessment.evaluatedCount}개 종목은 일봉 부족으로 판정에서 빠졌습니다.
          </p>
        )}

        <div className="mt-3 space-y-2">
          {PROXY_TICKERS.map((t) => {
            const r = proxyAssessment.perTicker[t]
            return (
              <div key={t} className="rounded-lg bg-muted/50 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">
                    {PROXY_NAMES[t]} <span className="font-mono text-xs text-muted-foreground">{t}</span>
                  </span>
                  <StageBadge stage={r?.stage ?? null} />
                </div>
                {r ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    {r.reasons.map((x) => (
                      <li key={x}>· {x}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">일봉 부족으로 판정 불가</p>
                )}
              </div>
            )
          })}
        </div>
      </Section>

      {autoTriggeredStop && (
        <div className="rounded-xl bg-down/10 p-3 text-sm font-semibold text-down">
          🚨 자동 매수 중단 신호가 감지됐습니다 — 아래 목록을 확인하세요.
        </div>
      )}

      <Section title="🚨 매수 중단 신호" subtitle="하나라도 걸리면 추가 매수를 멈추기로 정한 기준입니다.">
        <ul className="space-y-1.5">
          {stopSignals.map((s) => (
            <li key={s.id} className="flex items-start gap-2 text-xs">
              <span
                className={
                  !s.automatic
                    ? 'text-muted-foreground'
                    : s.triggered === true
                      ? 'font-bold text-down'
                      : s.triggered === false
                        ? 'text-up'
                        : 'text-muted-foreground'
                }
              >
                {!s.automatic ? '🔎' : s.triggered === true ? '🚨' : s.triggered === false ? '✓' : '—'}
              </span>
              <span>
                <span className="font-medium text-secondary-foreground">{s.label}</span>{' '}
                <span className="text-muted-foreground">— {s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
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
        <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">미국 10년물 금리</dt>
            <dd className="font-mono">{tenYearPct !== null ? `${tenYearPct.toFixed(2)}%` : '데이터 없음'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">10년물 전일 대비</dt>
            <dd className="font-mono">{tenYearChangePct !== null ? `${tenYearChangePct >= 0 ? '+' : ''}${tenYearChangePct.toFixed(2)}%p` : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">나스닥 등락</dt>
            <dd className="font-mono">{nasdaqChangePct !== null ? `${nasdaqChangePct >= 0 ? '+' : ''}${nasdaqChangePct.toFixed(2)}%` : '—'}</dd>
          </div>
        </dl>
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
