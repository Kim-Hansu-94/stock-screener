import { Suspense } from 'react'
import { connection } from 'next/server'
import { getExitSignals } from '@/lib/queries'
import { ExitSignalTable } from '@/components/ExitSignalTable'

async function PositionsContent() {
  await connection()

  const [krSignals, usSignals] = await Promise.all([
    getExitSignals('KR', 30),
    getExitSignals('US', 30),
  ])

  const hasData = krSignals.length > 0 || usSignals.length > 0

  return (
    <>
      {!hasData && (
        <p className="text-sm text-gray-400">최근 30일 내 추천 이력이 없습니다.</p>
      )}

      {krSignals.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">한국 시장</h2>
          <ExitSignalTable items={krSignals} market="KR" />
        </section>
      )}

      {usSignals.length > 0 && (
        <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-semibold text-gray-900">미국 시장</h2>
          <ExitSignalTable items={usSignals} market="US" />
        </section>
      )}
    </>
  )
}

export default function PositionsPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-gray-900">보유 종목 점검</h1>
        <p className="text-sm text-gray-500">
          최근 30일 추천 종목 중 아직 들고 있을 만한 종목을 점검하고, 매도 신호가 나온 종목을 알려줍니다.
        </p>
      </div>

      <Suspense fallback={<p className="py-16 text-center text-muted-foreground">로딩 중...</p>}>
        <PositionsContent />
      </Suspense>
    </main>
  )
}
