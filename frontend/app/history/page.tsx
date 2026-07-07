import { Suspense } from 'react'
import { connection } from 'next/server'
import { getScreenedStockPerformance, getRegimesInRange, getScreenerTrackRecord } from '@/lib/queries'
import { PerformanceTable } from '@/components/PerformanceTable'
import { TrackRecordCard } from '@/components/TrackRecordCard'

async function HistoryContent() {
  await connection()

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const [krPerf, usPerf, krRegimes, usRegimes, krTrack, usTrack] = await Promise.all([
    getScreenedStockPerformance('KR', 30),
    getScreenedStockPerformance('US', 30),
    getRegimesInRange('KR', cutoffStr),
    getRegimesInRange('US', cutoffStr),
    getScreenerTrackRecord('KR', 90),
    getScreenerTrackRecord('US', 90),
  ])

  const hasData = krPerf.length > 0 || usPerf.length > 0

  return (
    <>
      <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">90일 종합 성적표</h2>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-500">한국 시장</p>
            <TrackRecordCard record={krTrack} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-gray-500">미국 시장</p>
            <TrackRecordCard record={usTrack} />
          </div>
        </div>
      </section>

      {!hasData && (
        <p className="text-sm text-gray-400">최근 30일 내 추천 이력이 없습니다.</p>
      )}

      {krPerf.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">한국 시장</h2>
          <PerformanceTable items={krPerf} market="KR" regimes={krRegimes} />
        </section>
      )}

      {usPerf.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">미국 시장</h2>
          <PerformanceTable items={usPerf} market="US" regimes={usRegimes} />
        </section>
      )}
    </>
  )
}

export default function HistoryPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">추천 이력 수익률</h1>
        <p className="text-sm text-gray-500">
          눌림목 스크리너 추천 종목을 매수했다면 +1일 · +2일 · +3일 수익률이 얼마였는지 보여줍니다.
        </p>
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <HistoryContent />
      </Suspense>
    </main>
  )
}
