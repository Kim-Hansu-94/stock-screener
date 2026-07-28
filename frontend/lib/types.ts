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

export type ExitStatus = 'open' | 'stopped_out' | 'target_hit'

export interface ExitCheckResult {
  date: string
  market: Market
  ticker: string
  name: string
  name_kr?: string
  sector: string
  entryPrice: number
  currentPrice: number
  currentReturnPct: number
  stop: number | null
  target: number | null
  riskReward: number | null
  status: ExitStatus
  exitDate: string | null
  exitReasons: string[]
  recommendation: 'sell' | 'hold'
}

// Aggregate 90-day track record for the pullback screener: each recommendation walked
// forward to its stop/target resolution, deduped to the first day per ticker, then summarized.
export interface TrackRecord {
  market: Market
  totalTrades: number
  targetHitRate: number // 0~1, over all trades
  stoppedOutRate: number
  openRate: number
  avgReturnPct: number // closed trades only
  avgHoldingDays: number // closed trades only
  avgR: number // closed trades only
}
