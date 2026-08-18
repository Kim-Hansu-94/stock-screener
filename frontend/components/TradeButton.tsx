'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

/**
 * 매수/매도 버튼.
 *
 * 가격은 보내지 않는다 — 서버가 stock_price_history의 최신 종가를 직접 읽어 채운다.
 * 브라우저가 보낸 가격을 믿으면 수익률을 얼마든지 조작할 수 있다.
 *
 * PIN은 처음 한 번만 묻고 localStorage에 둔다. 틀리면(401) 저장한 값을 지우고 다시 묻는다.
 */

const PIN_KEY = 'treasure-map-trade-pin'

async function callTrades(
  method: 'POST' | 'PATCH',
  body: unknown,
  pin: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/trades', {
    method,
    headers: { 'content-type': 'application/json', 'x-trade-pin': pin },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true }
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  return { ok: false, status: res.status, error: data.error ?? '요청에 실패했습니다.' }
}

function askPin(): string | null {
  const saved = localStorage.getItem(PIN_KEY)
  if (saved) return saved
  const entered = window.prompt('매매 기록을 바꾸려면 PIN을 입력하세요.')
  if (!entered) return null
  localStorage.setItem(PIN_KEY, entered)
  return entered
}

function useTradeAction(method: 'POST' | 'PATCH', body: unknown) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run() {
    setError(null)
    const pin = askPin()
    if (!pin) return

    setBusy(true)
    const result = await callTrades(method, body, pin)
    setBusy(false)

    if (!result.ok) {
      // PIN이 틀렸으면 저장본을 버려야 다음 시도에서 다시 물어본다.
      if (result.status === 401) localStorage.removeItem(PIN_KEY)
      setError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  return { run, working: busy || pending, error }
}

export function BuyButton({
  market, ticker, name, sector, source, owned,
}: {
  market: 'KR' | 'US'
  ticker: string
  name: string
  sector?: string
  source: 'pullback' | 'opportunity'
  owned: boolean
}) {
  const { run, working, error } = useTradeAction('POST', { market, ticker, name, sector, source })

  if (owned) {
    return (
      <span className="rounded-lg bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
        보유 중
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={working}
        className="rounded-lg bg-up/10 px-3 py-1.5 text-xs font-semibold text-up transition hover:bg-up/20 disabled:opacity-50"
      >
        {working ? '기록 중...' : '매수'}
      </button>
      {error && <span className="text-xs text-down">{error}</span>}
    </span>
  )
}

export function SellButton({ id }: { id: string }) {
  const { run, working, error } = useTradeAction('PATCH', { id })

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={working}
        className="rounded-lg bg-down/10 px-3 py-1.5 text-xs font-semibold text-down transition hover:bg-down/20 disabled:opacity-50"
      >
        {working ? '기록 중...' : '매도'}
      </button>
      {error && <span className="text-xs text-down">{error}</span>}
    </span>
  )
}
