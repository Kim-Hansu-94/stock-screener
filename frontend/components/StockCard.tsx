'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { calculateChangePercent, formatKrwAmount, formatRelativeTime } from '@/lib/calculations'
import type { Market, NewsArticle, PriceHistoryRow, ScreenedStockRow } from '@/lib/types'
import type { RiskFrame, RiskReason, TargetBasis } from '@/lib/risk'
import { RISK_FRAME_LABEL, RISK_GRADE_CLASS, riskGrade } from '@/lib/riskGrade'
import { changeTintClass, signedPercentBetween } from '@/lib/marketColors'
import { translateSector } from '@/lib/sectorMap'
import { MARKET_BEAR_CRITERION, STOCK_CRITERIA_COUNT } from '@/lib/screenerCriteria'
import { BuyButton } from '@/components/TradeButton'
import { LoadingFallback } from '@/components/LoadingFallback'
import { Spinner } from '@/components/Spinner'

// lightweight-charts는 카드를 펼쳤을 때만 필요하므로 초기 번들에서 제외한다.
// 모바일 첫 로딩의 JS 다운로드·파싱 시간을 줄이는 것이 목적.
const StockChart = dynamic(
  () => import('./StockChart').then((mod) => mod.StockChart),
  { ssr: false, loading: () => <LoadingFallback label="차트 로딩 중..." className="py-8" /> },
)

interface StockCardProps {
  stock: ScreenedStockRow
  history: PriceHistoryRow[]
  market: Market
  usdKrwRate: number
  stop: number | null
  target: number | null
  riskReward: number | null
  riskReason: RiskReason
  riskFrame: RiskFrame | null
  /** 목표가까지 가는 길에 걸린 첫 저항 — 한 번 막힐 수 있는 지점 */
  wayResistance: number | null
  /** 목표가의 산출 근거 — 차트상 저항인지, 위쪽에 저항이 없어 쓴 기본값인지 */
  targetBasis: TargetBasis | null
  /** 이미 가상 매수해 둔 종목인지 (매수 버튼 대신 '보유 중' 표시) */
  owned?: boolean
}

// 목표가가 실제 차트 저항이 아니라 근거값(리스크 관리 규칙)일 때만 보여주는 안내.
// 손익비가 2.00으로 자주 뭉쳐 보이는 이유가 버그가 아니라, 상방이 열려 있어(신고가
// 부근이라 위에 막힐 가격이 없어) 정확한 계산이 불가능할 때 보수적으로 2.0을 쓰기로
// 한 규칙임을 밝혀, 사용자가 목표가를 차트에 없는 저항으로 오인하지 않게 한다.
const TARGET_BASIS_NOTE: Partial<Record<TargetBasis, string>> = {
  default_2r: '상방이 열려 있어 정확한 손익비 계산이 어려움 · 보수적으로 2.0 적용',
}

// 손익비가 산출되지 않은 사유를 화면 문구로 변환. 빈 "—"가 오류로 오인되지 않도록
// 무엇이 막았는지 설명한다.
const RISK_REASON_LABEL: Record<Exclude<RiskReason, 'ok'>, string> = {
  insufficient_data: '데이터 부족',
  stop_above_entry: '손절 산출 불가',
  no_upside: '박스 상단 도달',
}

// 상수는 lib/screenerCriteria.ts 한 곳에서만 정의한다(성적 집계도 같은 값을 쓴다).
// 하락장 날은 시장 단위 조건('시장 하락장')이 failed_criteria에 추가돼 분모가 1 늘어난다.

