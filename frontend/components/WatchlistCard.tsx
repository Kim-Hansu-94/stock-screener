'use client'

import { useState } from 'react'
import type { Market, WatchlistStatusRow, WatchlistTickerRow } from '@/lib/types'
import { BUY_GRADE_CLASS, BUY_GRADE_CRITERIA, BUY_GRADE_LABEL, buyGrade } from '@/lib/buySignal'
import { StockNewsFeed } from '@/components/StockNewsFeed'
import { AddWatchlistForm, RemoveWatchlistButton } from '@/components/WatchlistActions'

// qualified_since ~ 평가일(as-of) 사이 일수. 시작일 당일을 1일째로 센다.
function accumulationDays(qualifiedSince: string, asOf: string): number {
  const start = new Date(`${qualifiedSince}T00:00:00Z`).getTime()
  const end = new Date(`${asOf}T00:00:00Z`).getTime()
  return Math.round((end - start) / 86_400_000) + 1
}

function CheckChip({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        ok
          ? 'bg-accent font-semibold text-accent-foreground'
          : 'bg-muted text-muted-foreground'
      }`}
    >
      {label} {ok ? '✓' : '✗'}
    </span>
  )
}

interface CombinedEntry {
  key: string
  market: Market
  ticker: string
  name: string
  status: WatchlistStatusRow | null
  /** 사이트에서 직접 추가한 종목만 삭제 버튼을 보여준다 (코드에 박힌 기본 종목은 대상 아님) */
  removable: boolean
}

// 보유/감시 종목이 횡보·조정 스크리너 기준(매수 매력도)에 도달했는지 매일 보여주는 카드.
// 파이프라인(watchlist.py)이 아침·저녁 실행마다 평가해 갱신한다.
//
// 감시 목록은 두 출처를 합친 것이다 — 코드에 박힌 기본 종목(watchlist.py의 WATCHLIST
// 상수)과, 사이트에서 직접 추가한 종목(watchlist_tickers 테이블, 아래 tickers prop).
// 후자는 방금 추가했으면 아직 파이프라인 평가 전(status가 없음)일 수 있어 "평가 대기"로
// 표시한다.
export function WatchlistCard({
  rows,
  tickers,
}: {
  rows: WatchlistStatusRow[]
  tickers: WatchlistTickerRow[]
}) {
  // 종목 수가 늘면서 뉴스를 다 펼쳐 두면 스크롤이 너무 길어져, 이름을 눌러야만
  // 그 종목 뉴스가 펼쳐지게 바꿨다(기본은 접힘). 펼치기 전엔 뉴스를 아예 불러오지도
  // 않는다 — StockNewsFeed를 펼쳤을 때만 렌더링하므로 안 열어본 종목은 API 호출도 없다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const statusMap = new Map(rows.map((r) => [`${r.market}-${r.ticker}`, r]))
  const seen = new Set<string>()
  const combined: CombinedEntry[] = []

  for (const t of tickers) {
    const key = `${t.market}-${t.ticker}`
    seen.add(key)
    combined.push({
      key,
      market: t.market,
      ticker: t.ticker,
      name: t.name,
      status: statusMap.get(key) ?? null,
      removable: true,
    })
  }
  for (const r of rows) {
    const key = `${r.market}-${r.ticker}`
    if (seen.has(key)) continue
    combined.push({ key, market: r.market, ticker: r.ticker, name: r.name ?? r.ticker, status: r, removable: false })
  }

  // 초록불 조건 = 스크리너 기준 통과 + 매수 등급(관망 아님). 통과만으로는
  // 매수 신호로 보지 않는다 — 등급 기준은 횡보·조정 탭과 동일하다.
  const grades = new Map(
    combined.map((e) => [
      e.key,
      e.status?.qualified ? buyGrade(e.status.score, e.status.higher_lows) : ('watch' as const),
    ]),
  )
  const anyQualified = [...grades.values()].some((grade) => grade !== 'watch')

  return (
    <section
      className={`space-y-3 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)] ${
        anyQualified ? 'ring-2 ring-primary/40' : ''
      }`}
    >
      <div>
        <h2 className="text-base font-bold">
          감시 종목
          {anyQualified && (
            <span className="ml-2 rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
              매수 신호 발생
            </span>
          )}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          횡보·조정 스크리너 기준(조정폭 20~60% · 신저가 진정 · 박스 수축)으로 매일 아침·저녁 평가합니다.
          뉴스·소문으로 관심 가는 종목은 스크리너 통과 여부와 상관없이 아래에서 직접 추가해 추적할 수 있습니다.
        </p>
        <p className="mt-1 text-xs text-accent-foreground">
          <span className="font-medium">매집 구간:</span> 하루짜리 신호가 아니라, 위 기준을 계속
          충족하는 동안 전체를 분할매수 창으로 봅니다 — 이 구간엔 언제 얼마씩 사도 됩니다.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <span className="font-medium">초록불(적극·매수검토) 조건:</span> 매집 구간 중 + {BUY_GRADE_CRITERIA}
        </p>
      </div>

      <AddWatchlistForm />

      {combined.length === 0 && (
        <p className="text-sm text-muted-foreground">아직 추가한 감시 종목이 없습니다.</p>
      )}

      {combined.map((entry) => (
        <div
          key={entry.key}
          className={`rounded-lg p-3 ${
            grades.get(entry.key) !== 'watch' ? 'bg-accent/60 ring-1 ring-primary/25' : 'bg-muted/50'
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => toggle(entry.key)}
              className="flex items-center gap-1 text-sm font-bold hover:text-primary"
            >
              <span className="text-xs text-muted-foreground">{expanded.has(entry.key) ? '▾' : '▸'}</span>
              {entry.name || entry.ticker}{' '}
              <span className="font-mono text-xs font-semibold text-muted-foreground">{entry.ticker}</span>
            </button>
            <div className="flex items-center gap-1.5">
              {entry.status?.qualified ? (
                <>
                  <span className="rounded-md bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                    매집 구간{' '}
                    {entry.status.qualified_since &&
                      `${accumulationDays(entry.status.qualified_since, entry.status.date)}일째`}
                  </span>
                  <span
                    className={`rounded-md px-2.5 py-0.5 text-xs font-semibold ${
                      BUY_GRADE_CLASS[grades.get(entry.key) ?? 'watch']
                    }`}
                  >
                    매력도 {Math.round((entry.status.score ?? 0) * 100)}점 ·{' '}
                    {BUY_GRADE_LABEL[grades.get(entry.key) ?? 'watch']}
                  </span>
                </>
              ) : entry.status ? (
                <span className="rounded-md bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                  대기 중
                </span>
              ) : (
                <span className="rounded-md bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                  평가 대기 (다음 파이프라인 실행 후 표시)
                </span>
              )}
              {entry.removable && <RemoveWatchlistButton market={entry.market} ticker={entry.ticker} />}
            </div>
          </div>
          {entry.status && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <CheckChip
                ok={entry.status.in_drawdown_band}
                label={`조정폭${entry.status.drawdown != null ? ` ${entry.status.drawdown.toFixed(0)}%` : ''}`}
              />
              <CheckChip ok={entry.status.no_new_low} label="신저가 진정" />
              <CheckChip ok={entry.status.box_ok} label="박스 수축" />
              {entry.status.qualified && (
                <>
                  <CheckChip ok={entry.status.higher_lows} label="저점 높이기" />
                  <CheckChip ok={entry.status.vcp} label="VCP" />
                  <CheckChip ok={entry.status.volume_dry} label="거래량 소진" />
                </>
              )}
            </div>
          )}
          {entry.status && !entry.status.qualified && entry.status.reason && (
            <p className="mt-2 text-xs text-muted-foreground">미달: {entry.status.reason}</p>
          )}
          {entry.status && <p className="mt-1 text-xs text-muted-foreground/70">평가일: {entry.status.date}</p>}
          {expanded.has(entry.key) ? (
            <StockNewsFeed
              query={entry.market === 'KR' ? entry.name || entry.ticker : entry.ticker}
              className="mt-3 border-t border-border pt-3"
            />
          ) : (
            <button
              type="button"
              onClick={() => toggle(entry.key)}
              className="mt-2 text-xs text-muted-foreground hover:text-primary"
            >
              뉴스 보기 ▾
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
