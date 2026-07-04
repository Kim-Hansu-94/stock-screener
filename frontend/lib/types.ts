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
}

export interface DailyReportResponse {
  generatedAt: string
  results: DailyReportResult[]
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