/** 손절 ← 현재가 → 목표를 막대 하나로. 빨간 구간이 위험, 파란 구간이 기대. */
function RiskRewardBar({
  stop,
  close,
  target,
  market,
}: {
  stop: number
  close: number
  target: number
  market: Market
}) {
  const span = target - stop
  if (span <= 0) return null
  // 현재가가 손절~목표 사이 어디쯤인지. 이 위치가 왼쪽에 가까울수록 손익비가 좋다.
  const pos = Math.min(100, Math.max(0, ((close - stop) / span) * 100))

  const price = (value: number) =>
    market === 'KR'
      ? Math.round(value).toLocaleString('ko-KR')
      : `$${value.toFixed(2)}`

  return (
    <div className="flex flex-col gap-2">
      {/* 왼쪽(손절까지)은 하락 구간이라 파랑, 오른쪽(목표까지)은 상승 구간이라 빨강.
          빨간 구간이 파란 구간보다 길수록 손익비가 좋다는 뜻이 눈으로 읽힌다. */}
      <div className="relative h-1.5 overflow-hidden rounded-full bg-down">
        <div
          className="absolute inset-y-0 right-0 rounded-full bg-up"
          style={{ left: `${pos}%` }}
        />
      </div>
      <div className="flex justify-between text-[11.5px] tabular-nums">
        <span className="font-semibold text-down">
          {price(stop)}
          <span className="ml-1 font-medium text-muted-foreground">
            손절 {signedPercentBetween(stop, close)}
          </span>
        </span>
        <span className="text-right font-semibold text-up">
          {price(target)}
          <span className="ml-1 font-medium text-muted-foreground">
            목표 {signedPercentBetween(target, close)}
          </span>
        </span>
      </div>
    </div>
  )
}

