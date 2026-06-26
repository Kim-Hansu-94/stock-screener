'use client'

import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { calculateChangePercent, formatKrwAmount } from '@/lib/calculations'
import { StockChart } from './StockChart'
import type { Market, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'
import { translateSector } from '@/lib/sectorMap'

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  market: Market
  usdKrwRate: number
}

export function StockCard({ stock, history, market, usdKrwRate }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

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
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            {stock.name} <span className="text-gray-400">({stock.ticker})</span>
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
        </dl>
        {isExpanded && (
          <div className="mt-4">
            <StockChart history={history} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
