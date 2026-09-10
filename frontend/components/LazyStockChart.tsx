'use client'

import dynamic from 'next/dynamic'
import { LoadingFallback } from '@/components/LoadingFallback'
import { useLazyPriceHistory } from '@/lib/useLazyPriceHistory'
import type { Market } from '@/lib/types'
import type { ComponentProps } from 'react'

const StockChart = dynamic(
  () => import('./StockChart').then((mod) => mod.StockChart),
  { ssr: false, loading: () => <LoadingFallback label="차트 로딩 중..." className="py-8" /> },
)

type ChartOptions = Omit<ComponentProps<typeof StockChart>, 'history'>

/**
 * 카드를 펼쳤을 때 그 종목의 일봉을 받아 그리는 차트.
 *
 * 예전에는 화면이 표시되는 **모든 종목의 일봉을 미리** 서버에서 받아 클라이언트로
 * 내려보냈다. 종목발굴 탭은 감시 종목 30개 × 500봉을 그렇게 보내고 있었는데, 차트는
 * 펼쳐야 뜨므로 그 대부분이 한 번도 안 쓰이고 버려졌다. 탭 전환이 느린 원인이었다.
 */
export function LazyStockChart({
  market,
  ticker,
  expanded,
  days = 500,
  ...options
}: { market: Market; ticker: string; expanded: boolean; days?: number } & ChartOptions) {
  const { history, loading, error } = useLazyPriceHistory(market, ticker, expanded, days)

  if (loading) return <LoadingFallback label="차트 로딩 중..." className="py-8" />
  if (error) return <p className="py-4 text-xs text-down">차트를 불러오지 못했습니다: {error}</p>
  if (history.length === 0) {
    return <p className="py-4 text-xs text-muted-foreground">차트를 그릴 시세 데이터가 아직 없습니다.</p>
  }
  return <StockChart history={history} {...options} />
}
