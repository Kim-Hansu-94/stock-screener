'use client'

import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { StockChart } from '@/components/StockChart'
import type {
  DailyReportResult,
  DailyReportResponse,
  NewsArticle,
} from '@/lib/types'

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
      <CriteriaLegend />
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
                  <strong>{visible[0].ticker}</strong> ({visible[0].name_kr || visible[0].name})으로,{' '}
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

function CriteriaLegend() {
  return (
    <div className="rounded-lg border border-indigo-100 bg-indigo-50/70 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-indigo-500">
        종목 선정 기준 안내
      </p>
      <dl className="grid gap-x-6 gap-y-2 text-xs text-gray-600 sm:grid-cols-2">
        <div>
          <dt className="font-medium text-gray-700">Gold Standard 바닥 특성</dt>
          <dd>QBTS · RGTI · AEVA · JOBY · FCEL 등 검증된 바닥 탈출 패턴과의 유사도</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-700">하락률</dt>
          <dd>52주 최고가 대비 하락폭 (점수 가중치 30%)</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-700">저점 유지 N일</dt>
          <dd>저점을 갱신하지 않고 버틴 거래일 수 — 매도 소진 정도 (점수 가중치 40%, 가장 중요)</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-700">거래량 N배</dt>
          <dd>최근 20일 거래량 ÷ 직전 40일 거래량. 70% 이상 유지해야 통과 (점수 가중치 30%)</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-700">VCP ✓ / ✗</dt>
          <dd>단기(10일) 변동성이 장기(50일) 대비 60% 이하로 수축했는지 여부 — 충족 시 +10점 보너스</dd>
        </div>
        <div>
          <dt className="font-medium text-gray-700">이평 ✓ / ✗</dt>
          <dd>현재가 &gt; 5일선 &gt; 10일선 &gt; 20일선 정배열 여부 — 충족 시 +10점 보너스</dd>
        </div>
      </dl>
      <p className="mt-2 text-[11px] text-gray-400">
        ⚡ 거래량 배지는 위 거래량 기준과 별개로, 오늘 거래량이 최근 90일 평균의 2배 이상일 때 표시됩니다.
      </p>
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const diffH = Math.floor(diffMs / 3_600_000)
  if (diffH < 1) return '방금 전'
  if (diffH < 24) return `${diffH}시간 전`
  const diffD = Math.floor(diffH / 24)
  return `${diffD}일 전`
}

function DailyResultCard({ stock }: { stock: DailyReportResult }) {
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [chartReady, setChartReady] = useState(false)
  const [news, setNews] = useState<NewsArticle[] | null>(null)

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setChartReady(true)
          fetch(`/api/stock-news?ticker=${stock.ticker}`)
            .then((r) => r.json())
            .then((d: { news?: NewsArticle[] }) => setNews(d.news ?? []))
            .catch(() => setNews([]))
          observer.disconnect()
        }
      },
      { rootMargin: '300px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [stock.ticker])

  const simPct = (stock.similarity * 100).toFixed(1)
  const latestClose = stock.history[stock.history.length - 1]?.close

  return (
    <Card className={stock.volumeTriggered ? 'border-amber-300' : ''}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>
            <span className="block">
              {stock.name_kr || stock.name}{' '}
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
        <div ref={sentinelRef} className="mt-4 min-h-80">
          {chartReady && (
            <StockChart monthly bollinger rsi preAggregated history={stock.history} />
          )}
        </div>

        {news !== null && news.length > 0 && (
          <div className="mt-4 border-t border-gray-100 pt-3">
            <p className="mb-2 text-xs font-medium text-gray-400">최신 뉴스</p>
            <ul className="space-y-2.5">
              {news.map((article, i) => (
                <li key={i}>
                  <a
                    href={article.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm leading-snug text-gray-800 hover:text-blue-600"
                  >
                    {article.title}
                  </a>
                  <p className="mt-0.5 text-xs text-gray-400">
                    {article.publisher} · {formatRelativeTime(article.publishedAt)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

