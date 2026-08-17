import { changeTextClass, regimeTintClass } from '@/lib/marketColors'
import type { DayReturn, Market, ScreenedStockPerf } from '@/lib/types'

interface Props {
  items: ScreenedStockPerf[]
  market: Market
  regimes?: Record<string, string>
}

function ReturnCell({ value }: { value: DayReturn | null }) {
  if (!value) {
    return <td className="w-12 px-1 py-1.5 text-center text-muted-foreground/50">—</td>
  }
  const pct = value.returnPct
  const color = changeTextClass(pct)
  return (
    <td className={`w-12 px-1 py-1.5 text-center font-mono text-xs ${color}`}>
      {pct > 0 ? '+' : ''}
      {pct.toFixed(2)}%
    </td>
  )
}

function formatPrice(price: number, market: Market) {
  return market === 'KR'
    ? `${Math.round(price).toLocaleString('ko-KR')}원`
    : `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatPct(ratio: number) {
  const pct = (ratio * 100).toFixed(1)
  return ratio >= 0 ? `+${pct}%` : `${pct}%`
}

function RRColor(rr: number) {
  if (rr >= 2.0) return 'text-primary'
  if (rr >= 1.5) return 'text-muted-foreground'
  return 'text-destructive'
}

function StopTargetLine({ stock, market }: { stock: ScreenedStockPerf; market: Market }) {
  const { stop, target, riskReward, entryPrice } = stock
  if (stop === null || target === null || riskReward === null) return null

  const stopPct = (stop - entryPrice) / entryPrice
  const targetPct = (target - entryPrice) / entryPrice

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      <span className="whitespace-nowrap text-destructive">
        손절 {formatPrice(stop, market)}
        <span className="ml-0.5 opacity-80">({formatPct(stopPct)})</span>
      </span>
      <span className="text-muted-foreground/50">·</span>
      <span className="whitespace-nowrap text-primary">
        목표 {formatPrice(target, market)}
        <span className="ml-0.5 opacity-80">({formatPct(targetPct)})</span>
      </span>
      <span className="text-muted-foreground/50">·</span>
      <span className={`whitespace-nowrap font-semibold ${RRColor(riskReward)}`}>
        손익비 {riskReward.toFixed(1)}x
      </span>
    </div>
  )
}

function RegimePill({ regime }: { regime: string | undefined }) {
  if (!regime) return null
  const isBull = regime === 'bull'
  return (
    <span
      className={`ml-2 inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${regimeTintClass(isBull)}`}
    >
      {isBull ? '상승장' : '하락장'}
    </span>
  )
}

export function PerformanceTable({ items, market, regimes }: Props) {
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
            <p className="mb-2 flex items-center text-sm font-medium text-muted-foreground">
              {date}
              <RegimePill regime={regimes?.[date]} />
            </p>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted text-xs text-muted-foreground">
                    <th className="px-2 py-1.5 text-left font-medium">종목</th>
                    <th className="w-14 px-1 py-1.5 text-center font-medium whitespace-nowrap">+1일</th>
                    <th className="w-14 px-1 py-1.5 text-center font-medium whitespace-nowrap">+2일</th>
                    <th className="w-14 px-1 py-1.5 text-center font-medium whitespace-nowrap">+3일</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stocks.map((stock) => (
                    <tr key={stock.ticker} className="hover:bg-muted/50">
                      <td className="px-2 py-1.5">
                        <span className="block text-sm font-medium text-foreground">{stock.name_kr || stock.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {stock.ticker}
                          <span className="mx-1.5 text-muted-foreground/50">·</span>
                          <span className="font-mono whitespace-nowrap text-muted-foreground">{formatPrice(stock.entryPrice, market)}</span>
                        </span>
                        <StopTargetLine stock={stock} market={market} />
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
