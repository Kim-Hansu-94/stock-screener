import { Suspense } from 'react'
import { connection } from 'next/server'
import { getScorecardTrades, getScreenedStockPerformance, getRegimesInRange } from '@/lib/queries/performance'
import { segmentBy, summarize, MIN_SEGMENT_SAMPLE, MAX_HOLD_BARS } from '@/lib/scorecard'
import { translateSector } from '@/lib/sectorMap'
import { PerformanceTable } from '@/components/PerformanceTable'
import { ScorecardVerdict, SegmentTable } from '@/components/Scorecard'
import type { ResolvedTrade } from '@/lib/scorecard'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

function Segments({ trades }: { trades: ResolvedTrade[] }) {
  // 가장 실용적인 질문: 전 조건 통과는 드무니, 미달 1~2개짜리 후보도 따라갈 만한가?
  // (화면에 매일 뜨는 게 실제로는 이쪽이다.)
  const byMiss = segmentBy(
    trades,
    (t) => String(Math.min(t.missCount, 3)),
    (k) => (k === '0' ? '전 조건 통과' : k === '3' ? '3개 이상 미달' : `${k}개 미달`),
  ).sort((a, b) => Number(a.key) - Number(b.key))

  const byRegime = segmentBy(
    trades,
    (t) => t.regime,
    (k) => (k === 'bull' ? '상승장' : '하락장'),
  )
  const byMarket = segmentBy(
    trades,
    (t) => t.market,
    (k) => (k === 'KR' ? '한국' : '미국'),
  )
  const bySector = segmentBy(trades, (t) => t.sector || null, translateSector)

  if (byMiss.length === 0 && byRegime.length === 0 && byMarket.length === 0 && bySector.length === 0) {
    return null
  }

  return (
    <Section title="어떤 추천이 잘 맞았나">
      <p className="text-xs text-muted-foreground">
        구간마다 추천 1건당 평균 손익입니다. 오른쪽(빨강)으로 뻗을수록 그 구간에서 잘 통했다는 뜻입니다.
        표본 {MIN_SEGMENT_SAMPLE}건 미만인 구간은 착시라 뺐습니다.
      </p>
      <div className="space-y-5">
        <SegmentTable title="조건 충족도별" hint="화면에 뜨는 상위 후보 포함" segments={byMiss} />
        <SegmentTable title="장세별" segments={byRegime} />
        <SegmentTable title="시장별" segments={byMarket} />
        <SegmentTable title="섹터별" hint="상위·하위" segments={bySector.slice(0, 8)} />
      </div>
    </Section>
  )
}

async function HistoryContent() {
  await connection()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const [krTrades, usTrades, krPerf, usPerf, krRegimes, usRegimes] = await Promise.all([
    getScorecardTrades('KR'),
    getScorecardTrades('US'),
    getScreenedStockPerformance('KR', 30),
    getScreenedStockPerformance('US', 30),
    getRegimesInRange('KR', cutoffStr),
    getRegimesInRange('US', cutoffStr),
  ])

  const allTrades = [...krTrades, ...usTrades]

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <ScorecardVerdict card={summarize(krTrades)} title="한국 시장" />
        <ScorecardVerdict card={summarize(usTrades)} title="미국 시장" />
      </div>

      <Segments trades={allTrades} />

      {krPerf.length > 0 && (
        <Section title="한국 — 최근 30일 추천 목록">
          <PerformanceTable items={krPerf} market="KR" regimes={krRegimes} />
        </Section>
      )}

      {usPerf.length > 0 && (
        <Section title="미국 — 최근 30일 추천 목록">
          <PerformanceTable items={usPerf} market="US" regimes={usRegimes} />
        </Section>
      )}

      {allTrades.length === 0 && krPerf.length === 0 && usPerf.length === 0 && (
        <p className="text-sm text-muted-foreground">아직 추천 이력이 없습니다.</p>
      )}
    </>
  )
}

export default function HistoryPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">스크리너 성적</h1>
        <p className="text-sm text-muted-foreground">
          홈 화면에 뜬 종목을 그대로 샀다면 어땠을지를 봅니다. 9개 조건을 전부 채우는 날은
          드물어서 상위 후보(미달 1~2개)까지 함께 집계하고, 조건 충족도별로 성적을 갈라
          보여줍니다. 추천일 종가에 사서 목표가에 팔거나 손절가에 걸리는 것으로 가정하고,
          {MAX_HOLD_BARS}거래일 안에 둘 다 안 걸리면 그날 종가로 정리한 것으로 칩니다.
        </p>
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <HistoryContent />
      </Suspense>
    </main>
  )
}
