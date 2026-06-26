'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StockChart } from '@/components/StockChart'
import type { SimilarStockResult } from '@/lib/types'

export function SimilaritySearch() {
  const [ticker, setTicker] = useState('AEVA')
  const [from, setFrom] = useState('2024-01-01')
  const [to, setTo] = useState('2024-10-01')
  const [results, setResults] = useState<SimilarStockResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const handleSearch = async () => {
    const t = ticker.trim()
    if (!t) return
    setLoading(true)
    setError(null)
    setSearched(false)
    try {
      const res = await fetch(
        `/api/similar?ticker=${encodeURIComponent(t)}&from=${from}&to=${to}`,
      )
      const data = (await res.json()) as { error?: string } | SimilarStockResult[]
      if (!res.ok) {
        setError((data as { error?: string }).error ?? '검색 중 오류가 발생했습니다.')
        setResults([])
      } else {
        setResults(data as SimilarStockResult[])
        setSearched(true)
      }
    } catch {
      setError('서버에 연결하지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-500">기준 티커</span>
          <input
            type="text"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="예: AEVA"
            className="h-9 w-28 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-400"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-500">시작일</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-400"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-gray-500">종료일</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 rounded-md border border-gray-300 px-3 text-sm outline-none focus:border-blue-400"
          />
        </label>
        <button
          type="button"
          onClick={handleSearch}
          disabled={loading || !ticker.trim()}
          className="h-9 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '검색 중...' : '패턴 검색'}
        </button>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {searched && results.length === 0 && !error && (
        <p className="text-sm text-gray-500">유사 패턴 종목을 찾지 못했습니다.</p>
      )}

      {results.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {results.map((stock) => (
            <SimilarStockCard key={stock.ticker} stock={stock} />
          ))}
        </div>
      )}
    </div>
  )
}

function SimilarStockCard({ stock }: { stock: SimilarStockResult }) {
  const [expanded, setExpanded] = useState(false)
  const simPct = (stock.similarity * 100).toFixed(1)
  const latestClose = stock.history[stock.history.length - 1]?.close

  return (
    <Card>
      <CardHeader className="cursor-pointer" onClick={() => setExpanded((v) => !v)}>
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            {stock.name} <span className="text-gray-400">({stock.ticker})</span>
          </span>
          <Badge>유사도 {simPct}%</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-gray-400">섹터</dt>
            <dd>{stock.sector ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-gray-400">현재가</dt>
            <dd>{latestClose != null ? `$${latestClose.toFixed(2)}` : '-'}</dd>
          </div>
        </dl>
        {expanded && (
          <div className="mt-4">
            <StockChart history={stock.history} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
