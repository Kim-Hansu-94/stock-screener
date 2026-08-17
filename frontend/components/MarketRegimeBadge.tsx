import { regimeTintClass } from '@/lib/marketColors'
import type { Regime } from '@/lib/types'

interface MarketRegimeBadgeProps {
  marketLabel: string
  regime: Regime | null
}

export function MarketRegimeBadge({ marketLabel, regime }: MarketRegimeBadgeProps) {
  if (regime === null) {
    return (
      <span className="inline-flex items-center rounded-lg bg-muted px-3 py-1 text-sm text-muted-foreground">
        {marketLabel}: 데이터 없음
      </span>
    )
  }

  const isBull = regime === 'bull'

  // 상승장/하락장도 가격 방향이라 등락 색 규칙을 그대로 쓴다(상승=빨강, 하락=파랑).
  return (
    <span
      className={`inline-flex items-center rounded-lg px-3 py-1 text-sm font-semibold ${regimeTintClass(isBull)}`}
    >
      {marketLabel}: {isBull ? '상승장' : '하락장 — 신중하게 접근하세요'}
    </span>
  )
}
