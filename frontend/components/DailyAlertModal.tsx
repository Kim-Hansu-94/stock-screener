import { Dialog } from '@base-ui/react/dialog'
import Link from 'next/link'
import type { AlertStock, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock } from '@/lib/types'

interface Props {
  pullback: AlertStock[]
  opportunity: OpportunityAlertStock[]
  newEntries: NewEntryAlertStock[]
  turnSignals: TurnSignalAlertStock[]
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
export function DailyAlertModal({ pullback, opportunity, newEntries, turnSignals, open, onClose }: Props) {
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

            {turnSignals.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-foreground">
                  🚀 상승 전환 감지{' '}
                  <span className="text-up">{turnSignals.length}종목</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  후보로 뜬 지는 오래됐어도, 박스 상단(최근 60일 고가)을 거래량과
                  함께 돌파해 횡보를 멈추고 오르기 시작한 것으로 보입니다. 이미
                  몇 배 오른 뒤가 아니라 이 시점 자체를 알려드립니다.
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-secondary-foreground">
                  {turnSignals.map((s) => (
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

            {newEntries.length > 0 && (
              <div>
                <p className="text-sm font-semibold text-foreground">
                  관찰 대상 · 오늘 막 진입{' '}
                  <span className="text-accent-foreground">{newEntries.length}종목</span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  아직 매수 등급(적극검토·매수검토)에는 못 미치지만, 며칠 전부터
                  바닥 다지기 조건을 막 만족하기 시작했습니다. 매수 신호가 아니라
                  참고용 관찰 대상입니다.
                </p>
                <ul className="mt-1.5 space-y-1 text-sm text-secondary-foreground">
                  {newEntries.map((s) => (
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
