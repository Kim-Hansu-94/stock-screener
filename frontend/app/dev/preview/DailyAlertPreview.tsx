'use client'

import { useState } from 'react'
import { DailyAlertModal } from '@/components/DailyAlertModal'
import type { AlertStock, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock } from '@/lib/types'

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
        open={open}
        onClose={() => setOpen(false)}
      />
    </div>
  )
}
