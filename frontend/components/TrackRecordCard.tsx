import type { TrackRecord } from '@/lib/types'

function Stat({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string
  value: string
  sub?: string
  tone?: 'neutral' | 'positive' | 'negative'
}) {
  const valueColor =
    tone === 'positive' ? 'text-red-600' : tone === 'negative' ? 'text-blue-600' : 'text-gray-900'
  return (
    <div className="rounded-lg bg-gray-50 p-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold ${valueColor}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400">{sub}</p>}
    </div>
  )
}

export function TrackRecordCard({ record }: { record: TrackRecord }) {
  if (record.totalTrades === 0) {
    return (
      <div className="rounded-lg border border-gray-100 bg-gray-50 p-4 text-sm text-gray-400">
        최근 90일 내 집계할 트레이드 표본이 없습니다.
      </div>
    )
  }

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`
  const closedCount = Math.round((record.targetHitRate + record.stoppedOutRate) * record.totalTrades)
  const returnTone =
    record.avgReturnPct > 0 ? 'positive' : record.avgReturnPct < 0 ? 'negative' : 'neutral'

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-400">
        전체 {record.totalTrades}건 · 청산 {closedCount}건 (첫 추천일 매수 기준)
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="목표 도달률" value={pct(record.targetHitRate)} tone="positive" />
        <Stat label="손절률" value={pct(record.stoppedOutRate)} tone="negative" />
        <Stat label="미청산률" value={pct(record.openRate)} />
        <Stat
          label="평균 수익률"
          value={`${record.avgReturnPct >= 0 ? '+' : ''}${record.avgReturnPct.toFixed(2)}%`}
          sub="청산 기준"
          tone={returnTone}
        />
        <Stat label="평균 보유일" value={`${record.avgHoldingDays.toFixed(1)}일`} sub="청산 기준" />
        <Stat label="손익비 (R)" value={record.avgR.toFixed(2)} sub="청산 기준" />
      </div>
    </div>
  )
}
