// 부동산 동향 화면용 순수 함수 — realestate_monthly 원본 행을 화면이 쓰는 모양으로 가공한다.
import { formatKrwAmount } from './calculations'
import type { AreaBand, RealestateMonthlyRow } from './types'

// price_avg 등은 만원 단위라, formatKrwAmount(원 단위 전용)에 넘기려면 10,000을 곱해야
// 한다. 음수(역전세로 갭이 마이너스인 경우)는 formatKrwAmount가 억 단위로 안 접어서
// 부호를 떼어냈다 붙인다.
export function formatManwon(manwon: number | null): string {
  if (manwon == null) return '—'
  const sign = manwon < 0 ? '-' : ''
  // 부동산 가격은 억 단위 안에서도 지역별 격차가 커서(예: 8.3억 vs 8.9억),
  // 정수로 반올림하면 그 차이가 지워진다 — 소수 첫째자리까지 보여준다.
  return sign + formatKrwAmount(Math.abs(manwon) * 10000, 1)
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

/** ALL 구간만 골라 지역별 최신월 + 직전월 대비 매매가 변동률을 낸다 (지역 목록 화면).
 *
 * "최신월"은 **매매 거래가 실제로 있던 마지막 달**이다. 그냥 달력상 최신 행을 쓰면
 * 안 된다 — 실거래 신고 기한이 30일이라 이달 초에는 매매 신고가 아직 한 건도 안
 * 들어온 지역이 흔한데(전월세는 바로 들어와 행 자체는 생긴다), 그 행은 price_avg가
 * null이라 화면에 매매가·전월대비가 '—'로 뜨고 목록 맨 아래로 밀린다. 사용자 눈에는
 * 그 지역만 "업데이트가 안 된" 것으로 보인다(2026-09 서울 일부 구·광명시 사례).
 * 신고가 덜 찬 달을 건너뛰고 마지막으로 매매가 있던 달을 보여주는 편이 정확하다 —
 * 어느 달 기준인지는 표의 '기준월' 열에 그대로 나온다. */
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
    // 매매가 있던 달만 추린다. 한 달도 없으면(전월세만 수집된 지역) 그냥 최신 행을
    // 써서 지역 자체가 목록에서 사라지지는 않게 한다.
    const priced = sorted.filter((r) => r.price_avg != null)
    const ranked = priced.length > 0 ? priced : sorted
    const latest = ranked[ranked.length - 1]
    const prior = ranked.length > 1 ? ranked[ranked.length - 2] : null
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

// 지도 SVG(capital-sigungu.json)는 2018년 SGIS 경계를 그대로 쓰는데, 그 뒤 분구된
// 지역(부천 2024-01-01, 화성 2026-02-01)은 폴리곤이 옛 코드 하나 그대로인 반면
// 실거래는 새 코드 여러 개로 나뉘어 들어온다 — 그대로 두면 데이터가 있어도 옛 코드로
// 매칭이 안 돼 회색으로 보인다. 폴리곤을 다시 그리기 전까지는 새 코드들을 건수
// 가중 평균으로 합쳐 옛 폴리곤 자리에 칠한다.
//
// 인천(2026-07-01 개편)은 **서구만 넣었다.** 2026-10-27에 새 코드 4개가 어느 구인지
// 확정됐지만(법정동 이름으로 확인, pipeline/src/lawd_codes.py 주석 참고) 그렇다고
// 네 개를 다 합칠 수 있는 건 아니다 — 이 방식이 성립하려면 **옛 폴리곤 하나가 새
// 코드들의 합집합**이어야 한다.
//
//   서구(28260) → 서해구(28275) + 검단구(28290): 성립한다. 옛 서구 땅이 그대로
//     둘로 갈렸고 밖으로 나간 땅도 들어온 땅도 없다. 그래서 넣었다.
//   중구(28110) · 동구(28140) → 제물포구(28125) + 영종구(28155): **성립하지 않는다.**
//     제물포구가 옛 중구 내륙과 옛 동구에 걸쳐 있어서, 어느 옛 폴리곤에 칠하든
//     한 구의 값을 두 군데에 중복으로 칠하거나(제물포) 섬과 내륙을 한 숫자로
//     뭉개게 된다(중구=영종+제물포). 이 둘은 폴리곤을 다시 그려야 제대로 된다 —
//     그때까지 회색으로 두는 편이 틀린 색을 칠하는 것보다 낫다.
export const SPLIT_REGION_CHILDREN: Record<string, string[]> = {
  '41190': ['41192', '41194', '41196'], // 부천시 → 원미·소사·오정구
  '41590': ['41591', '41593', '41595', '41597'], // 화성시 → 만세·효행·병점·동탄구
  '28260': ['28275', '28290'], // 인천 서구 → 서해구·검단구
}

/** region_code → 최신 매매 평균가. 분구된 옛 코드는 SPLIT_REGION_CHILDREN의 새 코드들을
 * 건수 가중 평균으로 합쳐 채운다(지도가 옛 폴리곤 하나로 계속 그리기 때문). */
export function mapPriceByCode(regions: RegionTrend[]): Map<string, number> {
  const byCode = new Map(regions.map((r) => [r.region_code, r.latest]))
  const result = new Map<string, number>()
  for (const r of regions) {
    if (r.latest.price_avg != null) result.set(r.region_code, r.latest.price_avg)
  }
  for (const [legacyCode, children] of Object.entries(SPLIT_REGION_CHILDREN)) {
    let weightedSum = 0
    let totalCount = 0
    for (const code of children) {
      const latest = byCode.get(code)
      if (latest?.price_avg == null) continue
      const count = latest.deal_count ?? 0
      totalCount += count
      weightedSum += latest.price_avg * count
    }
    if (totalCount > 0) result.set(legacyCode, weightedSum / totalCount)
  }
  return result
}

export function priceMapColor(price: number, min: number, max: number): string {
  const t = max > min ? Math.min(1, Math.max(0, (price - min) / (max - min))) : 0.5
  const lightness = PRICE_SCALE_L_MAX - t * (PRICE_SCALE_L_MAX - PRICE_SCALE_L_MIN)
  return `hsl(${PRICE_SCALE_HUE} ${PRICE_SCALE_SATURATION}% ${lightness}%)`
}
