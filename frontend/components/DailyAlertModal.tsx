import { Dialog } from '@base-ui/react/dialog'
import Link from 'next/link'
import type {
  AlertStock, HoldingsChangeAlert, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock,
  WeightsRecheckAlert,
} from '@/lib/types'

interface Props {
  pullback: AlertStock[]
  opportunity: OpportunityAlertStock[]
  newEntries: NewEntryAlertStock[]
  turnSignals: TurnSignalAlertStock[]
  holdingsChange: HoldingsChangeAlert | null
  weightsReminder: WeightsRecheckAlert | null
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
export function DailyAlertModal({
  pullback, opportunity, newEntries, turnSignals, holdingsChange, weightsReminder,
  open, onClose,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-[1px] transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 max-h-[80vh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)] transition-all duration-150 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <Dialog.Title className="text-base font-bold text-foreground">오늘의 알림</Dialog.Title>

          {/* 매매 신호가 아니라 **내가 손봐야 하는 일**이라 맨 위에 따로 둔다 —
              종목 목록에 섞으면 "오늘 뜬 종목" 중 하나로 읽힌다. */}
          {holdingsChange && (
            <div className="mt-3 rounded-lg border-l-4 border-down bg-muted/50 p-3">
              <p className="text-sm font-semibold text-down">490590 구성종목이 바뀐 것 같습니다</p>
              <p className="mt-1 text-xs text-muted-foreground">
                지금 쓰는 비중은 <strong>{holdingsChange.currentAsOf}</strong> 기준인데, 자동 점검
                {holdingsChange.checkedAt && <>({holdingsChange.checkedAt})</>}에서 목록에 없는 종목이
                보였습니다:
              </p>
              <ul className="mt-1.5 space-y-0.5 text-xs font-medium">
                {holdingsChange.newNames.map((name) => (
                  <li key={name}>· {name}</li>
                ))}
              </ul>
              {/* '빠짐'은 새 종목과 **성격이 다르다** — 네이버가 주식 수 순 상위
                  10개만 줘서, 그대로 담고 있어도 순위가 밀리면 똑같이 사라진다.
                  그래서 "빠졌다"고 단정하지 않고 두 가능성을 다 적는다. */}
              {holdingsChange.droppedNames.length > 0 && (
                <>
                  <p className="mt-2 text-xs text-muted-foreground">
                    어제까지 보이던 종목이 오늘은 안 보입니다 (구성에서 빠졌거나, 담고 있지만
                    보유 순위가 밀렸을 수 있습니다):
                  </p>
                  <ul className="mt-1.5 space-y-0.5 text-xs font-medium">
                    {holdingsChange.droppedNames.map((name) => (
                      <li key={name}>· {name}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">
                증권사 앱 → 490590 → <strong>구성종목</strong> 화면을 캡처해서 알려주시면 비중을
                갱신합니다. 그때까지는 {holdingsChange.currentAsOf} 비중으로 계산됩니다.
              </p>
            </div>
          )}

          {/* 구성 변경 알림과 달리 **아무 일도 안 일어났어도** 주기적으로 뜬다.
              자동 점검이 판정 8개 중 4개(비중 27.7%)를 아예 못 보기 때문에, 그쪽은
              사람이 직접 확인하는 수밖에 없다. **못 보는 종목 이름을 여기 박아두지 않는다** —
              구성이 바뀌면 조용히 거짓말이 된다(2026-09-30에 실제로 그랬다).
              위 '구성종목이 바뀐 것 같습니다'와 **띠 색을 달리한다** — 둘 다 파란 띠면
              긴급도가 같아 보인다. 저건 지금 화면이 틀렸다는 경고고, 이건 주기적으로
              돌아오는 할 일이다(--accent와 --down이 비슷해 색만으로는 안 갈린다는
              기존 교훈과 같은 이유). */}
          {weightsReminder && (
            <div className="mt-3 rounded-lg border-l-4 border-border bg-muted/50 p-3">
              <p className="text-sm font-semibold">490590 구성종목 확인할 때가 됐습니다</p>
              <p className="mt-1 text-xs text-muted-foreground">
                지금 쓰는 비중은 <strong>{weightsReminder.asOf}</strong> 기준으로{' '}
                <strong>{weightsReminder.daysSince}일</strong> 됐습니다. 증권사 앱 → 490590 →{' '}
                <strong>구성종목</strong> 화면을 캡처해서 알려주시면 갱신합니다.
              </p>
              <p className="mt-1.5 text-xs text-muted-foreground/70">
                {weightsReminder.blindNames.length > 0 && (
                  <>
                    자동 점검은 {weightsReminder.blindNames.join('·')}를 못 봅니다(판정 비중의{' '}
                    {weightsReminder.blindWeightPct.toFixed(1)}%).{' '}
                  </>
                )}
                그래서 {weightsReminder.everyDays}일에 한 번 직접 확인을 부탁드립니다.
              </p>
            </div>
          )}

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
