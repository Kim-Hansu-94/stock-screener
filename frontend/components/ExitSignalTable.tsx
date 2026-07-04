import type { ExitCheckResult, Market } from '@/lib/types'

interface Props {
  items: ExitCheckResult[]
  market: Market
}

function formatPrice(price: number, market: Market) {
  return market === 'KR'
    ? `${Math.round(price).toLocaleString('ko-KR')}원`
    : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPct(pct: number) {
  const rounded = pct.toFixed(2)
  return pct >= 0 ? `+${rounded}%` : `${rounded}%`
}

function StatusBadge({ item }: { item: ExitCheckResult }) {
  if (item.status === 'stopped_out') {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-600">
        손절가 도달
      </span>
    )
  }
  if (item.status === 'target_hit') {
    return (
      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-700">
        목표가 도달
      </span>
    )
  }
  if (item.recommendation === 'sell') {
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
        매도 권장
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-500">
      보유 유지
    </span>
  )
}

export function ExitSignalTable({ items, market }: Props) {
  const grouped = new Map<string, ExitCheckResult[]>()
  for (const item of items) {
    const list = grouped.get(item.date) ?? []
    list.push(item)
    grouped.set(item.date, list)
  }
  const dates = [...grouped.keys()].sort((a, b) => b.localeCompare(a))

  return (
    <div className="space-y-6">
      {dates.map((date) => {
        const stocks = grouped.get(date)!
        return (
          <div key={date}>
            <p className="mb-2 text-sm font-medium text-gray-500">{date} 추천</p>
            <div className="space-y-2">
              {stocks.map((item) => {
                const returnColor =
                  item.currentReturnPct > 0
                    ? 'text-green-600'
                    : item.currentReturnPct < 0
                      ? 'text-red-500'
                      : 'text-gray-500'
                return (
                  <div key={item.ticker} className="rounded-lg border border-gray-100 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="block text-sm font-medium text-gray-800">
                          {item.name_kr ?? item.name}
                        </span>
                        <span className="text-xs text-gray-400">
                          {item.ticker}
                          <span className="mx-1.5 text-gray-200">·</span>
                          매수가 {formatPrice(item.entryPrice, market)}
                          <span className="mx-1.5 text-gray-200">·</span>
                          현재가 {formatPrice(item.currentPrice, market)}
                          <span className={`ml-1.5 font-mono ${returnColor}`}>
                            ({formatPct(item.currentReturnPct)})
                          </span>
                        </span>
                        {item.exitDate && (
                          <span className="mt-0.5 block text-xs text-gray-400">{item.exitDate}에 도달</span>
                        )}
                      </div>
                      <StatusBadge item={item} />
                    </div>
                    {item.exitReasons.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
                        {item.exitReasons.map((reason) => (
                          <li key={reason}>· {reason}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
