import { Dialog } from '@base-ui/react/dialog'
import Link from 'next/link'
import type { AlertStock, OpportunityAlertStock } from '@/lib/types'

interface Props {
  pullback: AlertStock[]
  opportunity: OpportunityAlertStock[]
  open: boolean
  onClose: () => void
}

function StockName({ stock }: { stock: AlertStock }) {
  return (
    <>
      {stock.nameKr || stock.name}
      <span className="ml-1 text-muted-foreground">
        ({stock.ticker}
        {stock.market === 'US' && <span className="text-muted-foreground/70">·US</span>})
      </span>
    </>
  )
}

/** 사이트 진입 알림 팝업 — 실제 표시는 DailyAlertPopup(fetch 담당)이 호출하고,
 * /dev/preview에서는 이 컴포넌트에 픽스처를 직접 넘겨 렌더 확인한다. */
export function DailyAlertModal({ pullback, opportunity, open, onClose }: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[1px] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)] transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <Dialog.Title className="text-base font-bold text-foreground">오늘의 알림</Dialog.Title>

          <div className="mt-3 space-y-4">
            {pullback.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-foreground">
                  눌림목 조건 전부 충족{' '}
                  <span className="text-primary">{pullback.length}종목</span>
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-secondary-foreground">
                  {pullback.map((s) => (
                    <li key={`${s.market}-${s.ticker}`}>
                      <StockName stock={s} />
                    </li>
                  ))}
                </ul>
                <Link href="/pullback" onClick={onClose} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">
                  눌림목 종목 보기 →
                </Link>
              </div>
            )}

            {opportunity.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-foreground">
                  횡보·조정 매력도 95점 이상{' '}
                  <span className="text-primary">{opportunity.length}종목</span>
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-secondary-foreground">
                  {opportunity.map((s) => (
                    <li key={`${s.market}-${s.ticker}`}>
                      <StockName stock={s} /> · {Math.round(s.score * 100)}점
                    </li>
                  ))}
                </ul>
                <Link href="/discover" onClick={onClose} className="mt-1.5 inline-block text-xs font-medium text-primary hover:underline">
                  종목발굴 보기 →
                </Link>
              </div>
            )}
          </div>

          <Dialog.Close className="mt-4 w-full rounded-lg bg-secondary py-2 text-sm font-medium text-secondary-foreground hover:bg-border">
            닫기
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
