export type Market = 'KR' | 'US'
export type Regime = 'bull' | 'bear'

export interface MarketRegimeRow {
  date: string
  market: Market
  regime: Regime
}

/** 홈 화면 시황 위젯(코스피·코스닥·다우존스·나스닥·S&P500) — 지수당 최신 1행뿐인 스냅샷 */
export interface MarketIndexSnapshotRow {
  index_name: string
  date: string
  close: number
  prev_close: number
  updated_at: string
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
  /** 하드필터 통과 상태를 이어서 계속 만족 중인 구간의 시작일 (미통과 시 행 자체가 없음) */
  qualified_since: string | null
  /** 박스 상단 돌파(상승 전환)가 이어서 계속 유지 중인 구간의 시작일. 미충족 시 null */
  breakout_since: string | null
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

/** 오늘 새로 하드필터를 통과하기 시작한 관찰 대상 — 아직 매수 등급(적극검토/매수검토)에
 * 못 미쳐도 "막 바닥을 다지기 시작했다"는 것만으로 미리 알려주기 위한 항목. */
export interface NewEntryAlertStock extends AlertStock {
  score: number
  qualifiedSince: string
}

/** 횡보를 멈추고 박스 상단을 돌파(상승 전환)하기 시작한 종목 — "저점 대비 몇 배 오른
 * 뒤"가 아니라 오르기 시작하는 그 시점 자체를 알려주기 위한 항목. */
export interface TurnSignalAlertStock extends AlertStock {
  score: number
  breakoutSince: string
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

/** 사이트에서 직접 추가한 감시 종목 원본(/api/watchlist) — watchlist_status와 합쳐
 *  "추가했지만 아직 파이프라인이 평가 전"인 종목도 카드에 보여주는 데 쓴다. */
/**
 * 감시 목적 — 같은 감시 목록이지만 재는 질문이 다르다.
 * `accumulation`: 아직 안 산 종목. "조용히 매집 구간에 들어왔는가"(박스 수축 등)를 본다.
 * `position`: 이미 보유 중인 종목. "지금 지지선 근처인가"(supportSignals.ts)를 본다.
 * 값이 없는 기존 행은 accumulation으로 취급한다(컬럼 추가 이전에 넣은 종목).
 */
export type WatchlistCategory = 'accumulation' | 'position'

export interface WatchlistTickerRow {
  market: Market
  ticker: string
  name: string
  added_at: string
  category: WatchlistCategory | null
  /** 평단가 — category가 'position'일 때만 쓴다. */
  avg_cost: number | null
}

/** 감시 종목(보유 종목) 상태 — pipeline/src/watchlist.py가 매 실행마다 갱신 */
export interface WatchlistStatusRow {
  ticker: string
  market: Market
  name: string | null
  date: string
  qualified: boolean
  /** 조건을 계속 충족 중인 매집 구간이 시작된 날짜. 미통과 시 null. */
  qualified_since: string | null
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
  /** 이평 정배열이 이어서 계속 유지 중인 구간의 시작일. 미충족 시 null. */
  aligned_since: string | null
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
  /** 하드필터를 이어서 계속 통과 중인 구간의 시작일 — "며칠째 후보인지" 표시용 */
  qualifiedSince: string | null
  /** 박스 상단 돌파가 이어서 계속 유지 중인 구간의 시작일 — "며칠째 상승 전환 상태인지" 표시용 */
  breakoutSince: string | null
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




/** investor_flow 한 행 — 국내 종목의 일별 외국인·기관 순매매.
 *
 * `*_qty`는 **수량(주)**, `*_amount`는 그 수량 × 종가다. 네이버가 주는 원본이
 * 수량이라 그대로 두고, 금액은 "몇 억 규모인가"를 가늠하려고 파생시킨 값이다. */
export interface InvestorFlowRow {
  market: Market
  ticker: string
  name: string | null
  date: string
  close: number
  foreign_net_qty: number | null
  institution_net_qty: number | null
  foreign_net_amount: number | null
  institution_net_amount: number | null
  source: string | null
}

/** stock_consensus 한 행 — 증권사 목표주가 컨센서스 (종목당 최신 1행). */
export interface ConsensusRow {
  market: Market
  ticker: string
  name: string | null
  date: string
  target_price: number
  /** 저장 시점 종가 대비 상승여력(%). 화면은 최신 종가로 다시 계산할 수도 있다. */
  upside_pct: number | null
  opinion: string | null
  report_count: number | null
  consensus_eps: number | null
  source: string | null
}

/** stock_buyback 한 행 — 자사주 매입(또는 처분) 현황 (종목당 최신 1행).
 *
 * 진행률이 둘인 것이 의도적이다: `amount_progress_pct`는 취득 **금액** 기준의
 * 진짜 진행률이고, `period_progress_pct`는 금액을 모를 때 쓰는 **기간** 기준
 * 근사치다. 화면은 금액이 있으면 그걸 쓰고, 없으면 기간 기준임을 라벨로 밝힌다. */
export interface BuybackRow {
  market: Market
  ticker: string
  name: string | null
  latest_report: string | null
  latest_report_date: string | null
  latest_report_url: string | null
  is_disposal: boolean
  planned_amount: number | null
  acquired_amount: number | null
  amount_progress_pct: number | null
  period_progress_pct: number | null
  period_start: string | null
  period_end: string | null
  disclosure_count: number | null
}
