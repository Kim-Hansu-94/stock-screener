import Link from 'next/link'
import { changeTextClass, formatSignedPercent } from '@/lib/marketColors'
import { AREA_BAND_LABEL, formatManwon, regionGroup, type DetailMonthRow, type RegionTrend } from '@/lib/realestateTrend'
import type { AreaBand } from '@/lib/types'

const GROUP_ORDER = ['서울', '인천', '경기', '기타']

export function RealestateOverviewTable({ regions }: { regions: RegionTrend[] }) {
  if (regions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        아직 수집된 데이터가 없습니다. 부동산 수집 파이프라인 실행 후 채워집니다.
      </p>
    )
  }

  const grouped = new Map<string, RegionTrend[]>()
  for (const r of regions) {
    const g = regionGroup(r.region_code)
    const list = grouped.get(g)
    if (list) list.push(r)
    else grouped.set(g, [r])
  }

  return (
    <div className="space-y-6">
      {GROUP_ORDER.filter((g) => grouped.has(g)).map((group) => (
        <div key={group}>
          <p className="mb-2 text-sm font-medium text-muted-foreground">{group}</p>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted text-xs text-muted-foreground">
                  <th className="px-2 py-1.5 text-left font-medium">지역</th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">매매 평균가</th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">전월 대비</th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">매매 건수</th>
                  <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">기준월</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {grouped.get(group)!.map((r) => (
                  <tr key={r.region_code} className="hover:bg-muted/50">
                    <td className="px-2 py-1.5">
                      <Link
                        href={`/realestate?region=${r.region_code}`}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {r.region_name}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">{formatManwon(r.latest.price_avg)}</td>
                    <td className={`px-2 py-1.5 text-right font-mono text-xs ${changeTextClass(r.momPricePct)}`}>
                      {r.momPricePct != null ? formatSignedPercent(r.momPricePct, 1) : '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {r.latest.deal_count ?? 0}건
                    </td>
                    <td className="px-2 py-1.5 text-right text-xs whitespace-nowrap text-muted-foreground">
                      {r.latest.month.slice(0, 7)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  )
}

function MonthTable({ rows }: { rows: DetailMonthRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">이 구간은 거래가 없습니다.</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-2 py-1.5 text-left font-medium whitespace-nowrap">월</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">매매 평균가</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">전월 대비</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">㎡당 단가</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">전세 평균</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">갭</th>
            <th className="px-2 py-1.5 text-right font-medium whitespace-nowrap">매매 건수</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => (
            <tr key={row.month} className="hover:bg-muted/50">
              <td className="px-2 py-1.5 whitespace-nowrap text-muted-foreground">{row.month.slice(0, 7)}</td>
              <td className="px-2 py-1.5 text-right font-mono">{formatManwon(row.price_avg)}</td>
              <td className={`px-2 py-1.5 text-right font-mono text-xs ${changeTextClass(row.momPricePct)}`}>
                {row.momPricePct != null ? formatSignedPercent(row.momPricePct, 1) : '—'}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                {row.price_per_area_avg != null
                  ? `${Math.round(row.price_per_area_avg).toLocaleString('ko-KR')}만원/㎡`
                  : '—'}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                {formatManwon(row.deposit_avg)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                {formatManwon(row.gap_avg)}
              </td>
              <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                {row.deal_count ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RealestateDetailTable({
  regionName,
  byBand,
}: {
  regionName: string
  byBand: Record<AreaBand, DetailMonthRow[]>
}) {
  const allRows = byBand.ALL ?? []
  const otherBands = (Object.keys(byBand) as AreaBand[]).filter((b) => b !== 'ALL' && byBand[b].length > 0)

  return (
    <div className="space-y-4">
      <div>
        <Link href="/realestate" className="text-xs text-muted-foreground hover:text-foreground">
          ← 지역 목록
        </Link>
        <h3 className="mt-1 text-base font-bold text-foreground">{regionName}</h3>
      </div>
      {allRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">이 지역은 아직 수집된 거래가 없습니다.</p>
      ) : (
        <>
          <MonthTable rows={allRows} />
          {otherBands.length > 0 && (
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                전용면적 구간별 보기
              </summary>
              <div className="mt-3 space-y-4">
                {otherBands.map((band) => (
                  <div key={band}>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">{AREA_BAND_LABEL[band]}</p>
                    <MonthTable rows={byBand[band]} />
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}
