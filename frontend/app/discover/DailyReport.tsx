'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StockChart } from '@/components/StockChart'
import type { DailyReportResult, DailyReportResponse } from '@/lib/types'

export function DailyReport() {
  const [data, setData] = useState<DailyReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/daily-report')
      .then((r) => r.json())
      .then((d: unknown) => {
        if (d && typeof d === 'object' && 'error' in d) {
          setError((d as { error: string }).error)
        } else {
          setData(d as DailyReportResponse)
        }
      })
      .catch(() => setError('서버에 연결하지 못했습니다.'))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm text-blue-500">
        패턴 매칭 결과 불러오는 중...
      </div>
    )
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>
  if (!data) return null

  const { results, generatedAt } = data
  const triggered = results.filter((r) => r.volumeTriggered)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm leading-relaxed text-gray-700">
        {results.length === 0 ? (
          <p>오늘 전 종목을 스캔한 결과, 변동성 수축 + 매집봉 조건을 충족하는 종목이 없습니다.</p>
        ) : (
          <>
            <p>
              오늘 전 종목을 스캔한 결과,{' '}
              <strong>{results.length}개</strong> 종목이 Gold Standard 바닥 패턴과 부합했습니다.
              {results[0] && (
                <>
                  {' '}최고 매칭은{' '}
                  <strong>{results[0].ticker}</strong> ({results[0].name})으로,{' '}
                  <strong>{results[0].matchedStandard}</strong>의 바닥 패턴과
                  유사도 <strong>{(results[0].similarity * 100).toFixed(1)}%</strong>입니다.
                </>
              )}
            </p>
            {triggered.length > 0 && (
              <p className="mt-2 text-amber-700">
                ⚡ <strong>{triggered.map((r) => r.ticker).join(' · ')}</strong>에서
                오늘 거래량 트리거(평균 대비 3배 이상)가 발동했습니다.
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-gray-400">
          스캔 시각: {new Date(generatedAt).toLocaleString('ko-KR')}
        </p>
      </div>

      {results.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {results.map((stock) => (
            <DailyResultCard key={stock.ticker} stock={stock} />
          ))}
        </div>
      )}
    </div>
  )
}

function DailyResultCard({ stock }: { stock: DailyReportResult }) {
  const [expanded, setExpanded] = useState(false)
  const simPct = (stock.similarity * 100).toFixed(1)
  const latestClose = stock.history[stock.history.length - 1]?.close

  return (
    <Card className={stock.volumeTriggered ? 'border-amber-300' : ''}>
      <CardHeader
        className="cursor-pointer pb-2"
        onClick={() => setExpanded((v) => !v)}
      >
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            {stock.name}{' '}
            <span className="text-sm font-normal text-gray-400">({stock.ticker})</span>
          </span>
          <div className="ml-2 flex flex-shrink-0 gap-1.5">
            {stock.volumeTriggered && (
              <Badge className="bg-amber-500 text-white">⚡ 거래량</Badge>
            )}
            <Badge variant="secondary">{simPct}%</Badge>
          </div>
        </CardTitle>
        <p className="text-xs text-gray-400">
          {stock.matchedStandard} ({stock.matchedStandardTicker}) · 바닥 {stock.matchedBottom}
        </p>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-xs text-gray-400">섹터</dt>
            <dd>{stock.sector ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">현재가</dt>
            <dd>{latestClose != null ? `$${latestClose.toFixed(2)}` : '-'}</dd>
          </div>
        </dl>
        {expanded && stock.history.length > 0 && (
          <div className="mt-4">
            <StockChart history={stock.history} />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
