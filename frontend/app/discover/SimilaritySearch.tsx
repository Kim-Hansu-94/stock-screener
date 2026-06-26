'use client'

import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StockChart } from '@/components/StockChart'
import type { SimilarStockResult, SimilarSearchResponse } from '@/lib/types'

export function SimilaritySearch() {
  const [ticker, setTicker] = useState('AEVA')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [results, setResults] = useState<SimilarStockResult[]>([])
  const [detectedPeriod, setDetectedPeriod] = useState<{ from: string; to: string } | null>(null)
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
      let url = `/api/similar?ticker=${encodeURIComponent(t)}`
      if (from && to) url += `&from=${from}&to=${to}`
      const res = await fetch(url)
      const data = (await res.json()) as { error?: string } | SimilarSearchResponse
      if (!res.ok) {
        setError((data as { error?: string }).error ?? '검색 중 오류가 발생했습니다.')
        setResults([])
        setDetectedPeriod(null)
      } else {
        const resp = data as SimilarSearchResponse
        setResults(resp.results)
        setDetectedPeriod({ from: resp.detectedFrom, to: resp.detectedTo })
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
      <div className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-500">
        <p className="mb-1 font-semibold text-gray-700">알고리즘</p>
        <ol className="list-decimal list-inside space-y-0.5">
          <li>거래대금 하위 20% · 심한 역배열 종목 사전 제거</li>
          <li>변동성 수축 조건: 최근 20일 수익률 σ &lt; 직전 60일 σ × 0.5 (바닥 다지기 확인)</li>
          <li>매집봉 조건: 최근 60일 내 직전 90일 평균 거래량 500% 초과일이 2회 이상</li>
          <li>기준 종목의 바닥 구간 일별 수익률 + 거래량 비율을 Z-score로 정규화</li>
          <li>코사인 유사도 계산 — 수익률 80% · 거래량 20% 가중 합산 후 상위 20종목 반환</li>
        </ol>
        <p className="mt-1.5 text-gray-400">
          티커만 입력하면 최근 바닥 구간을 자동 감지합니다. 특정 기간을 지정하려면 고급 옵션을 사용하세요.
        </p>
      </div>

      {/* 메인 입력 */}
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
        <button
          type="button"
          onClick={handleSearch}
          disabled={loading || !ticker.trim()}
          className="h-9 rounded-md bg-blue-600 px-5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? '검색 중...' : '패턴 검색'}
        </button>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="h-9 px-3 text-xs text-gray-400 hover:text-gray-600"
        >
          {showAdvanced ? '고급 옵션 닫기 ▲' : '고급 옵션 (기간 직접 지정) ▼'}
        </button>
      </div>

      {/* 고급 옵션: 날짜 직접 지정 */}
      {showAdvanced && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
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
          {(from || to) && (
            <button
              type="button"
              onClick={() => { setFrom(''); setTo('') }}
              className="h-9 px-3 text-xs text-gray-400 hover:text-red-500"
            >
              초기화
            </button>
          )}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* 감지된 기간 표시 */}
      {searched && detectedPeriod && (
        <p className="text-xs text-gray-400">
          분석 기간: {detectedPeriod.from} ~ {detectedPeriod.to}
          {!(from && to) && ' (자동 감지)'}
        </p>
      )}

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
