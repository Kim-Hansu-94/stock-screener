'use client'

import { useEffect, useState } from 'react'
import { DailyAlertModal } from './DailyAlertModal'
import type {
  AlertStock, HoldingsChangeAlert, NewEntryAlertStock, OpportunityAlertStock, TurnSignalAlertStock,
} from '@/lib/types'

const STORAGE_KEY_PREFIX = 'daily-alert-seen:'

type AlertData = {
  pullback: AlertStock[]
  opportunity: OpportunityAlertStock[]
  newEntries: NewEntryAlertStock[]
  turnSignals: TurnSignalAlertStock[]
  holdingsChange: HoldingsChangeAlert | null
}

// 알림 내용이 바뀌면(저녁 KR 재실행으로 새 종목이 뜨는 등) 다시 보여줘야 하므로,
// 날짜가 아니라 "오늘 뜬 종목 조합" 자체를 키로 삼는다 — 같은 조합을 다시 보면
// 스킵하고, 조합이 달라지면 새 알림으로 다시 띄운다.
function signatureOf({ pullback, opportunity, newEntries, turnSignals, holdingsChange }: AlertData): string {
  const parts = [
    // 구성 변경은 종목 목록으로 서명한다 — 내가 실측값을 갱신하기 전까지 매일 같은
    // 내용이 뜨는데, 한 번 닫았다고 영영 안 보이면 알림의 목적이 없어진다.
    // 그래서 "닫으면 그 조합은 다시 안 뜬다"는 기존 규칙을 그대로 따르되,
    // 종목이 하나라도 더 바뀌면 새 알림으로 다시 뜬다.
    ...(holdingsChange ? [`H:${holdingsChange.newNames.join(',')}`] : []),
    ...pullback.map((s) => `P:${s.market}:${s.ticker}`),
    ...opportunity.map((s) => `O:${s.market}:${s.ticker}:${s.score.toFixed(2)}`),
    ...newEntries.map((s) => `N:${s.market}:${s.ticker}`),
    ...turnSignals.map((s) => `T:${s.market}:${s.ticker}`),
  ]
  return parts.sort().join('|')
}

/** 사이트 진입 시 오늘의 알림(눌림목 전 조건 충족 + 횡보·조정 95점 이상 + 오늘 막
 * 뜬 관찰 대상 + 오늘 막 상승 전환된 종목)을 팝업으로 띄운다. 페이지를 옮겨 다녀도
 * (같은 레이아웃 트리) 다시 fetch하지 않고, 새로고침 시엔 다시 확인하되 같은
 * 내용이면 조용히 넘어간다. */
export function DailyAlertPopup() {
  const [data, setData] = useState<AlertData | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/alerts')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: AlertData | null) => {
        if (cancelled || !json) return
        if (
          json.pullback.length === 0 && json.opportunity.length === 0 &&
          json.newEntries.length === 0 && json.turnSignals.length === 0 &&
          !json.holdingsChange
        ) return

        const key = STORAGE_KEY_PREFIX + signatureOf(json)
        try {
          if (localStorage.getItem(key)) return
        } catch {
          // 프라이빗 모드 등으로 storage 접근이 막히면 매번 보여준다(안전한 쪽으로 실패).
        }

        setData(json)
        setOpen(true)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  function close() {
    setOpen(false)
    if (data) {
      try {
        localStorage.setItem(STORAGE_KEY_PREFIX + signatureOf(data), '1')
      } catch {
        // no-op
      }
    }
  }

  if (!data) return null

  return (
    <DailyAlertModal
      pullback={data.pullback}
      opportunity={data.opportunity}
      newEntries={data.newEntries}
      turnSignals={data.turnSignals}
      holdingsChange={data.holdingsChange}
      open={open}
      onClose={close}
    />
  )
}
