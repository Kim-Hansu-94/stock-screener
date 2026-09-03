'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition, type FormEvent } from 'react'
import { askPin, clearPin } from '@/lib/pinClient'
import type { Market } from '@/lib/types'

/**
 * 감시 종목(watchlist_tickers) 추가/삭제.
 *
 * 뉴스·소문으로 관심 가는 종목을 스크리너 통과 여부와 상관없이 사이트에서 직접
 * 추적하고 싶다는 요구로 만들었다 — 예전엔 pipeline/src/watchlist.py의 코드 상수를
 * 고쳐야만 종목을 추가할 수 있었다.
 */

async function callWatchlist(
  method: 'POST' | 'DELETE',
  body: unknown,
  pin: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const res = await fetch('/api/watchlist', {
    method,
    headers: { 'content-type': 'application/json', 'x-trade-pin': pin },
    body: JSON.stringify(body),
  })
  if (res.ok) return { ok: true }
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  return { ok: false, status: res.status, error: data.error ?? '요청에 실패했습니다.' }
}

export function AddWatchlistForm() {
  const router = useRouter()
  const [market, setMarket] = useState<Market>('KR')
  const [ticker, setTicker] = useState('')
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = ticker.trim()
    if (!t) return
    const pin = askPin()
    if (!pin) return

    setBusy(true)
    setError(null)
    const result = await callWatchlist('POST', { market, ticker: t }, pin)
    setBusy(false)

    if (!result.ok) {
      if (result.status === 401) clearPin()
      setError(result.error)
      return
    }
    setTicker('')
    startTransition(() => router.refresh())
  }

  const working = busy || pending

  return (
    <form onSubmit={submit} className="rounded-lg border border-dashed border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={market}
          onChange={(e) => setMarket(e.target.value as Market)}
          className="h-9 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
        >
          <option value="KR">한국</option>
          <option value="US">미국</option>
        </select>
        <input
          type="text"
          value={ticker}
          onChange={(e) => setTicker(market === 'US' ? e.target.value.toUpperCase() : e.target.value)}
          placeholder={market === 'KR' ? '티커 (예: 005930)' : '티커 (예: TSLA)'}
          className="h-9 w-36 rounded-md border border-input px-3 text-sm outline-none focus:border-ring"
        />
        <button
          type="submit"
          disabled={working || !ticker.trim()}
          className="h-9 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {working ? '추가 중...' : '관심 종목 추가'}
        </button>
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground">
        스크리너 통과 여부와 상관없이 매일 자동으로 평가해 감시 목록에 표시합니다.
      </p>
      {error && <p className="mt-1 text-xs text-down">{error}</p>}
    </form>
  )
}

export function RemoveWatchlistButton({ market, ticker }: { market: Market; ticker: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    if (!window.confirm(`${ticker}를 감시 목록에서 삭제할까요?`)) return
    const pin = askPin()
    if (!pin) return

    setBusy(true)
    setError(null)
    const result = await callWatchlist('DELETE', { market, ticker }, pin)
    setBusy(false)

    if (!result.ok) {
      if (result.status === 401) clearPin()
      setError(result.error)
      return
    }
    startTransition(() => router.refresh())
  }

  const working = busy || pending

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={working}
        className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-down/10 hover:text-down disabled:opacity-50"
      >
        {working ? '삭제 중...' : '삭제'}
      </button>
      {error && <span className="text-xs text-down">{error}</span>}
    </span>
  )
}
