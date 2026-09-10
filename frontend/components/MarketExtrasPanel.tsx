'use client'

import { useEffect, useState } from 'react'
import { LoadingFallback } from '@/components/LoadingFallback'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import { flowScale, formatKrwCompact, summarizeFlow, type FlowSide } from '@/lib/investorFlow'
import type { BuybackRow, ConsensusRow, InvestorFlowRow, Market } from '@/lib/types'

/**
 * 국내 종목 부가 정보 — 수급 · 목표주가 컨센서스 · 자사주 매입.
 *
 * 카드를 펼쳤을 때만 /api/kr-extras로 받아온다(일봉과 같은 방식). 세 값 모두
 * 보물지도에 없던 축이라, 기존 판정(눌림목·매력도 점수)에는 **넣지 않고**
 * 나란히 보여주기만 한다 — 점수에 섞으면 왜 그 점수가 나왔는지 알 수 없게 되고,
 * 지금까지 쌓인 스크리너 성적과도 기준이 달라져 비교가 깨진다.
 *
 * 미국 종목에는 해당 없음이다(외국인·기관 구분, 증권사 컨센서스, 자기주식 공시는
 * 국내 시장 개념이고 소스도 네이버·DART다). 그 경우 섹션째 렌더하지 않는다.
 */

type ExtrasResponse = {
  flow: InvestorFlowRow[]
  consensus: ConsensusRow | null
  buyback: BuybackRow | null
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

function BuybackBlock({ buyback }: { buyback: BuybackRow }) {
  // 진행률이 세 종류라 무엇을 보여줄지가 중요하다. 우선순위는 근거의 강도 순이다:
  //   1) 취득 금액 확정 (결과보고서) — 지금은 DART에 정형 API가 없어 거의 안 채워진다
  //   2) 위탁증권사 창구 누적 순매수 (추정) — 진행 중에 따라갈 수 있는 유일한 값
  //   3) 취득 기간 경과율 (근사) — 아무것도 없을 때의 마지막 수단
  // 셋을 하나로 합치지 않는다. 합치면 화면에서 어느 근거인지 알 수 없게 된다.
  const basis =
    buyback.amount_progress_pct != null
      ? { pct: buyback.amount_progress_pct, label: '취득 금액 기준 (공시 확정)' }
      : buyback.estimated_progress_pct != null
        ? {
            pct: buyback.estimated_progress_pct,
            label: `${buyback.broker ?? '위탁 증권사'} 창구 순매수 기준 (추정)`,
          }
        : buyback.period_progress_pct != null
          ? { pct: buyback.period_progress_pct, label: '취득 기간 기준 (실제 매입량 아님)' }
          : null

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="text-xs font-semibold text-secondary-foreground">
          자사주 {buyback.is_disposal ? '처분' : '매입'}
        </span>
        {buyback.latest_report_date && (
          <span className="text-xs text-muted-foreground">공시 {buyback.latest_report_date}</span>
        )}
      </div>

      {basis && (
        <>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full ${buyback.is_disposal ? 'bg-down' : 'bg-primary'}`}
              style={{ width: `${Math.min(Math.max(basis.pct, 0), 100)}%` }}
            />
          </div>
          <p className="mt-0.5 text-xs">
            <span className="font-mono font-semibold">{basis.pct.toFixed(0)}%</span>
            <span className="ml-1 text-muted-foreground">진행 · {basis.label}</span>
          </p>
        </>
      )}

      {buyback.planned_amount != null && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {buyback.is_disposal ? '처분' : '취득'} 예정 {formatKrwCompact(buyback.planned_amount)}원
          {buyback.planned_qty != null && ` (${Math.round(buyback.planned_qty).toLocaleString('ko-KR')}주)`}
          {buyback.period_start && buyback.period_end && ` · ${buyback.period_start} ~ ${buyback.period_end}`}
        </p>
      )}

      {/* 창구 추정치는 별도 줄로 근거를 다 드러낸다 — 어느 증권사인지, 며칠 관측했는지,
          왜 확정치가 아닌지. 숫자만 보여주면 확정 진행률과 구분이 안 된다. */}
      {buyback.estimated_amount != null && buyback.estimated_amount > 0 && (
        <p className="mt-1 rounded-md bg-accent/60 px-2 py-1.5 text-xs leading-relaxed text-accent-foreground">
          <b>{buyback.broker ?? '위탁 증권사'}</b> 창구에서{' '}
          <span className="font-mono font-semibold">
            {formatKrwCompact(buyback.estimated_amount)}원
          </span>
          {buyback.estimated_qty != null &&
            ` (${Math.round(buyback.estimated_qty).toLocaleString('ko-KR')}주)`}{' '}
          순매수
          {buyback.observed_days != null && ` · ${buyback.observed_days}일 관측`}.
          <span className="text-accent-foreground/70">
            {' '}
            회사가 자사주를 이 창구로 사겠다고 공시했기 때문에 매입 진행을 가늠하는 데 쓰지만, 그
            창구 매수가 전부 자사주는 아닙니다(같은 증권사의 다른 주문이 섞입니다). 확정 수치는
            취득이 끝난 뒤 결과보고서로 공시됩니다.
          </span>
        </p>
      )}

      {buyback.latest_report && (
        <p className="mt-0.5 text-xs text-muted-foreground">
          {buyback.latest_report_url ? (
            <a
              href={buyback.latest_report_url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-dotted underline-offset-2 hover:text-primary"
            >
              {buyback.latest_report} (공시 원문)
            </a>
          ) : (
            buyback.latest_report
          )}
        </p>
      )}
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
        setData({ flow: [], consensus: null, buyback: null })
      })
    return () => controller.abort()
  }, [market, ticker])

  if (market !== 'KR') return null
  if (loading) return <LoadingFallback label="수급·컨센서스 불러오는 중..." className={`py-4 ${className}`} />
  if (!data) return null

  const hasFlow = data.flow.length > 0
  const hasAnything = hasFlow || data.consensus || data.buyback
  // 아직 수집 워크플로가 한 번도 안 돌았으면 아무 것도 없는 게 정상이다.
  // 빈 껍데기 제목만 남기지 않도록 섹션째 숨긴다.
  if (!hasAnything) return null

  return (
    <div className={`space-y-3 ${className}`}>
      <p className="text-xs font-bold text-foreground">시장이 이 종목을 어떻게 보고 있나</p>

      {data.consensus && <ConsensusBlock consensus={data.consensus} close={close} />}
      {data.buyback && <BuybackBlock buyback={data.buyback} />}

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
