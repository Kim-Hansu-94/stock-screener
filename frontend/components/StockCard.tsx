'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { calculateChangePercent, formatKrwAmount } from '@/lib/calculations'
import { StockChart } from './StockChart'
import type { Market, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  market: Market
  usdKrwRate: number
}

export function StockCard({ stock, history, market, usdKrwRate }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

  const priceDisplay =
    market === 'US'
      ? `$${stock.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / ${Math.round(stock.close * usdKrwRate).toLocaleString('ko-KR')}원`
      : `${stock.close.toLocaleString('ko-KR')}원`

  const marketCapDisplay =
    market === 'US'
      ? formatKrwAmount(stock.market_cap * usdKrwRate)
      : formatKrwAmount(stock.market_cap)

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
            <dt className="text-gray-400">현재가</dt>
            <dd>{priceDisplay}</dd>
          </div>
          <div>
            <dt className="text-gray-400">시가총액</dt>
            <dd>{marketCapDisplay}</dd>
          </div>
          <div>
            <dt className="text-gray-400">섹터</dt>
            <dd>{stock.sector}</dd>
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
