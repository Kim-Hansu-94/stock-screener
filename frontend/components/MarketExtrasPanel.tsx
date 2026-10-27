'use client'

import { useEffect, useState } from 'react'
import { LoadingFallback } from '@/components/LoadingFallback'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import { flowScale, formatKrwCompact, summarizeFlow, type FlowSide } from '@/lib/investorFlow'
import type { ConsensusRow, InvestorFlowRow, Market } from '@/lib/types'

/**
 * 국내 종목 부가 정보 — 수급 · 목표주가 컨센서스.
 *
 * 카드를 펼쳤을 때만 /api/kr-extras로 받아온다(일봉과 같은 방식). 세 값 모두
 * 보물지도에 없던 축이라, 기존 판정(눌림목·매력도 점수)에는 **넣지 않고**
 * 나란히 보여주기만 한다 — 점수에 섞으면 왜 그 점수가 나왔는지 알 수 없게 되고,
 * 지금까지 쌓인 스크리너 성적과도 기준이 달라져 비교가 깨진다.
 *
 * 미국 종목에는 해당 없음이다(외국인·기관 구분도, 증권사 컨센서스도 국내 시장
 * 개념이고 소스도 네이버다). 그 경우 섹션째 렌더하지 않는다.
 */

type ExtrasResponse = {
  flow: InvestorFlowRow[]
  consensus: ConsensusRow | null
  unsupported?: boolean
}

function FlowBars({ rows, side, label }: { rows: InvestorFlowRow[]; side: FlowSide; label: string }) {
  const scale = flowScale(rows)
  const summary = summarizeFlow(rows, side)
  if (summary.days === 0) return null

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-semibold text-secondary-foreground">{label}</span>
        <span className="text-xs">
          <span className={`font-mono font-semibold ${changeTextClass(summary.netQty)}`}>
            {summary.netQty >= 0 ? '순매수 ' : '순매도 '}
            {formatKrwCompact(Math.abs(summary.netAmount))}
          </span>
          <span className="ml-1.5 text-muted-foreground">
            {summary.days}일 중 {summary.buyDays}일 매수
            {Math.abs(summary.streak) >= 2 &&
              ` · ${Math.abs(summary.streak)}일 연속 ${summary.streak > 0 ? '순매수' : '순매도'}`}
          </span>
        </span>
      </div>
      {/* 0을 가운데 둔 좌우 대칭 막대. 위로 뻗으면 순매수(빨강), 아래로 뻗으면
          순매도(파랑) — 한국 증권 관례를 그대로 따른다. */}
      <div className="mt-1 flex h-10 items-center gap-px" aria-hidden>
        {rows.map((row) => {
          const qty = side === 'foreign' ? row.foreign_net_qty : row.institution_net_qty
          const ratio = qty === null || scale === 0 ? 0 : Math.abs(qty) / scale
          const up = (qty ?? 0) > 0
          return (
            <div key={row.date} className="flex h-full flex-1 flex-col justify-center" title={`${row.date}`}>
              <div className="flex h-1/2 items-end">
                {up && (
                  <div className="w-full rounded-t-[1px] bg-up" style={{ height: `${ratio * 100}%` }} />
                )}
              </div>
              <div className="flex h-1/2 items-start">
                {!up && qty !== null && qty !== 0 && (
                  <div className="w-full rounded-b-[1px] bg-down" style={{ height: `${ratio * 100}%` }} />
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-0.5 text-right text-[10px] text-muted-foreground/70">
        {rows[0]?.date} ~ {rows[rows.length - 1]?.date}
      </p>
    </div>
  )
}

function ConsensusBlock({ consensus, close }: { consensus: ConsensusRow; close: number | null }) {
  // 저장 시점 종가로 계산해 둔 값이 있지만, 화면에 최신 종가가 있으면 그걸로 다시
  // 계산한다 — 저장은 하루 한 번이라 그 사이 가격이 움직였을 수 있다.
  const upside =
    close && close > 0 ? (consensus.target_price / close - 1) * 100 : consensus.upside_pct

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-semibold text-secondary-foreground">증권사 목표주가</span>
        {consensus.report_count != null && (
          <span className="text-xs text-muted-foreground">리포트 {consensus.report_count}건</span>
        )}
      </div>
      <p className="mt-0.5 text-sm">
        <span className="font-mono font-bold">
          {Math.round(consensus.target_price).toLocaleString('ko-KR')}원
        </span>
        {upside != null && (
          <span className={`ml-1.5 font-mono text-xs font-semibold ${changeTextClass(upside)}`}>
            상승여력 {formatSignedPercent(upside, 1)}
          </span>
        )}
        {consensus.opinion && (
          <span className="ml-1.5 rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground">
            {consensus.opinion}
          </span>
        )}
      </p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground/70">
        애널리스트의 12개월 밸류에이션 목표입니다. 이 사이트가 카드에 표시하는 목표가(변동성
        기반 단기 매매 목표)와는 성격이 달라 일부러 합치지 않았습니다. 기준일 {consensus.date}
      </p>
    </div>
  )
}

export function MarketExtrasPanel({
  market,
  ticker,
  close = null,
  className = '',
}: {
  market: Market
  ticker: string
  /** 상승여력을 최신 종가로 다시 계산하는 데 쓴다. 없으면 저장된 값을 그대로 쓴다. */
  close?: number | null
  className?: string
}) {
  const [data, setData] = useState<ExtrasResponse | null>(null)
  // 로딩 여부는 파생시킨다 — 이펙트 안에서 동기 setState를 하지 않기 위해서다.
  const loading = market === 'KR' && data === null

  useEffect(() => {
    if (market !== 'KR') return
    const controller = new AbortController()
    fetch(`/api/kr-extras?market=${market}&ticker=${encodeURIComponent(ticker)}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((d: ExtrasResponse) => setData(d))
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        // 부가 정보라 실패해도 카드는 그대로 보여야 한다 — 빈 값으로 두면 섹션이 숨는다.
        setData({ flow: [], consensus: null })
      })
    return () => controller.abort()
  }, [market, ticker])

  if (market !== 'KR') return null
  if (loading) return <LoadingFallback label="수급·컨센서스 불러오는 중..." className={`py-4 ${className}`} />
  if (!data) return null

  const hasFlow = data.flow.length > 0
  const hasAnything = hasFlow || data.consensus
  // 아직 수집 워크플로가 한 번도 안 돌았으면 아무 것도 없는 게 정상이다.
  // 빈 껍데기 제목만 남기지 않도록 섹션째 숨긴다.
  if (!hasAnything) return null

  return (
    <div className={`space-y-3 ${className}`}>
      <p className="text-xs font-bold text-foreground">시장이 이 종목을 어떻게 보고 있나</p>

      {data.consensus && <ConsensusBlock consensus={data.consensus} close={close} />}

      {hasFlow && (
        <div className="space-y-2.5">
          <FlowBars rows={data.flow} side="foreign" label="외국인 수급" />
          <FlowBars rows={data.flow} side="institution" label="기관 수급" />
          <p className="text-[10px] leading-relaxed text-muted-foreground/70">
            순매매 수량 × 종가로 계산한 근사 금액입니다(장중 평균단가가 아닙니다). 수급은 근거의
            한 축일 뿐이며, 이 값은 스크리닝 점수에 반영되지 않습니다.
          </p>
        </div>
      )}
    </div>
  )
}
