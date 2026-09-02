'use client'

import { useState, useEffect, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { translateSector, broadSector } from '@/lib/sectorMap'
import { formatKrwAmount } from '@/lib/calculations'
import { BUY_GRADE_CLASS, BUY_GRADE_CRITERIA, BUY_GRADE_LABEL, buyGrade } from '@/lib/buySignal'
import {
  EARNINGS_CLASS, EARNINGS_LABEL, EARNINGS_NOTE, ONE_TIME_GAIN_LABEL, ONE_TIME_GAIN_NOTE,
  PROFIT_SOURCE_LABEL, assessEarnings,
  FINANCIAL_HEALTH_CLASS, FINANCIAL_HEALTH_LABEL, FINANCIAL_HEALTH_NOTE, assessFinancialHealth,
} from '@/lib/fundamentals'
import { changeTextClass } from '@/lib/marketColors'
import { StockChart } from '@/components/StockChart'
import type { NewsArticle, OpportunityStockRow } from '@/lib/types'
import { BuyButton } from '@/components/TradeButton'

export function OpportunityTab({
  opportunities,
  opportunityError,
  usdKrwRate,
  ownedTickers,
}: {
  opportunities: OpportunityStockRow[]
  opportunityError: string | null
  usdKrwRate: number
  /** 이미 가상 매수해 둔 종목 키('KR:005930') 집합 */
  ownedTickers: string[]
}) {
  const [sectorFilter, setSectorFilter] = useState<string | null>(null)

  const krCount = opportunities.filter((s) => s.market === 'KR').length
  const usCount = opportunities.filter((s) => s.market === 'US').length
  const sectorOptions = Array.from(
    new Set(opportunities.map((s) => broadSector(s.sector))),
  ).sort((a, b) => a.localeCompare(b, 'ko'))
  const filteredOpportunities = sectorFilter
    ? opportunities.filter((s) => broadSector(s.sector) === sectorFilter)
    : opportunities

  return (
    <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <div className="mb-4">
        <h2 className="text-base font-bold">미래먹거리 횡보·조정 종목</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          코스피(시총 3,000억원 이상) 및 NASDAQ 100 · S&amp;P 500(시총 20억달러 이상) 종목 중
          3년 고점 대비 20–60% 조정받은 종목입니다.
          최근 20일 내 52주 신저가를 갱신 중이거나 최근 60일 박스폭이 30%를 넘는(횡보가 아닌) 종목은 제외하고,
          매도 소진 · 변동성 수축(VCP) · 저점 높이기 · 거래량 소진을 합산한 매수 매력도 순으로 정렬합니다.
          시총 하한은 장기 보유를 전제로 한 기준이라, 그 아래 소형주는 변동성·유동성 위험이 커서 제외합니다.
        </p>
        <p className="mt-2 text-xs text-accent-foreground">
          <span className="font-medium">매수 등급 기준:</span> {BUY_GRADE_CRITERIA}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium">읽을 때 주의:</span> 점수는 최근 6~12개월 가격 움직임만 봅니다.
          조정폭 판정 기준인 &ldquo;3년 고점&rdquo;이 이미 하락 중턱일 수 있어, 카드에 10년 고점 대비
          하락률을 함께 표시하고 장기 하락 종목에는 경고를 붙입니다. 차트도 10년 구간으로 보여줍니다.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-medium text-muted-foreground">데이터 출처:</span> 매일 아침 파이프라인이 갱신하는 Supabase 시세로 계산하며, 갱신 완료 즉시 다른 탭과 함께 반영됩니다.
          각 카드의 &ldquo;기준일&rdquo;은 그 종목 계산에 쓰인 최신 거래일입니다.
        </p>
        {opportunities.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            국장 <strong>{krCount}개</strong> · 미장 <strong>{usCount}개</strong> (총{' '}
            {opportunities.length}개)
          </p>
        )}
      </div>

      {sectorOptions.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setSectorFilter(null)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              sectorFilter === null
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-secondary'
            }`}
          >
            전체
          </button>
          {sectorOptions.map((sector) => (
            <button
              key={sector}
              type="button"
              onClick={() => setSectorFilter(sector)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                sectorFilter === sector
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-secondary'
              }`}
            >
              {sector}
            </button>
          ))}
        </div>
      )}

      {opportunityError ? (
        <p className="text-sm text-destructive">{opportunityError}</p>
      ) : opportunities.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          해당 조건의 종목이 없습니다. 파이프라인 실행 후 데이터가 채워집니다.
        </p>
      ) : filteredOpportunities.length === 0 ? (
        <p className="text-sm text-muted-foreground">해당 섹터에 종목이 없습니다.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {filteredOpportunities.map((stock) => (
            <OpportunityCard
              key={`${stock.market}-${stock.ticker}`}
              stock={stock}
              usdKrwRate={usdKrwRate}
              owned={ownedTickers.includes(`${stock.market}:${stock.ticker}`)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  return `${Math.floor(diffH / 24)}일 전`
}

function OpportunityCard({ stock, usdKrwRate, owned }: {
  stock: OpportunityStockRow
  usdKrwRate: number
  owned: boolean
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [chartReady, setChartReady] = useState(false)
  const [news, setNews] = useState<NewsArticle[] | null>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setChartReady(true)
          const newsUrl =
            stock.market === 'KR'
              ? `/api/stock-news?q=${encodeURIComponent(stock.name_kr || stock.name)}`
              : `/api/stock-news?ticker=${stock.ticker}`
          fetch(newsUrl)
            .then((r) => r.json())
            .then((d: { news?: NewsArticle[] }) => setNews(d.news ?? []))
            .catch(() => setNews([]))
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [stock.ticker, stock.market, stock.name_kr, stock.name])

  const drawdownStr = stock.drawdown.toFixed(1)
  // 조정폭은 고점에서 얼마나 내려왔는지(하락)라서 파랑 계열로 깊이를 표현한다.
  const drawdownClass =
    stock.drawdown >= 40
      ? 'bg-down text-primary-foreground'
      : stock.drawdown >= 25
        ? 'bg-down/15 text-down'
        : 'bg-muted text-muted-foreground'
  const grade = buyGrade(stock.score, stock.higherLows)
  const earnings = assessEarnings(stock.fundamentals)
  const health = assessFinancialHealth(stock.fundamentals, stock.sector)

  const formatPrice = (price: number) =>
    stock.market === 'KR'
      ? `${price.toLocaleString('ko-KR')}원`
      : `$${price.toFixed(2)}`

  const marketTag =
    stock.market === 'KR'
      ? (stock.index_membership ?? 'KR')
      : (stock.index_membership ?? 'US')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start justify-between text-base">
          <span>
            <span className="block">
              {stock.name_kr || stock.name}{' '}
              <span className="text-sm font-normal text-muted-foreground">({stock.ticker})</span>
            </span>
            {stock.name_kr && (
              <span className="block text-xs font-normal text-muted-foreground">{stock.name}</span>
            )}
          </span>
          {/* 점수가 아니라 실제 하락률이므로 %를 유지하되, 매력도 점수와 혼동되지
              않도록 "고점 대비"를 명시한다. */}
          <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold tabular-nums ${drawdownClass}`}>
            고점 대비 −{drawdownStr}%
          </span>
        </CardTitle>
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            기준일: {stock.asOfDate ? new Date(stock.asOfDate).toLocaleDateString('ko-KR') : '알 수 없음'}
          </p>
          <BuyButton
            market={stock.market}
            ticker={stock.ticker}
            name={stock.name_kr || stock.name}
            sector={stock.sector ?? ''}
            source="opportunity"
            owned={owned}
          />
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-secondary-foreground">
          <div>
            <dt className="text-xs text-muted-foreground">섹터</dt>
            <dd>{translateSector(stock.sector)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">지수</dt>
            <dd>{marketTag}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">현재가</dt>
            <dd>{formatPrice(stock.currentClose)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">3년 고점</dt>
            <dd>{formatPrice(stock.high3y)}</dd>
          </div>
          {stock.hasLongHistory && stock.longTermHigh != null && (
            <div>
              <dt className="text-xs text-muted-foreground">10년 고점</dt>
              <dd className={stock.longTermDeclining ? 'text-amber-700' : undefined}>
                {formatPrice(stock.longTermHigh)}
                {stock.longTermDrawdown != null && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({stock.longTermDrawdown.toFixed(0)}% 아래)
                  </span>
                )}
              </dd>
            </div>
          )}
          <div>
            <dt className="text-xs text-muted-foreground">시가총액</dt>
            <dd>
              {stock.marketCap != null
                ? formatKrwAmount(stock.market === 'KR' ? stock.marketCap : stock.marketCap * usdKrwRate)
                : '—'}
            </dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${BUY_GRADE_CLASS[grade]}`}>
            매력도 {Math.round(stock.score * 100)}점 · {BUY_GRADE_LABEL[grade]}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-secondary-foreground">
            저점 유지 {stock.daysSinceLow}일
          </span>
          {stock.vcp && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-secondary-foreground">VCP ✓</span>
          )}
          {stock.higherLows && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-secondary-foreground">저점↑</span>
          )}
          {stock.volumeDry && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-secondary-foreground">거래량 소진</span>
          )}
          {stock.alignedMAs && (
            <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">정배열</span>
          )}
          {stock.volumeTrigger && (
            <span className="rounded-md bg-accent px-2 py-0.5 text-xs font-semibold text-accent-foreground">거래량 급증</span>
          )}
          {stock.longTermDeclining && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
              ⚠️ 장기 하락 추세
            </span>
          )}
        </div>
        {stock.longTermDeclining && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
            3년 고점이 10년 고점보다 한참 낮습니다. 최근 몇 달의 바닥 다지기 모양과 별개로,
            여러 해에 걸친 하락이 이어지는 중일 수 있습니다. 점수는 최근 구간만 보므로
            아래 10년 차트로 큰 그림을 먼저 확인하세요.
          </p>
        )}

        {earnings.verdict !== 'unknown' && (
          <div className="mt-3 rounded-lg border border-border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">실적</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${EARNINGS_CLASS[earnings.verdict]}`}>
                {EARNINGS_LABEL[earnings.verdict]}
              </span>
              {earnings.years.prior != null && earnings.years.latest != null && (
                <span className="text-xs text-muted-foreground">
                  {earnings.years.prior} → {earnings.years.latest}
                </span>
              )}
              {earnings.oneTimeGainFlag && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
                  {ONE_TIME_GAIN_LABEL}
                </span>
              )}
            </div>
            <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground">
              {earnings.revenueChange != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">매출</dt>
                  <dd className={changeTextClass(earnings.revenueChange)}>
                    {earnings.revenueChange >= 0 ? '+' : ''}
                    {earnings.revenueChange.toFixed(0)}%
                  </dd>
                </div>
              )}
              {earnings.profitChange != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">
                    {earnings.profitSource != null ? PROFIT_SOURCE_LABEL[earnings.profitSource] : '이익'}
                  </dt>
                  <dd className={changeTextClass(earnings.profitChange)}>
                    {earnings.profitChange >= 0 ? '+' : ''}
                    {earnings.profitChange.toFixed(0)}%
                  </dd>
                </div>
              )}
              {stock.fundamentals?.per != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">PER</dt>
                  <dd>{stock.fundamentals.per.toFixed(1)}</dd>
                </div>
              )}
              {stock.fundamentals?.pbr != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">PBR</dt>
                  <dd>{stock.fundamentals.pbr.toFixed(2)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {EARNINGS_NOTE[earnings.verdict]}
            </p>
            {earnings.oneTimeGainFlag && (
              <p className="mt-1 text-xs leading-relaxed text-amber-800">{ONE_TIME_GAIN_NOTE}</p>
            )}
          </div>
        )}

        {health.verdict !== 'unknown' && (
          <div className="mt-3 rounded-lg border border-border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">재무건전성</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${FINANCIAL_HEALTH_CLASS[health.verdict]}`}>
                {FINANCIAL_HEALTH_LABEL[health.verdict]}
              </span>
            </div>
            <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-secondary-foreground">
              {health.currentRatio != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">유동비율</dt>
                  <dd>{health.currentRatio.toFixed(2)}</dd>
                </div>
              )}
              {health.debtToEquity != null && (
                <div className="flex gap-1">
                  <dt className="text-muted-foreground">부채/자본</dt>
                  <dd>{health.debtToEquity.toFixed(2)}</dd>
                </div>
              )}
            </dl>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              {FINANCIAL_HEALTH_NOTE[health.verdict]}
            </p>
            {health.debtToEquity != null && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                부채/자본은 업종별 편차가 커서(예: 제조업 4.0도 정상, 소프트웨어 0.0도 정상) 등급을 매기지 않습니다 — 참고용 숫자입니다.
              </p>
            )}
          </div>
        )}
        <div ref={sentinelRef} className="mt-4 min-h-80">
          {chartReady && (
            <StockChart monthly bollinger rsi preAggregated history={stock.history} />
          )}
        </div>

        {news !== null && news.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">최신 뉴스</p>
            <ul className="space-y-2.5">
              {news.map((article, i) => (
                <li key={i}>
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm leading-snug text-foreground hover:text-primary"
                  >
                    {article.title}
                  </a>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {article.publisher} · {formatRelativeTime(article.publishedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
