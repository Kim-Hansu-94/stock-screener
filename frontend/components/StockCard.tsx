'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { calculateChangePercent, formatKrwAmount } from '@/lib/calculations'
import { StockChart } from './StockChart'
import type { Market, NewsArticle, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'
import type { RiskReason } from '@/lib/risk'
import { translateSector } from '@/lib/sectorMap'

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  market: Market
  usdKrwRate: number
  stop: number | null
  target: number | null
  riskReward: number | null
  riskReason: RiskReason
}

// 손익비가 산출되지 않은 사유를 화면 문구로 변환. 빈 "—"가 오류로 오인되지 않도록,
// 대부분은 "상승추세 미형성" 계열이라 계산을 생략한 정상 상태임을 설명한다.
const RISK_REASON_LABEL: Record<Exclude<RiskReason, 'ok'>, string> = {
  below_sma60: '추세 미형성 · 60일선 아래',
  sma60_falling: '추세 둔화 · 60일 평균 하락',
  insufficient_data: '데이터 부족',
  stop_above_entry: '손절 산출 불가',
}

// 종목 단위 눌림목 조건 개수 — pipeline/src/screener.py의 CRITERION_* 9개와 동기 유지.
// 하락장 날은 시장 단위 조건('시장 하락장')이 failed_criteria에 추가돼 분모가 1 늘어난다.
const STOCK_CRITERIA_COUNT = 9
const MARKET_BEAR_CRITERION = '시장 하락장'

// 현재가 대비 등락률을 부호와 함께 표시 (예: +7.2%, -4.1%)
function formatSignedPercent(price: number, base: number): string {
  const pct = ((price - base) / base) * 100
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}일 전`
}

export function StockCard({ stock, history, market, usdKrwRate, stop, target, riskReward, riskReason }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const [news, setNews] = useState<NewsArticle[] | null>(null)
  const [newsLoading, setNewsLoading] = useState(false)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

  const newsQuery = market === 'KR' ? (stock.name_kr || stock.name) : stock.ticker

  // 하락장 날은 시장 조건 1개가 더해져 분모가 10, 평상시엔 9.
  const totalCriteria =
    STOCK_CRITERIA_COUNT + (stock.failed_criteria.includes(MARKET_BEAR_CRITERION) ? 1 : 0)

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
              {stock.name_kr || stock.name}{' '}
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
        <div className="flex flex-wrap items-center gap-1 pt-1">
          {stock.passed === false ? (
            <>
              <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                조건 {totalCriteria - stock.failed_criteria.length}개 충족 (
                {totalCriteria - stock.failed_criteria.length}/{totalCriteria}) · 참고용
              </span>
              {stock.failed_criteria.map((criterion) => (
                <span
                  key={criterion}
                  className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500"
                >
                  {criterion}
                </span>
              ))}
            </>
          ) : (
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
              전 조건 충족 ({totalCriteria}/{totalCriteria})
            </span>
          )}
        </div>
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
            {riskReward !== null ? (
              <dd className={`font-semibold ${riskReward >= 2.0 ? 'text-green-600' : riskReward >= 1.5 ? 'text-amber-500' : 'text-red-500'}`}>
                {riskReward.toFixed(2)}R
              </dd>
            ) : (
              <dd className="text-xs text-gray-400">
                {riskReason === 'ok' ? '—' : RISK_REASON_LABEL[riskReason]}
              </dd>
            )}
          </div>
          {stop !== null && (
            <div>
              <dt className="text-gray-400">손절가</dt>
              <dd className="text-red-500">
                {market === 'KR' ? `${Math.round(stop).toLocaleString('ko-KR')}원` : `$${stop.toFixed(2)}`}
                {displayPrice > 0 && (
                  <span className="ml-1 text-xs text-red-400">({formatSignedPercent(stop, displayPrice)})</span>
                )}
              </dd>
            </div>
          )}
          {target !== null && (
            <div>
              <dt className="text-gray-400">목표가</dt>
              <dd className="text-green-600">
                {market === 'KR' ? `${Math.round(target).toLocaleString('ko-KR')}원` : `$${target.toFixed(2)}`}
                {displayPrice > 0 && (
                  <span className="ml-1 text-xs text-green-500">({formatSignedPercent(target, displayPrice)})</span>
                )}
              </dd>
            </div>
          )}
        </dl>
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
