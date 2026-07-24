'use client'

import { useEffect, useState } from 'react'
import { StockCard } from './StockCard'
import type { Market, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'
import type { RiskReason } from '@/lib/risk'

export type StockCardData = {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  stop: number | null
  target: number | null
  riskReward: number | null
  riskReason: RiskReason
}

interface StockCardGridProps {
  cards: StockCardData[]
  market: Market
  usdKrwRate: number
}

// 카드마다 /api/prices를 개별 호출하면 종목 수만큼 요청·서버리스 호출이 생겨
// 모바일에서 특히 느리다. 섹션의 전 종목을 한 번에 조회해 각 카드에 내려준다.
export function StockCardGrid({ cards, market, usdKrwRate }: StockCardGridProps) {
  const [prices, setPrices] = useState<Record<string, number | null> | null>(null)
  const tickersKey = cards.map((card) => card.stock.ticker).join(',')

  useEffect(() => {
    if (!tickersKey) return
    let cancelled = false
    fetch(`/api/prices?tickers=${tickersKey}&market=${market}`)
      .then((res) => (res.ok ? (res.json() as Promise<Record<string, number | null>>) : {}))
      .then((data) => {
        if (!cancelled) setPrices(data)
      })
      .catch(() => {
        // 실패 시 저장된 종가로 폴백 (livePrice=null)
        if (!cancelled) setPrices({})
      })
    return () => {
      cancelled = true
    }
  }, [tickersKey, market])

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map((card) => (
        <StockCard
          key={card.stock.ticker}
          stock={card.stock}
          history={card.history}
          market={market}
          usdKrwRate={usdKrwRate}
          stop={card.stop}
          target={card.target}
          riskReward={card.riskReward}
          riskReason={card.riskReason}
          livePrice={prices?.[card.stock.ticker] ?? null}
          priceLoading={prices === null}
        />
      ))}
    </div>
  )
}
