import type { Regime } from '@/lib/types'

interface MarketRegimeBadgeProps {
  marketLabel: string
  regime: Regime | null
}

export function MarketRegimeBadge({ marketLabel, regime }: MarketRegimeBadgeProps) {
  if (regime === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-gray-200 px-3 py-1 text-sm text-gray-600">
        {marketLabel}: 데이터 없음
      </span>
    )
  }

  const isBull = regime === 'bull'

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${
        isBull ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
      }`}
    >
      {marketLabel}: {isBull ? '상승장' : '하락장 — 신중하게 접근하세요'}
    </span>
  )
}
