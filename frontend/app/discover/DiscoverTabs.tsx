'use client'

import { useState, useEffect, useRef } from 'react'
import { DailyReport } from './DailyReport'
import { SimilaritySearch } from './SimilaritySearch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { translateSector, broadSector } from '@/lib/sectorMap'
import { StockChart } from '@/components/StockChart'
import type { NewsArticle, OpportunityStockRow } from '@/lib/types'

type Tab = 'report' | 'search' | 'opportunity'

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: '오늘의 추천' },
  { id: 'search', label: '패턴 검색' },
  { id: 'opportunity', label: '횡보 조정 종목' },
]

export function DiscoverTabs({
  opportunities,
  opportunityError,
}: {
  opportunities: OpportunityStockRow[]
  opportunityError: string | null
}) {
  const [tab, setTab] = useState<Tab>('report')
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
    <div className="space-y-5">
      <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'report' && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-gray-900">오늘의 추천 종목</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Gold Standard 5종목(QBTS · RGTI · AEVA · JOBY · FCEL)의 바닥 패턴과 싱크로율이 가장 높은 상위 20종목을 매일 자동 스캔합니다.
            </p>
            <div className="mt-2 space-y-0.5 text-xs text-gray-400">
              <p><span className="font-medium text-gray-500">Gold 패턴 출처:</span> 파이프라인 사전 계산 (Supabase)</p>
              <p><span className="font-medium text-gray-500">비교 대상 출처:</span> 파이프라인이 수집한 Russell 3000 전 종목 (Supabase)</p>
            </div>
          </div>
          <DailyReport />
        </section>
      )}

      {tab === 'search' && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-gray-900">패턴 유사 종목 검색</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              티커를 입력하면 현재 비슷하게 움직이는 종목을 찾아드립니다. 아이디어 검증 및 차트 공부용입니다.
            </p>
            <div className="mt-2 space-y-0.5 text-xs text-gray-400">
              <p><span className="font-medium text-gray-500">기준 종목 출처:</span> Yahoo Finance 실시간 (입력한 티커를 직접 다운로드)</p>
              <p><span className="font-medium text-gray-500">비교 대상 출처:</span> 파이프라인이 수집한 Russell 3000 전 종목 (Supabase)</p>
            </div>
          </div>
          <SimilaritySearch />
        </section>
      )}

      {tab === 'opportunity' && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-gray-900">미래먹거리 횡보·조정 종목</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              코스피 및 NASDAQ 100 · S&amp;P 500 종목 중 3년 고점 대비 20–60% 조정받은 종목입니다.
            </p>
            {opportunities.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
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
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
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
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {sector}
                </button>
              ))}
            </div>
          )}

          {opportunityError ? (
            <p className="text-sm text-red-600">{opportunityError}</p>
          ) : opportunities.length === 0 ? (
            <p className="text-sm text-gray-500">
              해당 조건의 종목이 없습니다. 파이프라인 실행 후 데이터가 채워집니다.
            </p>
          ) : filteredOpportunities.length === 0 ? (
            <p className="text-sm text-gray-500">해당 섹터에 종목이 없습니다.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {filteredOpportunities.map((stock) => (
                <OpportunityCard key={`${stock.market}-${stock.ticker}`} stock={stock} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  return `${Math.floor(diffH / 24)}일 전`
}

function OpportunityCard({ stock }: { stock: OpportunityStockRow }) {
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
          if (stock.market === 'US') {
            fetch(`/api/stock-news?ticker=${stock.ticker}`)
              .then((r) => r.json())
              .then((d: { news?: NewsArticle[] }) => setNews(d.news ?? []))
              .catch(() => setNews([]))
          }
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [stock.ticker, stock.market])

  const drawdownStr = stock.drawdown.toFixed(1)
  const variant =
    stock.drawdown >= 40 ? 'destructive' : stock.drawdown >= 25 ? 'secondary' : 'outline'

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
              <span className="text-sm font-normal text-gray-400">({stock.ticker})</span>
            </span>
            {stock.name_kr && (
              <span className="block text-xs font-normal text-gray-400">{stock.name}</span>
            )}
          </span>
          <Badge variant={variant}>-{drawdownStr}%</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-xs text-gray-400">섹터</dt>
            <dd>{translateSector(stock.sector)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">지수</dt>
            <dd>{marketTag}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">현재가</dt>
            <dd>{formatPrice(stock.currentClose)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">3년 고점</dt>
            <dd>{formatPrice(stock.high3y)}</dd>
          </div>
        </dl>
        <div ref={sentinelRef} className="mt-4 min-h-80">
          {chartReady && (
            <StockChart monthly bollinger rsi preAggregated history={stock.history} />
          )}
        </div>

        {news !== null && news.length > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <p className="mb-2 text-xs font-medium text-gray-400">최신 뉴스</p>
            <ul className="space-y-2.5">
              {news.map((article, i) => (
                <li key={i}>
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm leading-snug text-gray-800 hover:text-blue-600"
                  >
                    {article.title}
                  </a>
                  <p className="mt-0.5 text-xs text-gray-400">
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
