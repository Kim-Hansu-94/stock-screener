'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { askPin, clearPin } from '@/lib/pinClient'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import {
  computeAverageCost,
  simulateAddBuy,
  DEFAULT_SELL_COST_PCT,
  type BuyLot,
} from '@/lib/averageCost'
import type { Market } from '@/lib/types'

/**
 * 분할매수 평단 계산기 — 차수별로 "얼마에 몇 주"를 넣으면 평단가·평가손익을 낸다.
 *
 * 포지션 관리 카드의 평단가는 원래 손으로 계산해 넣는 단일 숫자였다. 이 카드의 목적이
 * 추가 매수(물타기)라 살 때마다 밖에서 평단을 다시 계산해 와야 했는데, 그 계산을
 * 여기서 대신한다. 라오니(raoni.xyz/calc)의 평단 손익계산기를 참고했다.
 *
 * 저장 위치가 두 곳으로 갈리는 게 의도적이다:
 * - 차수별 내역은 브라우저(localStorage)에만 둔다. 매수 기록은 기기에서 끝나는
 *   개인 메모라 서버 스키마를 늘릴 이유가 없고, 파이프라인도 이 값을 안 쓴다.
 * - 계산 결과인 평단가만 버튼을 눌러 서버(watchlist_tickers.avg_cost)에 올린다.
 *   손익률 표시는 다른 기기에서도 보여야 하고, 그 값은 이미 스키마에 있다.
 */

const MAX_LOTS = 12

type StoredState = { lots: BuyLot[]; sellCostPct: number }

function storageKey(market: Market, ticker: string) {
  return `avgcost:${market}:${ticker}`
}

function loadStored(market: Market, ticker: string): StoredState | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(storageKey(market, ticker))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredState>
    if (!Array.isArray(parsed.lots)) return null
    return {
      lots: parsed.lots
        .slice(0, MAX_LOTS)
        .map((l) => ({ price: Number(l?.price) || 0, qty: Number(l?.qty) || 0 })),
      sellCostPct: Number(parsed.sellCostPct) || 0,
    }
  } catch {
    // 사파리 프라이빗 모드 등에서 localStorage가 막혀도 계산기 자체는 동작해야 한다.
    return null
  }
}

/** 화면 입력은 문자열로 들고 있는다 — 지우는 중인 빈 칸을 0으로 되돌리지 않기 위해서다. */
type LotInput = { price: string; qty: string }

const EMPTY_LOT: LotInput = { price: '', qty: '' }

function toNumber(value: string): number {
  return Number(value.replace(/,/g, '').trim())
}

