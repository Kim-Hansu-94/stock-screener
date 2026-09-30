'use client'

import { useState } from 'react'
import { WEIGHTS_RECHECK_DAYS } from '@/lib/etfEntryCheck'
import { DailyAlertModal } from '@/components/DailyAlertModal'
import type {
  AlertStock, HoldingsChangeAlert, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock,
  WeightsRecheckAlert,
} from '@/lib/types'

const PULLBACK_FIXTURE: AlertStock[] = [
  { ticker: '000660', market: 'KR', name: 'SK하이닉스', nameKr: null },
  { ticker: 'ANF', market: 'US', name: 'Abercrombie & Fitch', nameKr: '아베크롬비 앤드 피치' },
]

const OPPORTUNITY_FIXTURE: OpportunityAlertStock[] = [
  { ticker: '005930', market: 'KR', name: '삼성전자', nameKr: null, score: 0.97 },
]

const NEW_ENTRY_FIXTURE: NewEntryAlertStock[] = [
  { ticker: '005945', market: 'KR', name: 'NH투자증권우', nameKr: null, score: 0.42, qualifiedSince: '2026-09-04' },
]

const TURN_SIGNAL_FIXTURE: TurnSignalAlertStock[] = [
  { ticker: '024110', market: 'KR', name: '기업은행', nameKr: null, score: 0.68, breakoutSince: '2026-09-05' },
]

const HOLDINGS_CHANGE_FIXTURE: HoldingsChangeAlert = {
  newNames: ['INTEL CORP (INTC)', 'VERTIV HOLDINGS CO-A (VRT)'],
  // 새로 보인 종목과 안 보이게 된 종목이 **같이** 떴을 때의 모양을 본다 — 둘은
  // 서로 다른 상황이라 문구도 다르고, 한 팝업에 겹쳐 뜰 수 있다.
  droppedNames: ['ORACLE CORP (ORCL)'],
  currentAsOf: '2026-09-25',
  checkedAt: '2026-09-30',
}

const WEIGHTS_REMINDER_FIXTURE: WeightsRecheckAlert = {
  daysSince: 4,
  asOf: '2026-09-25',
  everyDays: WEIGHTS_RECHECK_DAYS,
  bucket: 2,
  // 자동 점검이 못 보는 판정 종목 — 상수가 아니라 그날 수집 결과에서 나온다.
  blindNames: ['AMD', '마이크론 테크놀로지', 'TSMC (ADR)'],
  blindWeightPct: 21.2,
}

/** DailyAlertModal은 onClose 콜백을 받는 클라이언트 컴포넌트라, 서버 컴포넌트인
 * /dev/preview 페이지에서 함수 prop 없이 안전하게 렌더하려고 이 안에 가둔다. */
export function DailyAlertPreview() {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-secondary-foreground">오늘의 알림 팝업</h3>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-secondary px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:bg-border"
        >
          다시 열기
        </button>
      </div>
      <DailyAlertModal
        pullback={PULLBACK_FIXTURE}
        opportunity={OPPORTUNITY_FIXTURE}
        newEntries={NEW_ENTRY_FIXTURE}
        turnSignals={TURN_SIGNAL_FIXTURE}
        holdingsChange={HOLDINGS_CHANGE_FIXTURE}
        weightsReminder={WEIGHTS_REMINDER_FIXTURE}
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
