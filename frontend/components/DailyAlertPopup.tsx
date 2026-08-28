'use client'

import { useEffect, useState } from 'react'
import { DailyAlertModal } from './DailyAlertModal'
import type { AlertStock, OpportunityAlertStock } from '@/lib/types'

const STORAGE_KEY_PREFIX = 'daily-alert-seen:'

// 알림 내용이 바뀌면(저녁 KR 재실행으로 새 종목이 뜨는 등) 다시 보여줘야 하므로,
// 날짜가 아니라 "오늘 뜬 종목 조합" 자체를 키로 삼는다 — 같은 조합을 다시 보면
// 스킵하고, 조합이 달라지면 새 알림으로 다시 띄운다.
function signatureOf(pullback: AlertStock[], opportunity: OpportunityAlertStock[]): string {
  const parts = [
    ...pullback.map((s) => `P:${s.market}:${s.ticker}`),
    ...opportunity.map((s) => `O:${s.market}:${s.ticker}:${s.score.toFixed(2)}`),
  ]
  return parts.sort().join('|')
}

/** 사이트 진입 시 오늘의 알림(눌림목 전 조건 충족 + 횡보·조정 95점 이상)을 팝업으로
 * 띄운다. 페이지를 옮겨 다녀도(같은 레이아웃 트리) 다시 fetch하지 않고, 새로고침 시엔
 * 다시 확인하되 같은 내용이면 조용히 넘어간다. */
export function DailyAlertPopup() {
  const [data, setData] = useState<{ pullback: AlertStock[]; opportunity: OpportunityAlertStock[] } | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/alerts')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { pullback: AlertStock[]; opportunity: OpportunityAlertStock[] } | null) => {
        if (cancelled || !json) return
        if (json.pullback.length === 0 && json.opportunity.length === 0) return

        const key = STORAGE_KEY_PREFIX + signatureOf(json.pullback, json.opportunity)
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
        localStorage.setItem(STORAGE_KEY_PREFIX + signatureOf(data.pullback, data.opportunity), '1')
      } catch {
        // no-op
      }
    }
  }

  if (!data) return null

  return <DailyAlertModal pullback={data.pullback} opportunity={data.opportunity} open={open} onClose={close} />
}
