'use client'

import { useEffect, useState } from 'react'
import type { Market, PriceHistoryRow } from '@/lib/types'

/**
 * 카드를 펼쳤을 때만 그 종목의 일봉을 받아오는 훅.
 *
 * 화면에 보이는 전 종목의 일봉을 서버 렌더 결과에 실어 보내던 것을 대신한다.
 * 차트는 펼쳐야 보이는데 데이터는 항상 따라오던 구조라, 탭 전환마다 쓰지도 않을
 * 수백 KB를 내려받고 있었다.
 *
 * @param enabled 펼쳐졌는지 여부. false면 아무 것도 하지 않는다.
 */
export function useLazyPriceHistory(
  market: Market,
  ticker: string,
  enabled: boolean,
  days = 150,
): { history: PriceHistoryRow[]; loading: boolean; error: string | null } {
  const [history, setHistory] = useState<PriceHistoryRow[]>([])
  const [error, setError] = useState<string | null>(null)

  // 로딩 여부는 따로 상태로 들지 않고 파생시킨다 — 펼쳐졌는데 아직 봉도 오류도
  // 없으면 받는 중이다. 상태를 하나 더 두면 이펙트 안에서 동기 setState를 하게 되고,
  // 그게 렌더를 한 번 더 유발한다(react-hooks/set-state-in-effect).
  const loading = enabled && history.length === 0 && error === null

  useEffect(() => {
    if (!enabled) return
    // 한 번 받아온 종목은 다시 받지 않는다 — 접었다 펴는 걸 반복해도 요청은 한 번.
    if (history.length > 0) return

    const controller = new AbortController()

    fetch(`/api/price-history?market=${market}&ticker=${encodeURIComponent(ticker)}&days=${days}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        const data = (await res.json()) as { history?: PriceHistoryRow[]; error?: string }
        if (!res.ok) throw new Error(data.error ?? '일봉을 불러오지 못했습니다.')
        setHistory(data.history ?? [])
      })
      .catch((cause: unknown) => {
        // 카드를 도로 접어서 취소된 요청은 오류가 아니다.
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : '일봉을 불러오지 못했습니다.')
      })

    return () => controller.abort()
  }, [enabled, market, ticker, days, history.length])

  return { history, loading, error }
}
