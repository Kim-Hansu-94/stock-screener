// 부동산 동향 화면용 순수 함수 — realestate_monthly 원본 행을 화면이 쓰는 모양으로 가공한다.
import type { AreaBand, RealestateMonthlyRow } from './types'

const GROUP_BY_PREFIX: Record<string, string> = { '11': '서울', '28': '인천', '41': '경기' }

/** 법정동코드 앞 2자리로 시/도를 가른다 (지역 목록을 묶어 보여줄 때 씀). */
export function regionGroup(regionCode: string): string {
  return GROUP_BY_PREFIX[regionCode.slice(0, 2)] ?? '기타'
}

export interface RegionTrend {
  region_code: string
  region_name: string
  latest: RealestateMonthlyRow
  /** 직전 데이터가 있던 달. 거래가 뜸한 지역은 latest 바로 전달이 아닐 수 있다. */
  prior: RealestateMonthlyRow | null
  momPricePct: number | null
}

/** ALL 구간만 골라 지역별 최신월 + 직전월 대비 매매가 변동률을 낸다 (지역 목록 화면). */
export function regionOverview(rows: RealestateMonthlyRow[]): RegionTrend[] {
  const byRegion = new Map<string, RealestateMonthlyRow[]>()
  for (const row of rows) {
    if (row.area_band !== 'ALL') continue
    const list = byRegion.get(row.region_code)
    if (list) list.push(row)
    else byRegion.set(row.region_code, [row])
  }

  const result: RegionTrend[] = []
  for (const list of byRegion.values()) {
    const sorted = [...list].sort((a, b) => a.month.localeCompare(b.month))
    const latest = sorted[sorted.length - 1]
    const prior = sorted.length > 1 ? sorted[sorted.length - 2] : null
    result.push({
      region_code: latest.region_code,
      region_name: latest.region_name,
      latest,
      prior,
      momPricePct: momPct(latest.price_avg, prior?.price_avg),
    })
  }
  return result.sort((a, b) => a.region_name.localeCompare(b.region_name, 'ko'))
}

/** 한 지역의 전체 구간 행만 추린다 (상세 화면 진입점). */
export function regionRows(rows: RealestateMonthlyRow[], regionCode: string): RealestateMonthlyRow[] {
  return rows.filter((r) => r.region_code === regionCode)
}

export interface DetailMonthRow extends RealestateMonthlyRow {
  momPricePct: number | null
}

/** 한 구간(band)의 월별 행에 직전월 대비 매매가 변동률을 붙여 최신순으로 정렬한다. */
export function withMomChange(bandRows: RealestateMonthlyRow[]): DetailMonthRow[] {
  const ascending = [...bandRows].sort((a, b) => a.month.localeCompare(b.month))
  const withMom = ascending.map((row, i) => ({
    ...row,
    momPricePct: momPct(row.price_avg, i > 0 ? ascending[i - 1].price_avg : undefined),
  }))
  return withMom.sort((a, b) => b.month.localeCompare(a.month))
}

function momPct(latest: number | null, prior: number | null | undefined): number | null {
  if (latest == null || prior == null || prior === 0) return null
  return ((latest - prior) / prior) * 100
}

export const AREA_BANDS: AreaBand[] = ['ALL', '~60', '60~85', '85~135', '135~']

export const AREA_BAND_LABEL: Record<AreaBand, string> = {
  ALL: '전체',
  '~60': '~60㎡',
  '60~85': '60~85㎡',
  '85~135': '85~135㎡',
  '135~': '135㎡~',
}
