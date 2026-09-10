'use client'

import { useState } from 'react'
import type { Market, PriceHistoryRow, WatchlistTickerRow } from '@/lib/types'
import {
  assessSupportSignals,
  drawdownFromHigh,
  profitLossPct,
  summarizeSupportSignals,
} from '@/lib/supportSignals'
import { changeTextClass } from '@/lib/marketColors'
import { StockNewsFeed } from '@/components/StockNewsFeed'
import { AddWatchlistForm, EditAvgCostButton, RemoveWatchlistButton } from '@/components/WatchlistActions'
import { AverageCostCalculator } from '@/components/AverageCostCalculator'
import { LazyStockChart } from '@/components/LazyStockChart'
import { MarketExtrasPanel } from '@/components/MarketExtrasPanel'


// 지지 신호 점검에 쓰는 120일선을 차트에도 같이 그린다. 박스 구간(회색 점선)은
// 일부러 뺐다 — 그건 "조용히 매집 중인가"를 보는 지표라 포지션 관리 목적과 안 맞는다.
const POSITION_MOVING_AVERAGES = [
  { window: 5, color: '#2563eb' },
  { window: 20, color: '#d97706' },
  { window: 60, color: '#7c3aed' },
  { window: 120, color: '#0891b2' },
]

function SignalChip({ met, label }: { met: boolean | null; label: string }) {
  if (met === null) {
    return (
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground/70">{label} —</span>
    )
  }
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

function formatPrice(value: number, market: Market): string {
  return market === 'KR'
    ? `${Math.round(value).toLocaleString('ko-KR')}원`
    : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/**
 * 포지션 관리 — 이미 보유 중인 종목의 "지금 지지 신호가 몇 개 겹쳐 있는지"를 보여준다.
 *
 * 매집 감시(WatchlistCard)와 목적이 다르다. 그쪽은 아직 안 산 종목이 조용한 매집
 * 구간에 들어왔는지(박스 수축 등)를 보지만, 여기는 이미 큰 포지션을 들고 추가 매수를
 * 고민하는 상황이라 박스 수축을 요구하지 않는다 — 변동성 큰 대형주는 그 조건에
 * 구조적으로 영원히 걸리지 않아, 안 맞는 잣대를 들이대는 꼴이 되기 때문이다.
 *
 * 조건 충족 개수를 하나의 "매수 등급"으로 합치지 않는 것도 의도적이다. 지지선처럼
 * 보이는 자리는 뚫리기도 하므로, 근거를 감춘 초록불 대신 조건별 숫자를 그대로 보여준다.
 */
export function PositionCard({
  tickers,
  history,
}: {
  tickers: WatchlistTickerRow[]
  /** `${market}-${ticker}` 키의 일봉 */
  history: Record<string, PriceHistoryRow[]>
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <section className="space-y-3 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <div>
        <h2 className="text-base font-bold">포지션 관리</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          이미 보유 중인 종목입니다. 추가 매수(물타기)를 고민할 때 참고하도록, 지지 신호로 흔히
          쓰이는 5개 조건이 지금 몇 개나 겹쳐 있는지 매일 점검해 보여줍니다.
        </p>
      </div>

      <AddWatchlistForm defaultCategory="position" />

      {tickers.length === 0 && (
        <p className="text-sm text-muted-foreground">아직 등록한 보유 종목이 없습니다.</p>
      )}

      {tickers.map((entry) => {
        const key = `${entry.market}-${entry.ticker}`
        const bars = history[key] ?? []
        const latest = bars.length > 0 ? bars[bars.length - 1] : null
        const assessment = assessSupportSignals(bars)
        const { signals, metCount, evaluatedCount } = assessment
        const summary = summarizeSupportSignals(assessment)
        const pl = latest ? profitLossPct(entry.avg_cost, latest.close) : null
        const dd = drawdownFromHigh(bars)

        return (
          <div key={key} className="rounded-lg bg-muted/50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => toggle(key)}
                className="flex items-center gap-1 text-sm font-bold hover:text-primary"
              >
                <span className="text-xs text-muted-foreground">{expanded.has(key) ? '▾' : '▸'}</span>
                {entry.name || entry.ticker}{' '}
                <span className="font-mono text-xs font-semibold text-muted-foreground">{entry.ticker}</span>
              </button>
              <div className="flex items-center gap-1.5">
                {evaluatedCount > 0 && (
                  <span className="rounded-md bg-secondary px-2.5 py-0.5 text-xs font-semibold text-secondary-foreground">
                    지지 신호 {metCount}/{evaluatedCount}
                  </span>
                )}
                <RemoveWatchlistButton market={entry.market} ticker={entry.ticker} />
              </div>
            </div>

            {latest ? (
              <>
                <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-secondary-foreground">
                  <div className="flex items-center gap-1">
                    <dt className="text-muted-foreground">평단가</dt>
                    <dd className="font-mono">
                      {entry.avg_cost != null ? formatPrice(entry.avg_cost, entry.market) : '미입력'}
                    </dd>
                    {/* 물타기를 하면 평단가가 바뀌므로 그 자리에서 고칠 수 있게 한다. */}
                    <EditAvgCostButton
                      market={entry.market}
                      ticker={entry.ticker}
                      avgCost={entry.avg_cost}
                    />
                  </div>
                  <div className="flex gap-1">
                    <dt className="text-muted-foreground">현재가</dt>
                    <dd className="font-mono">{formatPrice(latest.close, entry.market)}</dd>
                  </div>
                  {pl != null && (
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">손익률</dt>
                      <dd className={`font-mono font-semibold ${changeTextClass(pl)}`}>
                        {pl >= 0 ? '+' : ''}
                        {pl.toFixed(1)}%
                      </dd>
                    </div>
                  )}
                  {dd != null && (
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">최근 고점 대비</dt>
                      <dd className="font-mono">{dd.toFixed(1)}%</dd>
                    </div>
                  )}
                </dl>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {signals.map((s) => (
                    <SignalChip key={s.id} met={s.met} label={s.label} />
                  ))}
                </div>

                {summary && (
                  <p className="mt-2 rounded-md bg-accent/60 px-2.5 py-2 text-xs leading-relaxed text-accent-foreground">
                    {summary.text}
                  </p>
                )}

                <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                  {signals.map((s) => (
                    <li key={s.id}>
                      <span className="text-muted-foreground/70">{s.label}:</span> {s.detail}
                    </li>
                  ))}
                </ul>

                <p className="mt-2 text-xs leading-relaxed text-muted-foreground/70">
                  이 점검은 매수 추천이 아닙니다. 조건이 다 겹쳐도 더 떨어질 수 있고, 하나도 안
                  겹쳐도 반등할 수 있습니다. 최종 판단은 직접 하세요.
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">기준일: {latest.date}</p>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                시세 데이터가 아직 없습니다 (다음 파이프라인 실행 후 표시).
              </p>
            )}

            {expanded.has(key) ? (
              <>
                {latest && (
                  <div className="mt-3 border-t border-border pt-3">
                    <AverageCostCalculator
                      market={entry.market}
                      ticker={entry.ticker}
                      currentPrice={latest.close}
                      savedAvgCost={entry.avg_cost}
                    />
                  </div>
                )}
                <MarketExtrasPanel
                  market={entry.market}
                  ticker={entry.ticker}
                  close={latest?.close ?? null}
                  className="mt-3 border-t border-border pt-3"
                />
                <div className="mt-3 border-t border-border pt-3">
                  {/* 지지 신호 판정에 쓰는 일봉(180봉)과 달리, 차트는 더 긴 구간을
                      보고 싶은 자리라 펼쳤을 때 500봉을 따로 받아온다. */}
                  <LazyStockChart
                    market={entry.market}
                    ticker={entry.ticker}
                    expanded
                    volume
                    ichimoku
                    movingAverages={POSITION_MOVING_AVERAGES}
                  />
                </div>
                <StockNewsFeed
                  query={entry.market === 'KR' ? entry.name || entry.ticker : entry.ticker}
                  className="mt-3 border-t border-border pt-3"
                />
                <button
                  type="button"
                  onClick={() => toggle(key)}
                  className="mt-2 text-xs text-muted-foreground hover:text-primary"
                >
                  접기 ▴
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => toggle(key)}
                className="mt-2 text-xs text-muted-foreground hover:text-primary"
              >
                평단 계산기·차트·뉴스 보기 ▾
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
