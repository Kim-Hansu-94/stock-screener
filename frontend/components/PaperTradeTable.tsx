import type { PaperPosition } from '@/lib/queries/trades'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import { SellButton } from './TradeButton'

function price(value: number, market: string): string {
  return market === 'KR'
    ? `${Math.round(value).toLocaleString('ko-KR')}원`
    : `$${value.toFixed(2)}`
}

const SOURCE_LABEL = { pullback: '눌림목', opportunity: '횡보·조정' } as const

export function PaperTradeTable({ items, showSell }: { items: PaperPosition[]; showSell: boolean }) {
  if (items.length === 0) return null

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-2 pr-3 text-left font-medium">종목</th>
            <th className="py-2 pr-3 text-right font-medium">매수가</th>
            <th className="py-2 pr-3 text-right font-medium">{showSell ? '현재가' : '매도가'}</th>
            <th className="py-2 pr-3 text-right font-medium">수익률</th>
            {showSell && <th className="py-2 pr-3 text-right font-medium">고점 대비</th>}
            <th className="py-2 pr-3 text-right font-medium">보유</th>
            {showSell && <th className="py-2 text-right font-medium"></th>}
          </tr>
        </thead>
        <tbody>
          {items.map((t) => (
            <tr key={t.id} className="border-b border-border/50 last:border-0">
              <td className="py-2.5 pr-3">
                <span className="font-medium text-foreground">{t.name}</span>
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {t.ticker} · {SOURCE_LABEL[t.source]}
                </span>
                <span className="block text-xs text-muted-foreground">{t.entry_date} 매수</span>
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-xs text-muted-foreground">
                {price(t.entry_price, t.market)}
              </td>
              <td className="py-2.5 pr-3 text-right font-mono text-xs text-foreground">
                {price(t.currentPrice, t.market)}
              </td>
              <td className={`py-2.5 pr-3 text-right font-mono font-semibold ${changeTextClass(t.returnPct)}`}>
                {formatSignedPercent(t.returnPct)}
              </td>
              {showSell && (
                <td className="py-2.5 pr-3 text-right font-mono text-xs text-muted-foreground">
                  {t.peakDrawdownPct === null ? '—' : formatSignedPercent(t.peakDrawdownPct, 1)}
                </td>
              )}
              <td className="py-2.5 pr-3 text-right text-xs text-muted-foreground">
                {t.holdingDays}일
              </td>
              {showSell && (
                <td className="py-2.5 text-right">
                  <SellButton id={t.id} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** 청산된 트레이드의 한 줄 요약. 매매장 전체가 돈을 벌었는지. */
export function PaperTradeSummary({ closed }: { closed: PaperPosition[] }) {
  if (closed.length === 0) return null
  const wins = closed.filter((t) => t.returnPct > 0).length
  const avg = closed.reduce((a, t) => a + t.returnPct, 0) / closed.length

  return (
    <p className="text-sm text-muted-foreground">
      청산 {closed.length}건 · 수익 {wins}건 · 평균{' '}
      <span className={`font-semibold ${changeTextClass(avg)}`}>{formatSignedPercent(avg)}</span>
    </p>
  )
}
