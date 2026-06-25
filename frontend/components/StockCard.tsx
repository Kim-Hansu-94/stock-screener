'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { calculateChangePercent } from '@/lib/calculations'
import { StockChart } from './StockChart'
import type { PriceHistoryRow, ScreenedStockRow } from '@/lib/types'

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
}

export function StockCard({ stock, history }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

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
            <dd>{stock.close.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-gray-400">시가총액</dt>
            <dd>{stock.market_cap.toLocaleString()}</dd>
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