export function StockCard({ stock, history, market, usdKrwRate, stop, target, riskReward, riskReason, riskFrame, wayResistance, targetBasis, owned = false }: StockCardProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const [news, setNews] = useState<NewsArticle[] | null>(null)
  const [newsLoading, setNewsLoading] = useState(false)
  const changePercent = calculateChangePercent(history.map((row) => row.close))

  const newsQuery = market === 'KR' ? (stock.name_kr || stock.name) : stock.ticker

  // 하락장 날은 시장 조건 1개가 더해져 분모가 10, 평상시엔 9.
  const totalCriteria =
    STOCK_CRITERIA_COUNT + (stock.failed_criteria.includes(MARKET_BEAR_CRITERION) ? 1 : 0)
  const metCriteria = totalCriteria - stock.failed_criteria.length

  useEffect(() => {
    if (!isExpanded || news !== null) return
    setNewsLoading(true)
    fetch(`/api/stock-news?q=${encodeURIComponent(newsQuery)}`)
      .then((r) => r.json())
      .then((d: { news?: NewsArticle[] }) => setNews(d.news ?? []))
      .catch(() => setNews([]))
      .finally(() => setNewsLoading(false))
  }, [isExpanded, newsQuery, news])

  // 미장은 달러가 주 표기, 원화는 보조로 작게 붙인다.
  const closeMain =
    market === 'US'
      ? `$${stock.close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : stock.close.toLocaleString('ko-KR')
  const closeSub =
    market === 'US' ? `${Math.round(stock.close * usdKrwRate).toLocaleString('ko-KR')}원` : null

  const marketCapDisplay =
    market === 'US' ? formatKrwAmount(stock.market_cap * usdKrwRate) : formatKrwAmount(stock.market_cap)

  const grade = riskReward !== null && riskFrame !== null ? riskGrade(riskReward, riskFrame) : null

  return (
    <Card>
      <CardHeader className="cursor-pointer gap-4" onClick={() => setIsExpanded((current) => !current)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-lg leading-tight font-bold tracking-tight">
              {stock.name_kr || stock.name}
            </span>
            <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
              <span className="font-mono font-semibold text-secondary-foreground">{stock.ticker}</span>
              <span aria-hidden="true">·</span>
              <span>{translateSector(stock.sector)}</span>
              <span aria-hidden="true">·</span>
              <span>{marketCapDisplay}</span>
            </span>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-0.5 text-right">
            <span className="text-xl leading-none font-bold tracking-tight tabular-nums">
              {closeMain}
            </span>
            <span
              className={`rounded-md px-1.5 py-0.5 text-sm font-semibold tabular-nums ${changeTintClass(changePercent)}`}
            >
              {changePercent === null
                ? '등락률 없음'
                : `${changePercent > 0 ? '+' : changePercent < 0 ? '−' : ''}${Math.abs(changePercent).toFixed(2)}%`}
            </span>
            {closeSub && <span className="text-xs text-muted-foreground tabular-nums">{closeSub}</span>}
          </div>
        </div>

        {stock.passed === false ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-lg bg-muted px-2.5 py-1 text-xs font-semibold text-secondary-foreground tabular-nums">
              조건 {metCriteria}/{totalCriteria} 충족 · 참고용
            </span>
            {stock.failed_criteria.map((criterion) => (
              <span
                key={criterion}
                className="rounded-lg bg-muted px-2 py-1 text-xs text-muted-foreground"
              >
                {criterion}
              </span>
            ))}
          </div>
        ) : (
          <span className="flex w-fit items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1 text-xs font-semibold text-accent-foreground">
            <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden="true">
              <path
                d="M3 8.5l3.2 3.2L13 5"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {totalCriteria}개 조건 모두 충족
          </span>
        )}

        {/* 카드 헤더 전체가 '펼치기' 클릭 영역이라, 버튼 클릭이 펼침으로 새지 않게 막는다. */}
        <div onClick={(e) => e.stopPropagation()}>
          <BuyButton
            market={market}
            ticker={stock.ticker}
            name={stock.name_kr || stock.name}
            sector={stock.sector}
            source="pullback"
            owned={owned}
          />
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* 손익비를 카드의 주인공으로. 숫자만 보고 지나치지 않게 손절~목표 막대를 함께 둔다. */}
        <div className="flex flex-col gap-3.5 rounded-lg bg-muted/60 p-4">
          <div className="flex items-end justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">손익비</span>
              {riskReward !== null && grade !== null ? (
                <span className={`text-2xl leading-none font-extrabold tracking-tight tabular-nums ${RISK_GRADE_CLASS[grade]}`}>
                  {riskReward.toFixed(2)}
                  <span className="text-base font-bold">R</span>
                </span>
              ) : (
                <span className="text-base font-semibold text-muted-foreground">
                  {riskReason === 'ok' ? '—' : RISK_REASON_LABEL[riskReason]}
                </span>
              )}
            </div>
            {riskFrame !== null && (
              <span className="rounded-md bg-secondary px-2 py-1 text-[11px] font-semibold text-secondary-foreground">
                {RISK_FRAME_LABEL[riskFrame]}
              </span>
            )}
          </div>
          {stop !== null && target !== null && (
            <RiskRewardBar stop={stop} close={stock.close} target={target} market={market} />
          )}
          {targetBasis !== null && TARGET_BASIS_NOTE[targetBasis] && (
            <p className="text-[11px] leading-snug text-muted-foreground">
              {TARGET_BASIS_NOTE[targetBasis]}
            </p>
          )}
        </div>

        {/* 지표는 라벨 왼쪽 · 값 오른쪽 리스트로. 2열 그리드보다 스캔이 빠르다. */}
        <dl className="flex flex-col">
          <div className="flex items-center justify-between border-t border-border py-2.5 first:border-t-0 first:pt-0">
            <dt className="text-sm font-medium text-muted-foreground">RSI</dt>
            <dd className="text-sm font-semibold tabular-nums">{stock.rsi.toFixed(1)}</dd>
          </div>
          {wayResistance !== null && (
            <div className="flex items-center justify-between border-t border-border py-2.5">
              <dt className="text-sm font-medium text-muted-foreground">경유 저항</dt>
              <dd className="text-sm font-semibold tabular-nums">
                {market === 'KR'
                  ? Math.round(wayResistance).toLocaleString('ko-KR')
                  : `$${wayResistance.toFixed(2)}`}
                <span className="ml-1.5 text-xs font-medium text-muted-foreground">
                  {signedPercentBetween(wayResistance, stock.close)}
                </span>
              </dd>
            </div>
          )}
        </dl>

        {isExpanded && (
          <div>
            <StockChart
              history={history}
              bollinger
              rsi
              stopPrice={stop ?? undefined}
              targetPrice={target ?? undefined}
            />
            {newsLoading && (
              <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner className="size-3" />
                뉴스 불러오는 중...
              </p>
            )}
            {!newsLoading && news && news.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <p className="mb-2 text-xs font-semibold text-muted-foreground">최신 뉴스</p>
                <ul className="space-y-2.5">
                  {news.map((article, i) => (
                    <li key={i}>
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-sm leading-snug font-medium hover:text-primary"
                      >
                        {article.title}
                      </a>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {article.publisher} · {formatRelativeTime(article.publishedAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
