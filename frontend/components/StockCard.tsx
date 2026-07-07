'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { calculateChangePercent, formatKrwAmount } from '@/lib/calculations'
import { StockChart } from './StockChart'
import type { FundamentalRow, Market, NewsArticle, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'
import { translateSector } from '@/lib/sectorMap'

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  market: Market
  usdKrwRate: number
  stop: number | null
  target: number | null
  riskReward: number | null
  fundamentals: FundamentalRow | null
}

function formatRatio(value: number | null, suffix = ''): string {
  if (value === null) return '—'
  return `${value.toFixed(1)}${suffix}`
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}일 전`
}

export function StockCard({ stock, history, market, usdKrwRate, stop, target, riskReward, fundamentals }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const [news, setNews] = useState<NewsArticle[] | null>(null)
  const [newsLoading, setNewsLoading] = useState(false)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

  const newsQuery = market === 'KR' ? (stock.name_kr ?? stock.name) : stock.ticker

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`/api/prices?tickers=${stock.ticker}&market=${market}`)
        if (!res.ok) return
        const data = (await res.json()) as Record<string, number | null>
        setLivePrice(data[stock.ticker] ?? null)
      } catch {
        // silently fall back to stored close
      } finally {
        setPriceLoading(false)
      }
    }
    load()
  }, [stock.ticker, market])

  useEffect(() => {
    if (!isExpanded || news !== null) return
    setNewsLoading(true)
    fetch(`/api/stock-news?q=${encodeURIComponent(newsQuery)}`)
      .then((r) => r.json())
      .then((d: { news?: NewsArticle[] }) => setNews(d.news ?? []))
      .catch(() => setNews([]))
      .finally(() => setNewsLoading(false))
  }, [isExpanded, newsQuery, news])

  const displayPrice = livePrice ?? stock.close
  const isLive = livePrice !== null

  const formatPrice = (price: number) =>
    market === 'US'
      ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${Math.round(price * usdKrwRate).toLocaleString('ko-KR')}원`
      : `${price.toLocaleString('ko-KR')}원`

  const pipelinePrice =
    market === 'US'
      ? `$${stock.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : `${stock.close.toLocaleString('ko-KR')}원`

  const marketCapDisplay =
    market === 'US' ? formatKrwAmount(stock.market_cap * usdKrwRate) : formatKrwAmount(stock.market_cap)

  return (
    <Card>
      <CardHeader className="cursor-pointer" onClick={() => setIsExpanded((current) => !current)}>
        <CardTitle className="flex items-start justify-between text-base">
          <span>
            <span className="block">
              {stock.name_kr ?? stock.name}{' '}
              <span className="text-gray-400">({stock.ticker})</span>
            </span>
            {stock.name_kr && (
              <span className="block text-xs font-normal text-gray-400">{stock.name}</span>
            )}
          </span>
          <Badge variant={changePercent !== null && changePercent < 0 ? 'destructive' : 'default'}>
            {changePercent === null ? '등락률 없음' : `${changePercent.toFixed(2)}%`}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="flex items-center gap-1 text-gray-400">
              현재가
              {!priceLoading && isLive && (
                <span className="rounded bg-green-50 px-1 text-xs font-medium text-green-600">실시간</span>
              )}
            </dt>
            <dd className={priceLoading ? 'text-gray-300' : ''}>{priceLoading ? '...' : formatPrice(displayPrice)}</dd>
            {!priceLoading && isLive && (
              <dd className="mt-0.5 text-xs text-gray-400">파이프라인: {pipelinePrice}</dd>
            )}
          </div>
          <div>
            <dt className="text-gray-400">시가총액</dt>
            <dd>{marketCapDisplay}</dd>
          </div>
          <div>
            <dt className="text-gray-400">섹터</dt>
            <dd>{translateSector(stock.sector)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">RSI</dt>
            <dd>{stock.rsi.toFixed(1)}</dd>
          </div>
          <div>
            <dt className="text-gray-400">손익비</dt>
            <dd className={`font-semibold ${riskReward === null ? 'text-gray-400' : riskReward >= 2.0 ? 'text-green-600' : riskReward >= 1.5 ? 'text-amber-500' : 'text-red-500'}`}>
              {riskReward !== null ? `${riskReward.toFixed(2)}R` : '—'}
            </dd>
          </div>
          {stop !== null && (
            <div>
              <dt className="text-gray-400">손절가</dt>
              <dd className="text-red-500">{market === 'KR' ? `${Math.round(stop).toLocaleString('ko-KR')}원` : `$${stop.toFixed(2)}`}</dd>
            </div>
          )}
          {target !== null && (
            <div>
              <dt className="text-gray-400">목표가</dt>
              <dd className="text-green-600">{market === 'KR' ? `${Math.round(target).toLocaleString('ko-KR')}원` : `$${target.toFixed(2)}`}</dd>
            </div>
          )}
        </dl>
        {fundamentals && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <p className="mb-1.5 text-xs font-medium text-gray-400">재무 지표</p>
            <dl className="grid grid-cols-4 gap-2 text-sm text-gray-600">
              <div>
                <dt className="text-xs text-gray-400">PER</dt>
                <dd>{formatRatio(fundamentals.per)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">PBR</dt>
                <dd>{formatRatio(fundamentals.pbr)}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">ROE</dt>
                <dd>{formatRatio(fundamentals.roe, '%')}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">배당수익률</dt>
                <dd>{formatRatio(fundamentals.dividend_yield, '%')}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">EPS</dt>
                <dd>{fundamentals.eps === null ? '—' : fundamentals.eps.toLocaleString(market === 'US' ? 'en-US' : 'ko-KR', { maximumFractionDigits: 2 })}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">매출성장률</dt>
                <dd className={fundamentals.revenue_growth !== null && fundamentals.revenue_growth < 0 ? 'text-red-500' : ''}>
                  {formatRatio(fundamentals.revenue_growth, '%')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-400">순이익률</dt>
                <dd className={fundamentals.profit_margin !== null && fundamentals.profit_margin < 0 ? 'text-red-500' : ''}>
                  {formatRatio(fundamentals.profit_margin, '%')}
                </dd>
              </div>
            </dl>
          </div>
        )}
        {isExpanded && (
          <div className="mt-4">
            <StockChart
              history={history}
              bollinger
              rsi
              stopPrice={stop ?? undefined}
              targetPrice={target ?? undefined}
            />
            {newsLoading && (
              <p className="mt-4 text-xs text-gray-400">뉴스 불러오는 중...</p>
            )}
            {!newsLoading && news && news.length > 0 && (
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}
