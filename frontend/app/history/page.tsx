import { Suspense } from 'react'
import { connection } from 'next/server'
import { getScreenedStockPerformance } from '@/lib/queries'
import { PerformanceTable } from '@/components/PerformanceTable'

async function HistoryContent() {
  await connection()

  const [krPerf, usPerf] = await Promise.all([
    getScreenedStockPerformance('KR', 30),
    getScreenedStockPerformance('US', 30),
  ])

  const hasData = krPerf.length > 0 || usPerf.length > 0

  return (
    <>
      {!hasData && (
        <p className="text-sm text-gray-400">최근 30일 내 추천 이력이 없습니다.</p>
      )}

      {krPerf.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">한국 시장</h2>
          <PerformanceTable items={krPerf} market="KR" />
        </section>
      )}

      {usPerf.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">미국 시장</h2>
          <PerformanceTable items={usPerf} market="US" />
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
