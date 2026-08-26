import { Suspense } from 'react'
import { connection } from 'next/server'
import { LoadingFallback } from '@/components/LoadingFallback'
import { getPaperTrades } from '@/lib/queries/trades'
import { PaperTradeTable, PaperTradeSummary } from '@/components/PaperTradeTable'

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  )
}

async function PositionsContent() {
  await connection()

  const trades = await getPaperTrades()

  const open = trades.filter((t) => t.isOpen)
  const closed = trades.filter((t) => !t.isOpen)

  return (
    <>
      <Section title="내 매매장 — 보유 중">
        {open.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            아직 매수한 종목이 없습니다. 눌림목 종목이나 종목 발굴 화면에서 <b>매수</b> 버튼을 누르면
            그때부터 수익률을 추적합니다.
          </p>
        ) : (
          <>
            <PaperTradeTable items={open} showSell />
            <p className="text-xs text-muted-foreground">
              매수가·현재가는 모두 일봉 종가입니다. 사이트에 장중 가격이 없어 실제 체결가와는 다를 수
              있습니다. 수익률은 파이프라인이 도는 매일 갱신됩니다.
            </p>
          </>
        )}
      </Section>

      {closed.length > 0 && (
        <Section title="내 매매장 — 청산 완료">
          <PaperTradeSummary closed={closed} />
          <PaperTradeTable items={closed} showSell={false} />
        </Section>
      )}

    </>
  )
}

export default function PositionsPage() {
  return (
    <main className="mx-auto max-w-4xl space-y-5 px-4 py-8">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">보유 종목 점검</h1>
        <p className="text-sm text-muted-foreground">
          매수 버튼을 누른 종목의 수익률을 매일 추적하고, 매수 근거가 깨진 종목을 알려줍니다.
        </p>
      </div>

      <Suspense fallback={<LoadingFallback />}>
        <PositionsContent />
      </Suspense>
    </main>
  )
}
