import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import type { MarketIndexSnapshotRow } from '@/lib/types'

// DB 조회 순서와 무관하게 항상 이 순서로 보여준다(국내 → 해외 → 환율).
const INDEX_ORDER = ['코스피', '코스닥', '다우존스', '나스닥', 'S&P500']
const KR_INDEX_NAMES = new Set(['코스피', '코스닥'])
const US_INDEX_NAMES = new Set(['다우존스', '나스닥', 'S&P500'])

function formatIndexValue(close: number): string {
  return close.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatMonthDay(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// 전세계 시황을 한눈에 볼 수 있게 홈 화면 맨 위에 띄우는 위젯. 지수는 파이프라인이
// 매 실행 수집하는 스냅샷(market_index_snapshot), 환율은 프론트가 직접 받아오는
// 실시간 값(fetchUsdKrwRate)이라 갱신 주기가 서로 다르다는 점을 감안해 표기했다.
export function MarketOverviewWidget({
  snapshots,
  usdKrwRate,
}: {
  snapshots: MarketIndexSnapshotRow[]
  usdKrwRate: number
}) {
  const byName = new Map(snapshots.map((s) => [s.index_name, s]))
  const indices = INDEX_ORDER.map((name) => byName.get(name)).filter((s): s is MarketIndexSnapshotRow => !!s)

  if (indices.length === 0) {
    return null
  }

  // 국내(코스피·코스닥)와 해외(다우·나스닥·S&P500)는 장 마감 시각이 서로 달라
  // 스냅샷의 기준일(date)이 하루 어긋날 수 있다 — 실시간 시세가 아니라 "마감 기준"
  // 값임을 명확히 하려고 각각의 기준일을 따로 보여준다.
  const krDate = indices.find((s) => KR_INDEX_NAMES.has(s.index_name))?.date
  const usDate = indices.find((s) => US_INDEX_NAMES.has(s.index_name))?.date

  return (
    <section className="rounded-xl bg-card p-4 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
      <h2 className="mb-3 text-sm font-bold text-foreground">시황</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-6">
        {indices.map((snapshot) => {
          const changePct = ((snapshot.close - snapshot.prev_close) / snapshot.prev_close) * 100
          return (
            <div key={snapshot.index_name} className="rounded-lg bg-muted/50 p-2.5">
              <p className="text-xs text-muted-foreground">{snapshot.index_name}</p>
              <p className="mt-0.5 text-sm font-bold text-foreground">{formatIndexValue(snapshot.close)}</p>
              <p className={`text-xs font-semibold ${changeTextClass(changePct)}`}>
                {formatSignedPercent(changePct)}
              </p>
            </div>
          )
        })}
        <div className="rounded-lg bg-muted/50 p-2.5">
          <p className="text-xs text-muted-foreground">원/달러 환율</p>
          <p className="mt-0.5 text-sm font-bold text-foreground">
            {usdKrwRate.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
          </p>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {krDate && `국내 ${formatMonthDay(krDate)}`}
        {krDate && usDate && ' · '}
        {usDate && `해외 ${formatMonthDay(usDate)}(현지시간)`}
        {(krDate || usDate) && ' 장마감 기준 · '}
        실시간 시세가 아니라 하루 2번(장 마감 후) 갱신됩니다. 환율은 최대 1시간 이내 값입니다.
      </p>
    </section>
  )
}