export function AverageCostCalculator({
  market,
  ticker,
  currentPrice,
  savedAvgCost,
}: {
  market: Market
  ticker: string
  /** 현재가 — 시뮬레이션 기본값이자 평가손익 기준 */
  currentPrice: number
  /** 서버에 저장된 평단가 (없으면 null) */
  savedAvgCost: number | null
}) {
  const router = useRouter()
  // 첫 렌더에서 바로 복원한다. 이 계산기는 카드를 펼쳤을 때만(=클릭 후 클라이언트에서만)
  // 마운트되므로 서버 렌더 결과와 어긋날 일이 없다 — 그래서 useEffect로 미루지 않는다.
  const [lots, setLots] = useState<LotInput[]>(() => {
    const stored = loadStored(market, ticker)
    if (stored && stored.lots.length > 0) {
      return stored.lots.map((l) => ({
        price: l.price ? String(l.price) : '',
        qty: l.qty ? String(l.qty) : '',
      }))
    }
    // 저장된 내역이 없어도 이미 평단가만 넣어 쓰던 사람이 처음부터 다시 입력하지
    // 않도록, 서버 평단가를 1차 매수 한 줄로 깔아준다(수량은 사용자가 채운다).
    if (savedAvgCost != null) return [{ price: String(savedAvgCost), qty: '' }]
    return [EMPTY_LOT]
  })
  const [sellCostPct, setSellCostPct] = useState<string>(() => {
    const stored = loadStored(market, ticker)
    return String(stored && stored.sellCostPct > 0 ? stored.sellCostPct : DEFAULT_SELL_COST_PCT[market])
  })
  const [applyCost, setApplyCost] = useState(true)
  const [addPrice, setAddPrice] = useState('')
  const [addQty, setAddQty] = useState('')
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const numericLots = useMemo<BuyLot[]>(
    () => lots.map((l) => ({ price: toNumber(l.price), qty: toNumber(l.qty) })),
    [lots],
  )
  const costPct = applyCost ? toNumber(sellCostPct) : 0
  const result = useMemo(
    () => computeAverageCost(numericLots, currentPrice, costPct),
    [numericLots, currentPrice, costPct],
  )
  const simulation = useMemo(
    () => simulateAddBuy(numericLots, toNumber(addPrice) || currentPrice, toNumber(addQty)),
    [numericLots, addPrice, addQty, currentPrice],
  )

  // 입력이 바뀔 때마다 브라우저에 저장한다. 저장 버튼을 따로 두면 안 누르고 나갔다가
  // 통째로 날리는 게 이 종류 계산기의 흔한 실패라 자동으로 둔다.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const payload: StoredState = {
        lots: numericLots.map((l) => ({
          price: Number.isFinite(l.price) ? l.price : 0,
          qty: Number.isFinite(l.qty) ? l.qty : 0,
        })),
        sellCostPct: toNumber(sellCostPct) || 0,
      }
      window.localStorage.setItem(storageKey(market, ticker), JSON.stringify(payload))
    } catch {
      // 저장이 막힌 브라우저에서도 계산은 계속된다.
    }
  }, [market, ticker, numericLots, sellCostPct])

  function updateLot(index: number, patch: Partial<LotInput>) {
    setLots((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  function money(value: number): string {
    return market === 'KR'
      ? `${Math.round(value).toLocaleString('ko-KR')}원`
      : `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }

  async function saveAvgCost() {
    if (!result) return
    const pin = askPin()
    if (!pin) return

    setBusy(true)
    setError(null)
    setMessage(null)
    const res = await fetch('/api/watchlist', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-trade-pin': pin },
      body: JSON.stringify({ market, ticker, avgCost: result.avgCost }),
    })
    setBusy(false)

    if (!res.ok) {
      if (res.status === 401) clearPin()
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      setError(data.error ?? '저장에 실패했습니다.')
      return
    }
    setMessage('평단가를 저장했습니다.')
    startTransition(() => router.refresh())
  }

  const working = busy || pending

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-bold">분할매수 평단 계산기</h4>
        <span className="text-xs text-muted-foreground">
          현재가 {currentPrice > 0 ? money(currentPrice) : '—'}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        차수별로 산 가격과 수량을 넣으면 평단가와 평가손익을 계산합니다. 입력은 이 브라우저에만
        저장되고, 아래 버튼을 눌러야 평단가가 서버에 반영됩니다.
      </p>

      <div className="mt-2 space-y-1.5">
        {lots.map((lot, index) => (
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <span className="w-10 shrink-0 text-xs text-muted-foreground">{index + 1}차</span>
            <input
              type="text"
              inputMode="decimal"
              value={lot.price}
              onChange={(e) => updateLot(index, { price: e.target.value })}
              placeholder="단가"
              aria-label={`${index + 1}차 매수 단가`}
              className="h-8 w-28 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring"
            />
            <input
              type="text"
              inputMode="decimal"
              value={lot.qty}
              onChange={(e) => updateLot(index, { qty: e.target.value })}
              placeholder="수량"
              aria-label={`${index + 1}차 매수 수량`}
              className="h-8 w-24 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring"
            />
            {lots.length > 1 && (
              <button
                type="button"
                onClick={() => setLots((prev) => prev.filter((_, i) => i !== index))}
                aria-label={`${index + 1}차 삭제`}
                className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-down/10 hover:text-down"
              >
                삭제
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setLots((prev) => (prev.length >= MAX_LOTS ? prev : [...prev, EMPTY_LOT]))}
          disabled={lots.length >= MAX_LOTS}
          className="rounded-md border border-input bg-card px-2.5 py-1 text-xs font-medium text-secondary-foreground hover:border-ring hover:text-primary disabled:opacity-50"
        >
          + 차수 추가
        </button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={applyCost}
            onChange={(e) => setApplyCost(e.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--primary)]"
          />
          매도 비용 반영
        </label>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <input
            type="text"
            inputMode="decimal"
            value={sellCostPct}
            onChange={(e) => setSellCostPct(e.target.value)}
            disabled={!applyCost}
            aria-label="매도 비용률(%)"
            className="h-7 w-16 rounded-md border border-input px-2 text-right font-mono text-xs outline-none focus:border-ring disabled:opacity-50"
          />
          %
        </span>
      </div>

      {result ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border pt-2.5 text-xs sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">평단가</dt>
              <dd className="font-mono font-semibold">{money(result.avgCost)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">총 수량</dt>
              <dd className="font-mono">{result.totalQty.toLocaleString('ko-KR')}주</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">매입금액</dt>
              <dd className="font-mono">{money(result.totalCost)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">평가금액</dt>
              <dd className="font-mono">{money(result.marketValue)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">평가손익</dt>
              <dd className={`font-mono font-semibold ${changeTextClass(result.netPnl)}`}>
                {result.netPnl >= 0 ? '+' : '−'}
                {money(Math.abs(result.netPnl))}{' '}
                <span className="font-normal">({formatSignedPercent(result.netPnlPct, 2)})</span>
              </dd>
            </div>
            {applyCost && result.sellCost > 0 && (
              <div>
                <dt className="text-muted-foreground">매도 비용</dt>
                <dd className="font-mono">−{money(result.sellCost)}</dd>
              </div>
            )}
            <div>
              <dt className="text-muted-foreground">본전 가격</dt>
              <dd className="font-mono">{money(result.breakevenPrice)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">본전까지</dt>
              <dd className={`font-mono ${changeTextClass(result.breakevenUpsidePct)}`}>
                {currentPrice > 0 ? formatSignedPercent(result.breakevenUpsidePct, 1) : '—'}
              </dd>
            </div>
          </dl>

          <div className="mt-3 rounded-md bg-muted/60 p-2.5">
            <p className="text-xs font-semibold text-secondary-foreground">
              추가 매수하면 평단이 얼마가 될까
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <input
                type="text"
                inputMode="decimal"
                value={addPrice}
                onChange={(e) => setAddPrice(e.target.value)}
                placeholder={currentPrice > 0 ? String(Math.round(currentPrice)) : '단가'}
                aria-label="추가 매수 단가"
                className="h-8 w-28 rounded-md border border-input bg-card px-2 text-right font-mono text-xs outline-none focus:border-ring"
              />
              <input
                type="text"
                inputMode="decimal"
                value={addQty}
                onChange={(e) => setAddQty(e.target.value)}
                placeholder="수량"
                aria-label="추가 매수 수량"
                className="h-8 w-24 rounded-md border border-input bg-card px-2 text-right font-mono text-xs outline-none focus:border-ring"
              />
              <span className="text-xs text-muted-foreground">
                단가를 비우면 현재가로 계산합니다.
              </span>
            </div>
            {simulation && (
              <p className="mt-1.5 text-xs text-secondary-foreground">
                {money(simulation.addCost)}어치를 더 사면 평단가가{' '}
                <span className="font-mono font-semibold">{money(result.avgCost)}</span> →{' '}
                <span className="font-mono font-semibold">{money(simulation.newAvgCost)}</span> (
                <span className={changeTextClass(simulation.avgCostChangePct)}>
                  {formatSignedPercent(simulation.avgCostChangePct, 1)}
                </span>
                ), 총 수량은 {simulation.newTotalQty.toLocaleString('ko-KR')}주가 됩니다.
              </p>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={saveAvgCost}
              disabled={working}
              className="h-8 rounded-md bg-primary px-3 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {working ? '저장 중...' : '이 평단가를 저장'}
            </button>
            {savedAvgCost != null && (
              <span className="text-xs text-muted-foreground">
                저장된 평단가 {money(savedAvgCost)}
              </span>
            )}
            {message && <span className="text-xs text-primary">{message}</span>}
            {error && <span className="text-xs text-down">{error}</span>}
          </div>
        </>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          단가와 수량을 넣으면 평단가가 계산됩니다.
        </p>
      )}
    </div>
  )
}
