// 부동산 동향 화면용 순수 함수 — realestate_monthly 원본 행을 화면이 쓰는 모양으로 가공한다.
import { formatKrwAmount } from './calculations'
import type { AreaBand, RealestateMonthlyRow } from './types'

// price_avg 등은 만원 단위라, formatKrwAmount(원 단위 전용)에 넘기려면 10,000을 곱해야
// 한다. 음수(역전세로 갭이 마이너스인 경우)는 formatKrwAmount가 억 단위로 안 접어서
// 부호를 떼어냈다 붙인다.
export function formatManwon(manwon: number | null): string {
  if (manwon == null) return '—'
  const sign = manwon < 0 ? '-' : ''
  return sign + formatKrwAmount(Math.abs(manwon) * 10000)
}

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
  // 매매 평균가 내림차순. 가격이 없는 지역(매매 없이 전월세만 있는 달)은 맨 뒤로 뺀다.
  return result.sort((a, b) => (b.latest.price_avg ?? -1) - (a.latest.price_avg ?? -1))
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

// 매매 평균가 → 지도 색상. --primary(#3182F6, HSL 약 215° 92% 58%)와 같은 색상으로
// 밝기만 바꾼 단일 색상 연속 스케일이다(매매가는 값이 있으면 있는 대로 연속적인
// 크기 비교라, 여러 색을 섞는 구간형 대신 "하나의 색, 밝음→어두움"이 맞다).
// 값이 없는 지역(매매 없이 전월세만 있는 달)은 --border 회색으로 뺀다.
const PRICE_SCALE_HUE = 215
const PRICE_SCALE_SATURATION = 92
const PRICE_SCALE_L_MIN = 24 // 가장 비쌈 → 가장 진하게
const PRICE_SCALE_L_MAX = 90 // 가장 쌈 → 배경에 가깝게 연하게
export const PRICE_SCALE_NO_DATA = '#e5e8eb'

export function priceMapColor(price: number, min: number, max: number): string {
  const t = max > min ? Math.min(1, Math.max(0, (price - min) / (max - min))) : 0.5
  const lightness = PRICE_SCALE_L_MAX - t * (PRICE_SCALE_L_MAX - PRICE_SCALE_L_MIN)
  return `hsl(${PRICE_SCALE_HUE} ${PRICE_SCALE_SATURATION}% ${lightness}%)`
}
