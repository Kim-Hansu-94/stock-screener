import type { DayReturn, Market, ScreenedStockPerf } from '@/lib/types'
import { translateSector } from '@/lib/sectorMap'

interface Props {
  items: ScreenedStockPerf[]
  market: Market
}

function ReturnCell({ value }: { value: DayReturn | null }) {
  if (!value) {
    return <td className="px-4 py-2.5 text-center text-gray-300">—</td>
  }
  const pct = value.returnPct
  const color = pct > 0 ? 'text-green-600' : pct < 0 ? 'text-red-500' : 'text-gray-500'
  return (
    <td className={`px-4 py-2.5 text-center font-mono text-sm ${color}`}>
      {pct > 0 ? '+' : ''}
      {pct.toFixed(2)}%
    </td>
  )
}

function formatEntry(price: number, market: Market) {
  return market === 'KR'
    ? `${price.toLocaleString('ko-KR')}원`
    : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function PerformanceTable({ items, market }: Props) {
  const grouped = new Map<string, ScreenedStockPerf[]>()
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
            <p className="mb-2 text-sm font-medium text-gray-500">{date}</p>
            <div className="overflow-x-auto rounded-lg border border-gray-100">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-400">
                    <th className="px-4 py-2 text-left font-medium">종목</th>
                    <th className="px-4 py-2 text-left font-medium">섹터</th>
                    <th className="px-4 py-2 text-right font-medium">진입가</th>
                    <th className="px-4 py-2 text-center font-medium">+1일</th>
                    <th className="px-4 py-2 text-center font-medium">+2일</th>
                    <th className="px-4 py-2 text-center font-medium">+3일</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {stocks.map((stock) => (
                    <tr key={stock.ticker} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-gray-800">{stock.name}</span>
                        <span className="ml-1.5 text-xs text-gray-400">{stock.ticker}</span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{translateSector(stock.sector)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-gray-700">
                        {formatEntry(stock.entryPrice, market)}
                      </td>
                      <ReturnCell value={stock.day1} />
                      <ReturnCell value={stock.day2} />
                      <ReturnCell value={stock.day3} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}
