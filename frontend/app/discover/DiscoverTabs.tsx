'use client'

import { useState } from 'react'
import { DailyReport } from './DailyReport'
import { SimilaritySearch } from './SimilaritySearch'
import { OpportunityTab } from './OpportunityTab'
import type { OpportunityStockRow } from '@/lib/types'

type Tab = 'report' | 'search' | 'opportunity'

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: '오늘의 추천' },
  { id: 'search', label: '패턴 검색' },
  { id: 'opportunity', label: '횡보 조정 종목' },
]

export function DiscoverTabs({
  opportunities,
  opportunityError,
  usdKrwRate,
  ownedTickers,
}: {
  opportunities: OpportunityStockRow[]
  opportunityError: string | null
  usdKrwRate: number
  ownedTickers: string[]
}) {
  const [tab, setTab] = useState<Tab>('report')

  return (
    <div className="space-y-5">
      <div className="flex gap-5 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 pb-2.5 text-sm transition-colors ${
              tab === t.id
                ? 'border-foreground font-bold text-foreground'
                : 'border-transparent font-medium text-muted-foreground hover:text-secondary-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'report' && (
        <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-foreground">오늘의 추천 종목</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Gold Standard 5종목(QBTS · RGTI · AEVA · JOBY · FCEL)의 바닥 패턴과 싱크로율이 가장 높은 상위 20종목을 매일 자동 스캔합니다.
            </p>
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <p><span className="font-medium text-muted-foreground">Gold 패턴 출처:</span> 파이프라인 사전 계산 (Supabase)</p>
              <p><span className="font-medium text-muted-foreground">비교 대상 출처:</span> 파이프라인이 수집한 Russell 3000 전 종목 (Supabase)</p>
            </div>
          </div>
          <DailyReport />
        </section>
      )}

      {tab === 'search' && (
        <section className="rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-foreground">패턴 유사 종목 검색</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              티커를 입력하면 현재 비슷하게 움직이는 종목을 찾아드립니다. 아이디어 검증 및 차트 공부용입니다.
            </p>
            <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              <p><span className="font-medium text-muted-foreground">기준 종목 출처:</span> Yahoo Finance 실시간 (입력한 티커를 직접 다운로드)</p>
              <p><span className="font-medium text-muted-foreground">비교 대상 출처:</span> 파이프라인이 수집한 Russell 3000 전 종목 (Supabase)</p>
            </div>
          </div>
          <SimilaritySearch />
        </section>
      )}

      {tab === 'opportunity' && (
        <OpportunityTab
          opportunities={opportunities}
          opportunityError={opportunityError}
          usdKrwRate={usdKrwRate}
          ownedTickers={ownedTickers}
        />
      )}
    </div>
  )
}
