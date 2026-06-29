'use client'

import { useEffect, useState } from 'react'
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
  const MIN_SIMILARITY = 0.40
  const visible = results.filter((r) => r.similarity >= MIN_SIMILARITY)
  const triggered = visible.filter((r) => r.volumeTriggered)

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm leading-relaxed text-gray-700">
        {visible.length === 0 ? (
          <p>
            오늘 전 종목을 스캔한 결과, 유사도 40% 이상인 종목이 없습니다.
            {results.length > 0 && (
              <span className="ml-1 text-gray-400">
                (최고 유사도: {(results[0].similarity * 100).toFixed(1)}% — 기준 미달)
              </span>
            )}
          </p>
        ) : (
          <>
            <p>
              오늘 전 종목을 스캔한 결과,{' '}
              <strong>{visible.length}개</strong> 종목이 Gold Standard 바닥 특성에 부합했습니다.
              {visible[0] && (
                <>
                  {' '}최고 점수는{' '}
                  <strong>{visible[0].ticker}</strong> ({visible[0].name_kr ?? visible[0].name})으로,{' '}
                  <strong>{(visible[0].similarity * 100).toFixed(1)}%</strong>입니다.
                </>
              )}
            </p>
            {triggered.length > 0 && (
              <p className="mt-2 text-amber-700">
                ⚡ <strong>{triggered.map((r) => r.ticker).join(' · ')}</strong>에서
                오늘 거래량 트리거(90일 평균 대비 2배 이상)가 발동했습니다.
              </p>
            )}
          </>
        )}
        <p className="mt-2 text-xs text-gray-400">
          스캔 시각: {new Date(generatedAt).toLocaleString('ko-KR')}
        </p>
      </div>

      {visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((stock) => (
            <DailyResultCard key={stock.ticker} stock={stock} />
          ))}
        </div>
      )}
    </div>
  )
}

function DailyResultCard({ stock }: { stock: DailyReportResult }) {
  const simPct = (stock.similarity * 100).toFixed(1)
  const latestClose = stock.history[stock.history.length - 1]?.close

  return (
    <Card className={stock.volumeTriggered ? 'border-amber-300' : ''}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            <span className="block">
              {stock.name_kr ?? stock.name}{' '}
              <span className="text-sm font-normal text-gray-400">({stock.ticker})</span>
            </span>
            {stock.name_kr && (
              <span className="block text-xs font-normal text-gray-400">{stock.name}</span>
            )}
          </span>
          <div className="ml-2 flex flex-shrink-0 gap-1.5">
            {stock.volumeTriggered && (
              <Badge className="bg-amber-500 text-white">⚡ 거래량</Badge>
            )}
            <Badge variant="secondary">{simPct}%</Badge>
          </div>
        </CardTitle>
        <p className="text-xs text-gray-400">
          {stock.matchedStandard} · {stock.matchedBottom}
        </p>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-2 text-sm text-gray-600">
          <div>
            <dt className="text-xs text-gray-400">섹터</dt>
            <dd>{stock.sector || '미분류'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-400">현재가</dt>
            <dd>{latestClose != null ? `$${latestClose.toFixed(2)}` : '-'}</dd>
          </div>
        </dl>
        <div className="mt-4">
          <StockChart monthly bollinger rsi history={stock.history} />
        </div>
      </CardContent>
    </Card>
  )
}
