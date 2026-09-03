export type Market = 'KR' | 'US'
export type Regime = 'bull' | 'bear'

export interface MarketRegimeRow {
  date: string
  market: Market
  regime: Regime
}

export interface LeadingSectorRow {
  date: string
  market: Market
  sector: string
  rank: number
}

export interface ScreenedStockRow {
  date: string
  market: Market
  ticker: string
  name: string
  name_kr?: string
  sector: string
  close: number
  market_cap: number
  rsi: number
  /** 전 조건 통과 여부 — false면 미달 조건이 가장 적은 근접 후보(참고용) */
  passed: boolean
  /** 미달 조건 라벨 목록 (예: '거래량 미감소', '시장 하락장') */
  failed_criteria: string[]
}

export interface PriceHistoryRow {
  ticker: string
  market: Market
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface UniverseStockRow {
  ticker: string
  market: Market
  name: string
  name_kr?: string
  sector: string | null
  index_membership: string | null
  updated_at: string
}

/** 시가총액 조회 결과 (KR: 원, US: 달러). 컬럼 미배포·미수집이면 값이 없다. */
export type MarketCapMap = Record<string, number>

/** 파이프라인이 미리 계산한 횡보·조정 후보 — pipeline/src/opportunities.py */
export interface OpportunitySnapshotRow {
  ticker: string
  market: Market
  computed_at: string
  name: string | null
  name_kr: string | null
  sector: string | null
  index_membership: string | null
  current_close: number
  high3y: number
  drawdown: number
  score: number
  days_since_low: number | null
  vcp: boolean | null
  higher_lows: boolean | null
  volume_dry: boolean | null
  aligned_mas: boolean | null
  volume_trigger: boolean | null
  as_of_date: string | null
}

/** 사이트 진입 팝업(DailyAlertPopup)용 — /api/alerts 응답 */
export interface AlertStock {
  ticker: string
  market: Market
  name: string
  nameKr: string | null
}

export interface OpportunityAlertStock extends AlertStock {
  score: number
}

/** 실적 요약 — pipeline/src/fundamentals.py가 30일 주기로 갱신 */
export interface FundamentalsRow {
  ticker: string
  market: Market
  updated_at: string
  fiscal_year_latest: number | null
  fiscal_year_prior: number | null
  revenue_latest: number | null
  revenue_prior: number | null
  operating_income_latest: number | null
  operating_income_prior: number | null
  net_income_latest: number | null
  net_income_prior: number | null
  eps_latest: number | null
  eps_prior: number | null
  per: number | null
  pbr: number | null
  /** 재무건전성 — 2026-09-02 기준 KR만 채워진다(US는 당분간 null). 당기 스냅샷만 저장 */
  current_assets: number | null
  current_liabilities: number | null
  total_liabilities: number | null
  total_equity: number | null
}

/** 감시 종목(보유 종목) 상태 — pipeline/src/watchlist.py가 매 실행마다 갱신 */
export interface WatchlistStatusRow {
  ticker: string
  market: Market
  name: string | null
  date: string
  qualified: boolean
  reason: string | null
  drawdown: number | null
  in_drawdown_band: boolean | null
  no_new_low: boolean | null
  box_ok: boolean | null
  score: number | null
  days_since_low: number | null
  vcp: boolean | null
  higher_lows: boolean | null
  volume_dry: boolean | null
  aligned_mas: boolean | null
  volume_trigger: boolean | null
}

export interface SimilarStockResult {
  ticker: string
  name: string
  sector: string | null
  similarity: number
  history: PriceHistoryRow[]
}

export interface SimilarSearchResponse {
  detectedFrom: string
  detectedTo: string
  results: SimilarStockResult[]
}

export interface OpportunityStockRow {
  ticker: string
  name: string
  name_kr?: string
  sector: string | null
  index_membership: string | null
  market: Market
  currentClose: number
  high3y: number
  drawdown: number
  history: PriceHistoryRow[]
  /** 매수 매력도 0~1 (하드 필터 통과 종목만 리스트에 남는다) */
  score: number
  daysSinceLow: number
  vcp: boolean
  higherLows: boolean
  volumeDry: boolean
  alignedMAs: boolean
  volumeTrigger: boolean
  /** 이 카드 계산에 쓰인 최신 일봉 날짜 (YYYY-MM-DD) — 실시간 계산이라 종목마다 다를 수 있다 */
  asOfDate: string | null
  /** 시가총액 (KR: 원, US: 달러). 미수집이면 null. */
  marketCap: number | null
  /** 장기(10년) 고점. 3년 창 밖의 진짜 최고점 — 미시드면 null */
  longTermHigh: number | null
  /** 장기 고점 대비 하락률 % */
  longTermDrawdown: number | null
  /** 3년 고점이 장기 고점보다 크게 낮음 = 여러 해에 걸친 하락 */
  longTermDeclining: boolean
  /** 장기 데이터가 실제로 확보됐는지 (false면 장기 수치를 신뢰하면 안 됨) */
  hasLongHistory: boolean
  /** 실적 요약 — 미수집이면 null */
  fundamentals: FundamentalsRow | null
}

export interface DailyReportResult {
  ticker: string
  name: string
  name_kr?: string | null
  sector: string | null
  similarity: number
  matchedStandard: string        // e.g. "Gold Standard 바닥 특성"
  matchedStandardTicker: string | null
  matchedBottom: string          // e.g. "하락률 67% · 저점 유지 28일 · 거래량 +45%"
  volumeTriggered: boolean
  history: PriceHistoryRow[]
  /** 시가총액 (달러). 조회 실패 시 null. */
  marketCap: number | null
}

export interface DailyReportResponse {
  generatedAt: string
  results: DailyReportResult[]
  /** 시총 원화 환산용 환율 */
  usdKrwRate: number
}

export interface NewsArticle {
  title: string
  publisher: string
  url: string
  publishedAt: string
}

export interface DayReturn {
  date: string
  close: number
  returnPct: number
}

export interface ScreenedStockWithRisk {
  date: string
  market: Market
  ticker: string
  name: string
  name_kr?: string
  sector: string
  entryPrice: number
  rsi: number
  stop: number | null
  target: number | null
  riskReward: number | null
  history: PriceHistoryRow[]
}

export interface ScreenedStockPerf {
  date: string
  market: Market
  ticker: string
  name: string
  name_kr?: string
  sector: string
  entryPrice: number
  day1: DayReturn | null
  day2: DayReturn | null
  day3: DayReturn | null
  stop: number | null
  target: number | null
  riskReward: number | null
}

/** realestate_monthly 한 행 — 시군구 × 월 × 전용면적 구간. 금액은 전부 만원 단위. */
export type AreaBand = 'ALL' | '~60' | '60~85' | '85~135' | '135~'

export interface RealestateMonthlyRow {
  region_code: string
  region_name: string
  month: string // 그달 1일 (예: '2026-07-01')
  area_band: AreaBand
  deal_count: number | null
  price_avg: number | null
  price_median: number | null
  price_per_area_avg: number | null
  jeonse_count: number | null
  deposit_avg: number | null
  deposit_median: number | null
  monthly_rent_count: number | null
  jeonse_ratio: number | null
  gap_avg: number | null
}

/** realestate_media 한 행 — 부동산 뉴스·유튜브 링크(홈 상단). 날짜별 이력 없이
 * 매일 통째로 갈아끼우는 "오늘의 스냅샷"이다. */
export interface RealestateMediaRow {
  media_type: 'news' | 'video'
  title: string
  url: string
  source: string | null
  thumbnail_url: string | null
  published_at: string | null
}



