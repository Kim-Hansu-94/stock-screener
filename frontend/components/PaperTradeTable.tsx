import type { PaperPosition } from '@/lib/queries/trades'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import { EXIT_REASON_LABEL, HARD_REASONS } from '@/lib/exitSignal'
import { SellButton } from './TradeButton'

function price(value: number, market: string): string {
  return market === 'KR'
    ? `${Math.round(value).toLocaleString('ko-KR')}원`
    : `$${value.toFixed(2)}`
}

const SOURCE_LABEL = { pullback: '눌림목', opportunity: '횡보·조정' } as const

/**
 * 매도 신호 배지. 자동으로 팔지 않고 알려주기만 하므로, 파는 판단은 사람이 한다.
 * 손절·목표 도달은 가격이 실제로 닿은 확정 신호라 진하게, 장세·섹터·추세는
 * 정황 신호라 옅게 구분한다.
 */
function SignalBadge({ item }: { item: PaperPosition }) {
  if (!item.exitSignal) return null
  const hard = item.exitSignal.reasons.some((r) => HARD_REASONS.has(r))
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-xs font-semibold ${
        hard ? 'bg-down text-primary-foreground' : 'bg-down/10 text-down'
      }`}
    >
      매도 신호
    </span>
  )
}

function SignalDetail({ item }: { item: PaperPosition }) {
  if (!item.exitSignal) return null
  return (
    <>
      <span className="text-xs text-muted-foreground">
        {item.exitSignal.reasons.map((r) => EXIT_REASON_LABEL[r]).join(' · ')}
      </span>
      <span className="text-xs text-muted-foreground">
        {item.exitSignal.date}에 팔았다면{' '}
        <span className={`font-semibold ${changeTextClass(item.signalReturnPct ?? 0)}`}>
          {item.signalReturnPct === null ? '—' : formatSignedPercent(item.signalReturnPct)}
        </span>
      </span>
    </>
  )
}

function OpenSignalCell({ item }: { item: PaperPosition }) {
  if (!item.exitSignal) {
    return <span className="text-xs text-muted-foreground">보유 유지</span>
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <SignalBadge item={item} />
      <SignalDetail item={item} />
    </div>
  )
}

/**
 * 청산된 트레이드용 — "신호대로 팔았다면"과 실제 매도 결과를 견준다.
 * 버티는 선택이 맞았는지 사후에 돌아보는 게 이 열의 목적이다.
 */
function ClosedSignalCell({ item }: { item: PaperPosition }) {
  if (item.signalReturnPct === null) {
    return <span className="text-xs text-muted-foreground">신호 없었음</span>
  }
  const diff = item.returnPct - item.signalReturnPct
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-xs text-muted-foreground">
        신호 시점 {formatSignedPercent(item.signalReturnPct)}
      </span>
      <span className={`text-xs font-semibold ${changeTextClass(diff)}`}>
        버텨서 {formatSignedPercent(diff)}
      </span>
    </div>
  )
}

/**
 * 폰용 카드. 표는 열이 8개라 좁은 화면에서 가로로 넘쳐 페이지 전체를 밀어버린다
 * (네비게이션까지 깨졌다). 폰에서는 한 종목을 세로로 쌓아 잘리지 않게 한다.
 */
function TradeCard({ item, showSell }: { item: PaperPosition; showSell: boolean }) {
  const diff = item.signalReturnPct === null ? null : item.returnPct - item.signalReturnPct

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold text-foreground">{item.name}</span>
          <span className="text-xs text-muted-foreground">
            {item.ticker} · {SOURCE_LABEL[item.source]}
          </span>
          <span className="text-xs text-muted-foreground">
            {item.entry_date} 매수
            {!item.isOpen && ` → ${item.exit_date} 매도`} · {item.holdingDays}일
          </span>
        </div>
        {showSell && (
          <div className="shrink-0">
            <SellButton id={item.id} />
          </div>
        )}
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {price(item.entry_price, item.market)} → {price(item.currentPrice, item.market)}
        </span>
        <span className={`font-mono text-lg font-bold ${changeTextClass(item.returnPct)}`}>
          {formatSignedPercent(item.returnPct)}
        </span>
      </div>

      {showSell && item.peakDrawdownPct !== null && (
        <span className="text-xs text-muted-foreground">
          고점 대비 {formatSignedPercent(item.peakDrawdownPct, 1)}
        </span>
      )}

      {showSell ? (
        item.exitSignal ? (
          <div className="flex flex-col items-start gap-0.5 border-t border-border pt-2">
            <SignalBadge item={item} />
            <SignalDetail item={item} />
          </div>
        ) : (
          <span className="border-t border-border pt-2 text-xs text-muted-foreground">
            보유 유지 — 아직 매도 신호 없음
          </span>
        )
      ) : (
        <span className="border-t border-border pt-2 text-xs text-muted-foreground">
          {item.signalReturnPct === null ? (
            '매도 신호는 없었음'
          ) : (
            <>
              신호 시점 {formatSignedPercent(item.signalReturnPct)} ·{' '}
              <span className={`font-semibold ${changeTextClass(diff ?? 0)}`}>
                버텨서 {formatSignedPercent(diff ?? 0)}
              </span>
            </>
          )}
        </span>
      )}
    </div>
  )
}

export function PaperTradeTable({ items, showSell }: { items: PaperPosition[]; showSell: boolean }) {
  if (items.length === 0) return null

  return (
    <>
      {/* 폰: 카드 */}
      <div className="flex flex-col gap-2 md:hidden">
        {items.map((t) => (
          <TradeCard key={t.id} item={t} showSell={showSell} />
        ))}
      </div>

      {/* 데스크톱: 표. min-w-0가 없으면 overflow-x-auto가 부모를 못 잡고 페이지가 밀린다. */}
      <div className="hidden min-w-0 overflow-x-auto md:block">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-2 pr-3 text-left font-medium">종목</th>
              <th className="py-2 pr-3 text-right font-medium">매수가</th>
              <th className="py-2 pr-3 text-right font-medium">{showSell ? '현재가' : '매도가'}</th>
              <th className="py-2 pr-3 text-right font-medium">수익률</th>
              {showSell && <th className="py-2 pr-3 text-right font-medium">고점 대비</th>}
              <th className="py-2 pr-3 text-right font-medium">
                {showSell ? '매도 신호' : '신호 대비'}
              </th>
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
                <td className="py-2.5 pr-3 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {price(t.entry_price, t.market)}
                </td>
                <td className="py-2.5 pr-3 text-right font-mono text-xs whitespace-nowrap text-foreground">
                  {price(t.currentPrice, t.market)}
                </td>
                <td
                  className={`py-2.5 pr-3 text-right font-mono font-semibold whitespace-nowrap ${changeTextClass(t.returnPct)}`}
                >
                  {formatSignedPercent(t.returnPct)}
                </td>
                {showSell && (
                  <td className="py-2.5 pr-3 text-right font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {t.peakDrawdownPct === null ? '—' : formatSignedPercent(t.peakDrawdownPct, 1)}
                  </td>
                )}
                <td className="py-2.5 pr-3 text-right align-top">
                  {showSell ? <OpenSignalCell item={t} /> : <ClosedSignalCell item={t} />}
                </td>
                <td className="py-2.5 pr-3 text-right text-xs whitespace-nowrap text-muted-foreground">
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
    </>
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
