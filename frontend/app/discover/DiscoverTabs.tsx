'use client'

import { useState, useEffect, useRef } from 'react'
import { DailyReport } from './DailyReport'
import { SimilaritySearch } from './SimilaritySearch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { translateSector } from '@/lib/sectorMap'
import { StockChart } from '@/components/StockChart'
import type { NewsArticle, OpportunityStockRow, ScreenedStockWithRisk } from '@/lib/types'

type Tab = 'report' | 'search' | 'pullback' | 'opportunity'

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: '오늘의 추천' },
  { id: 'search', label: '패턴 검색' },
  { id: 'pullback', label: '눌림목' },
  { id: 'opportunity', label: '횡보 조정' },
]

export function DiscoverTabs({
  opportunities,
  opportunityError,
  pullbackKR,
  pullbackUS,
}: {
  opportunities: OpportunityStockRow[]
  opportunityError: string | null
  pullbackKR: ScreenedStockWithRisk[]
  pullbackUS: ScreenedStockWithRisk[]
}) {
  const [tab, setTab] = useState<Tab>('report')

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

      {tab === 'pullback' && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-gray-900">눌림목 종목</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              20일선과 10일선 사이에서 눌리는 중, RSI 40-60 상승 중, 거래량 감소 — 손익비 높은 순으로 정렬됩니다.
            </p>
          </div>
          {pullbackKR.length === 0 && pullbackUS.length === 0 ? (
            <p className="text-sm text-gray-500">
              스크리너 데이터가 없습니다. 파이프라인 실행 후 데이터가 채워집니다.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {[...pullbackKR, ...pullbackUS]
                .sort((a, b) => {
                  if (a.riskReward === null && b.riskReward === null) return 0
                  if (a.riskReward === null) return 1
                  if (b.riskReward === null) return -1
                  return b.riskReward - a.riskReward
                })
                .map((stock) => (
                  <PullbackCard key={`${stock.market}-${stock.ticker}`} stock={stock} />
                ))}
            </div>
          )}
        </section>
      )}

      {tab === 'opportunity' && (
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-gray-900">미래먹거리 횡보·조정 종목</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              코스피 · 코스닥 및 NASDAQ 100 · S&amp;P 500 종목 중 3년 고점 대비 20–60% 조정받은 종목입니다.
            </p>
          </div>
          {opportunityError ? (
            <p className="text-sm text-red-600">{opportunityError}</p>
          ) : opportunities.length === 0 ? (
            <p className="text-sm text-gray-500">
              해당 조건의 종목이 없습니다. 파이프라인 실행 후 데이터가 채워집니다.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {opportunities.map((stock) => (
                <OpportunityCard key={`${stock.market}-${stock.ticker}`} stock={stock} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function rrColor(rr: number | null): string {
  if (rr === null) return 'text-gray-400'
  if (rr >= 2.0) return 'text-green-600'
  if (rr >= 1.5) return 'text-amber-500'
  return 'text-red-500'
}

function PullbackCard({ stock }: { stock: ScreenedStockWithRisk }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [chartReady, setChartReady] = useState(false)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setChartReady(true)
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [stock.ticker])

  const fmt = (price: number) =>
    stock.market === 'KR'
      ? `${price.toLocaleString('ko-KR')}원`
      : `$${price.toFixed(2)}`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-start justify-between text-base">
          <span>
            {stock.name}{' '}
            <span className="text-sm font-normal text-gray-400">({stock.ticker})</span>
          </span>
          <Badge variant="outline">{stock.market}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-xs text-gray-400">섹터</dt>
            <dd>{translateSector(stock.sector)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">RSI</dt>
            <dd>{stock.rsi.toFixed(1)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">진입가</dt>
            <dd>{fmt(stock.entryPrice)}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">손익비</dt>
            <dd className={`font-semibold ${rrColor(stock.riskReward)}`}>
              {stock.riskReward !== null ? `${stock.riskReward.toFixed(2)}R` : '—'}
            </dd>
          </div>
          {stock.stop !== null && (
            <div>
              <dt className="text-xs text-gray-400">손절가</dt>
              <dd className="text-red-500">{fmt(stock.stop)}</dd>
            </div>
          )}
          {stock.target !== null && (
            <div>
              <dt className="text-xs text-gray-400">목표가</dt>
              <dd className="text-green-600">{fmt(stock.target)}</dd>
            </div>
          )}
        </dl>
        <div ref={sentinelRef} className="mt-4 min-h-64">
          {chartReady && (
            <StockChart
              history={stock.history}
              stopPrice={stock.stop ?? undefined}
              targetPrice={stock.target ?? undefined}
            />
          )}
        </div>
      </CardContent>
    </Card>
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
              {stock.name_kr ?? stock.name}{' '}
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
