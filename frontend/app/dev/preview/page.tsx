import { notFound } from 'next/navigation'
import { DailyAlertPreview } from './DailyAlertPreview'
import { CriteriaLegend } from '@/app/discover/DailyReport'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { holdHint } from '@/lib/holdHint'
import { ScorecardVerdict, SegmentTable } from '@/components/Scorecard'
import { PatternScorecardVerdict, PatternSegmentTable } from '@/components/PatternScorecard'
import { PaperTradeTable, PaperTradeSummary } from '@/components/PaperTradeTable'
import { WatchlistCard } from '@/components/WatchlistCard'
import { PositionCard } from '@/components/PositionCard'
import { StockCard } from '@/components/StockCard'
import { RealestateOverviewTable, RealestateDetailTable } from '@/components/RealestateTables'
import { RealestateMap } from '@/components/RealestateMap'
import { RealestateMediaSection } from '@/components/RealestateMediaSection'
import { MarketOverviewWidget } from '@/components/MarketOverviewWidget'
import { EtfWatchCard } from '@/components/EtfWatchCard'
import {
  PROXY_TICKERS,
  type ProxyBasketAssessment,
  type ProxyTicker,
  type StageResult,
  type StopSignal,
  type TrancheStep,
} from '@/lib/etfEntryCheck'
import type { PaperPosition } from '@/lib/queries/trades'
import type { Scorecard, Segment } from '@/lib/scorecard'
import type { PatternScorecard, PatternSegment } from '@/lib/patternScorecard'
import { AREA_BANDS, regionOverview, withMomChange, type DetailMonthRow } from '@/lib/realestateTrend'
import { calculateChangePercent } from '@/lib/calculations'
import { computeStopTarget } from '@/lib/risk'
import type { AreaBand, PriceHistoryRow, RealestateMediaRow, RealestateMonthlyRow, ScreenedStockRow, WatchlistStatusRow, WatchlistTickerRow } from '@/lib/types'

/**
 * 픽스처로 화면을 그려보는 개발용 미리보기.
 *
 * 이 저장소는 DB 자격증명 없이 작업하는 경우가 있어(작업용 컨테이너·CI) 실제
 * 데이터로 화면을 못 띄운다. 그러면 UI 변경을 눈으로 확인할 방법이 빌드 성공
 * 여부밖에 없는데, 그건 "레이아웃이 깨졌는지 / 색이 맞는지"를 전혀 안 잡는다.
 * 여기에 대표적인 상태를 손으로 채워 두면 DB 없이도 렌더 결과를 볼 수 있다.
 *
 * 새 컴포넌트를 만들면 여기에 케이스를 추가할 것 — 특히 "값이 없을 때"와
 * "부호가 반대일 때"는 실제 데이터로는 좀처럼 안 나와서 놓치기 쉽다.
 */
function card(over: Partial<Scorecard>): Scorecard {
  return {
    resolved: 47, pending: 12, targetHits: 18, stops: 26, timeouts: 3,
    expectancyR: 0.34, totalR: 15.98, hitRate: 18 / 47,
    breakevenHitRate: 1 / 3, avgHoldingDays: 23,
    ...over,
  }
}

const BY_MISS: Segment[] = [
  { key: '0', label: '전 조건 통과', card: card({ expectancyR: 0.61, resolved: 11 }) },
  { key: '1', label: '1개 미달', card: card({ expectancyR: 0.24, resolved: 38 }) },
  { key: '2', label: '2개 미달', card: card({ expectancyR: -0.05, resolved: 52 }) },
  { key: '3', label: '3개 이상 미달', card: card({ expectancyR: -0.31, resolved: 40 }) },
]

const SEGMENTS: Segment[] = [
  { key: 'bull', label: '상승장', card: card({ expectancyR: 0.52, resolved: 28 }) },
  { key: 'bear', label: '하락장', card: card({ expectancyR: -0.11, resolved: 19 }) },
]

const SECTORS: Segment[] = [
  { key: 'semi', label: '반도체', card: card({ expectancyR: 0.71, resolved: 9 }) },
  { key: 'fin', label: '금융', card: card({ expectancyR: 0.08, resolved: 12 }) },
  { key: 'bio', label: '제약·바이오', card: card({ expectancyR: -0.43, resolved: 7 }) },
]

// 저점 매집 후보 성적 — 분포가 쏠린 상태(평균은 플러스, 중간값은 마이너스)가
// 이 탭의 흔한 모습이라 반드시 미리 보고 문구를 확인해야 한다.
function patternCard(over: Partial<PatternScorecard>): PatternScorecard {
  return {
    settled: 63, pending: 21, winRate: 0.44, avgReturnPct: 7.8, medianReturnPct: 2.1,
    bigWinRate: 0.17, bigLossRate: 0.13, avgMaxGainPct: 34.2, avgMaxDropPct: -21.6,
    skewed: false,
    ...over,
  }
}

const PATTERN_BY_DAYS: PatternSegment[] = [
  { key: '1', label: '15~29일', card: patternCard({ avgReturnPct: 14.2, settled: 22 }) },
  { key: '2', label: '30~44일', card: patternCard({ avgReturnPct: 6.1, settled: 18 }) },
  { key: '3', label: '45~59일', card: patternCard({ avgReturnPct: -2.4, settled: 13 }) },
  { key: '4', label: '60일 이상', card: patternCard({ avgReturnPct: -11.7, settled: 10 }) },
]

const PATTERN_BY_VCP: PatternSegment[] = [
  { key: 'y', label: 'VCP 충족', card: patternCard({ avgReturnPct: 12.5, settled: 29 }) },
  { key: 'n', label: 'VCP 미충족', card: patternCard({ avgReturnPct: 3.1, settled: 34 }) },
]

function pos(id: string, over: Partial<PaperPosition>): PaperPosition {
  return {
    id, market: 'KR', ticker: '005930', name: '삼성전자', sector: 'Semiconductors',
    source: 'pullback', entry_date: '2026-06-02', entry_price: 70000,
    exit_date: null, exit_price: null,
    currentPrice: 77000, currentDate: '2026-08-18', returnPct: 10,
    peakDrawdownPct: -3.2, holdingDays: 54, isOpen: true,
    exitSignal: null, signalReturnPct: null,
    ...over,
  }
}

const OPEN_POSITIONS: PaperPosition[] = [
  pos('open-1', {}),
  pos('open-2', { ticker: 'MU', market: 'US', name: '마이크론', source: 'opportunity',
    entry_price: 120, currentPrice: 104.4, returnPct: -13, peakDrawdownPct: -18.7, holdingDays: 12,
    exitSignal: { date: '2026-08-04', price: 111.6, reasons: ['breakdown'] },
    signalReturnPct: -7 }),
  pos('open-3', { ticker: '035720', name: '카카오', entry_price: 50000, currentPrice: 46000,
    returnPct: -8, peakDrawdownPct: -12.1, holdingDays: 30,
    exitSignal: { date: '2026-07-21', price: 45000, reasons: ['stop'] },
    signalReturnPct: -10 }),
  pos('open-4', { ticker: '373220', name: 'LG에너지솔루션', entry_price: 400000,
    currentPrice: 388000, returnPct: -3, peakDrawdownPct: -6.4, holdingDays: 8,
    exitSignal: { date: '2026-08-12', price: 392000, reasons: ['distribution', 'trend'] },
    signalReturnPct: -2 }),
]

const CLOSED_POSITIONS: PaperPosition[] = [
  pos('closed-1', { ticker: '000660', name: 'SK하이닉스', entry_price: 180000, currentPrice: 214200,
    returnPct: 19, exit_date: '2026-08-10', exit_price: 214200,
    peakDrawdownPct: null, isOpen: false, holdingDays: 41,
    exitSignal: { date: '2026-07-15', price: 196200, reasons: ['sector'] }, signalReturnPct: 9 }),
  pos('closed-2', { ticker: 'DLTR', market: 'US', name: '달러트리', source: 'opportunity',
    entry_price: 95, currentPrice: 88.35, returnPct: -7, exit_date: '2026-07-28', exit_price: 88.35,
    peakDrawdownPct: null, isOpen: false, holdingDays: 22,
    exitSignal: { date: '2026-07-02', price: 91.2, reasons: ['breakdown'] }, signalReturnPct: -4 }),
]

function watch(over: Partial<WatchlistStatusRow>): WatchlistStatusRow {
  return {
    ticker: '000660', market: 'KR', name: 'SK하이닉스', date: '2026-08-19',
    qualified: true, qualified_since: '2026-08-01', reason: null, drawdown: -34, in_drawdown_band: true,
    no_new_low: true, box_ok: true, score: 0.72, days_since_low: 18,
    vcp: true, higher_lows: true, volume_dry: true, aligned_mas: true, volume_trigger: false,
    aligned_since: '2026-08-15',
    ...over,
  }
}

// 감시 종목 카드는 뉴스를 상시로 붙여 두므로, 로딩/빈 목록도 여기서 눈으로 볼 것.
// 사이트에서 추가한 종목(watchlist_tickers) 3개 중 IONQ만 아직 평가 전(status 없음),
// 005380은 status만 있고 tickers엔 없는 경우(코드에 박힌 기본 종목 → 삭제 버튼 없음)를
// 함께 둬서 세 갈래(통과/미달/평가대기)와 삭제 가능 여부를 한 화면에서 확인한다.
// SK하이닉스는 매집 구간 19일째(길게 이어짐), 현대차는 오늘 막 진입(1일째)로
// qualified_since 표시가 둘 다 자연스러운지 함께 본다.
const WATCHLIST: WatchlistStatusRow[] = [
  watch({}),
  watch({ ticker: '005930', name: '삼성전자', qualified: false, qualified_since: null, score: null,
    reason: '60일 박스폭 30% 초과', box_ok: false, higher_lows: null, vcp: null, volume_dry: null,
    aligned_mas: null, aligned_since: null }),
  // 매집 구간은 오늘 막 시작됐지만 정배열은 아직 — "상승 전환 감지" 배지가 안 뜨는
  // 경우도 함께 확인한다.
  watch({ ticker: '005380', market: 'KR', name: '현대차', qualified_since: '2026-08-19',
    aligned_mas: false, aligned_since: null }),
]

const WATCHLIST_TICKERS: WatchlistTickerRow[] = [
  { market: 'KR', ticker: '000660', name: 'SK하이닉스', added_at: '2026-07-01T00:00:00Z',
    category: 'accumulation', avg_cost: null },
  { market: 'KR', ticker: '005930', name: '삼성전자', added_at: '2026-08-10T00:00:00Z',
    category: 'accumulation', avg_cost: null },
  // category가 null인 행(컬럼 추가 이전에 넣은 종목)도 매집 감시로 취급되는지 함께 본다.
  { market: 'US', ticker: 'IONQ', name: '아이온큐', added_at: '2026-08-19T00:00:00Z',
    category: null, avg_cost: null },
]

// 포지션 관리 카드용 — (1) 평단가가 있고 손실 중, (2) 평단가가 있고 수익 중(부호
// 반대), (3) 평단가를 안 넣은 경우, (4) 시세가 아직 없는 경우를 모두 둔다.
// 손익률 색(한국 관례: 상승 빨강/하락 파랑)이 양쪽 다 맞는지 여기서 확인할 것.
// 평단가는 픽스처 일봉의 가격대(수십~수백)에 맞춰 둔다 — 실제 평단(216만원)을
// 그대로 넣으면 손익률이 -100%로 찍혀 표시 확인에 도움이 안 된다.
const POSITION_TICKERS: WatchlistTickerRow[] = [
  { market: 'KR', ticker: '000660', name: 'SK하이닉스', added_at: '2026-07-01T00:00:00Z',
    category: 'position', avg_cost: 103 },
  { market: 'KR', ticker: '005380', name: '현대차', added_at: '2026-07-05T00:00:00Z',
    category: 'position', avg_cost: 100 },
  { market: 'KR', ticker: '005930', name: '삼성전자', added_at: '2026-08-10T00:00:00Z',
    category: 'position', avg_cost: null },
  { market: 'US', ticker: 'IONQ', name: '아이온큐', added_at: '2026-08-19T00:00:00Z',
    category: 'position', avg_cost: 40 },
]

// SK하이닉스·현대차는 차트가 있는 경우, 삼성전자·아이온큐는 없는 경우(데이터
// 부족)를 함께 둬서 "차트를 그릴 시세 데이터가 아직 없습니다" 폴백도 확인한다.
const WATCHLIST_HISTORY: Record<string, PriceHistoryRow[]> = {
  'KR-000660': watchlistChartHistory('000660'),
  // 005380은 일부러 짧은 픽스처(108봉)를 써서, 120일선·일목구름도가 데이터
  // 부족으로 부분적으로만(또는 전혀) 안 그려지는 경우도 깨지지 않는지 함께 본다.
  'KR-005380': resistanceTargetHistory('005380'),
}

// 손익비 카드용 일봉 픽스처 — lib/risk.test.ts의 두 시나리오를 그대로 재현한다.
// (1) 얕은 눌림목이라 위에 의미 있는 저항이 없어 고정 2R로 떨어지는 경우
//     ('신고가 코앞 2R 기본값' 테스트와 동일한 모양 — 손익비 2.00 뭉침의 실제 원인)
// (2) 급등 후 진짜 저항이 남아 있어 그 가격이 목표가 되는 경우 (대조군)
function historyFrom(ticker: string, points: { close: number; high: number; low: number }[]): PriceHistoryRow[] {
  const startDate = new Date('2026-01-05')
  return points.map(({ close, high, low }, i) => {
    const date = new Date(startDate)
    date.setDate(startDate.getDate() + i)
    return { ticker, market: 'KR' as const, date: date.toISOString().slice(0, 10), open: close, high, low, close, volume: 500_000 }
  })
}

function default2rHistory(ticker: string): PriceHistoryRow[] {
  const points: { close: number; high: number; low: number }[] = []
  let close = 100
  for (let i = 0; i < 70; i++) {
    close += 1
    points.push({ close, high: close + 0.5, low: close - 0.5 })
  }
  const peak = close
  for (let i = 1; i <= 3; i++) {
    const c = peak - i * 0.5
    points.push({ close: c, high: c + 0.5, low: c - 0.5 })
  }
  return historyFrom(ticker, points)
}

// 감시 종목 차트의 120일선·일목구름도(52봉 필요)가 실제로 그려지는 걸 보려면
// 최소 150봉 이상 필요하다 — 위 두 픽스처(70~108봉)로는 부족해서 따로 만들었다.
// 고점 → 40% 하락 → 등락하며 다지는 흐름으로, 매집 구간 컨셉과도 얼추 맞는 모양.
function watchlistChartHistory(ticker: string): PriceHistoryRow[] {
  const points: { close: number; high: number; low: number }[] = []
  let close = 100
  for (let i = 0; i < 40; i++) {
    close += 0.8
    points.push({ close, high: close + 1, low: close - 1 })
  }
  const peak = close
  for (let i = 1; i <= 60; i++) {
    close = peak - peak * 0.4 * (i / 60)
    points.push({ close, high: close + 1.5, low: close - 1.5 })
  }
  for (let i = 0; i < 100; i++) {
    close += Math.sin(i / 4) * 1.2
    points.push({ close, high: close + 0.8, low: close - 0.8 })
  }
  return historyFrom(ticker, points)
}

function resistanceTargetHistory(ticker: string): PriceHistoryRow[] {
  const points: { close: number; high: number; low: number }[] = []
  for (let i = 0; i < 60; i++) points.push({ close: 100, high: 101, low: 99 })
  for (let i = 0; i < 40; i++) {
    const c = 100 + (i + 1) * 1.25
    points.push({ close: c, high: c + 0.5, low: c - 0.5 })
  }
  for (let i = 0; i < 8; i++) {
    const c = 150 - (i + 1) * 1.25
    points.push({ close: c, high: c + 0.5, low: c - 0.5 })
  }
  return historyFrom(ticker, points)
}

function volatileHistory(ticker: string): PriceHistoryRow[] {
  // 온투이노베이션 2026-08-26 사례 재현: 60봉 조용한 우상향 뒤 변동성이 극심해져
  // ATR 기반 손절이 진입가에서 15% 넘게 멀어진다 — stop_too_far로 계산을 포기해야
  // 정상이다(값이 없는 상태가 에러처럼 안 보이게 하는 게 핵심이라 이 케이스를 둔다).
  const points: { close: number; high: number; low: number }[] = []
  let close = 100
  for (let i = 0; i < 60; i++) {
    close += 1
    points.push({ close, high: close + 0.5, low: close - 0.5 })
  }
  for (let i = 0; i < 20; i++) {
    points.push({ close: 200, high: 200 * 1.15, low: 200 * 0.85 })
  }
  return historyFrom(ticker, points)
}

function screened(over: Partial<ScreenedStockRow>): ScreenedStockRow {
  return {
    date: '2026-08-19', market: 'KR', ticker: '000000', name: 'Sample', name_kr: '샘플종목',
    sector: 'IT', close: 100, market_cap: 500_000_000_000, rsi: 52, passed: true, failed_criteria: [],
    ...over,
  }
}

const DEFAULT_2R_HISTORY = default2rHistory('DEFAULT2R')
const RESISTANCE_HISTORY = resistanceTargetHistory('RESIST')
const VOLATILE_HISTORY = volatileHistory('VOLATILE')

const STOCK_CARDS: { stock: ScreenedStockRow; history: PriceHistoryRow[]; label: string }[] = [
  {
    label: '위 저항 없음 → 2R 기본값 (손익비 2.00 뭉침의 실제 원인)',
    stock: screened({ ticker: 'DEFAULT2R', name: '샘플(신고가 코앞)', close: DEFAULT_2R_HISTORY.at(-1)!.close }),
    history: DEFAULT_2R_HISTORY,
  },
  {
    label: '위에 실제 저항 있음 → 그 가격이 목표가 (대조군)',
    stock: screened({ ticker: 'RESIST', name: '샘플(저항 존재)', close: RESISTANCE_HISTORY.at(-1)!.close }),
    history: RESISTANCE_HISTORY,
  },
  {
    label: '변동성 과다 → 손절 산출 포기 (stop_too_far, 온투이노베이션 사례)',
    stock: screened({ ticker: 'VOLATILE', name: '샘플(변동성 과다)', close: VOLATILE_HISTORY.at(-1)!.close }),
    history: VOLATILE_HISTORY,
  },
]

function reRow(over: Partial<RealestateMonthlyRow>): RealestateMonthlyRow {
  return {
    region_code: '11680', region_name: '서울 강남구', month: '2026-06-01', area_band: 'ALL',
    deal_count: 42, price_avg: 250000, price_median: 245000, price_per_area_avg: 2900,
    jeonse_count: 15, deposit_avg: 130000, deposit_median: 128000, monthly_rent_count: 3,
    jeonse_ratio: 0.52, gap_avg: 120000,
    ...over,
  }
}

// 상승·하락·표본 부족(직전달 없음)·미수집(빈 지역)을 한 화면에서 함께 본다 —
// 실제 데이터로는 이 조합이 좀처럼 안 나온다.
//
// 화성시는 일부러 옛 코드(41590)가 아니라 분구된 새 코드 2개(41591/41593)로 넣는다 —
// 지도 SVG 폴리곤은 옛 코드 하나뿐이라, mapPriceByCode의 병합이 없으면 이 케이스가
// 회색으로 빠지는 걸 여기서 바로 확인할 수 있다.
const RE_OVERVIEW_ROWS: RealestateMonthlyRow[] = [
  reRow({ month: '2026-05-01', price_avg: 240000 }),
  reRow({ month: '2026-06-01', price_avg: 250000 }), // 강남 +4.2%
  reRow({ region_code: '28185', region_name: '인천 연수구', month: '2026-05-01', price_avg: 90000 }),
  reRow({ region_code: '28185', region_name: '인천 연수구', month: '2026-06-01', price_avg: 82000 }), // 연수 -8.9%
  reRow({ region_code: '41591', region_name: '화성 만세구', month: '2026-06-01', price_avg: 55000, deal_count: 20 }),
  reRow({ region_code: '41593', region_name: '화성 효행구', month: '2026-06-01', price_avg: 65000, deal_count: 10 }),
]

const RE_DETAIL_BAND_ROWS: RealestateMonthlyRow[] = [
  reRow({ area_band: 'ALL', month: '2026-04-01', price_avg: 235000, deal_count: 30 }),
  reRow({ area_band: 'ALL', month: '2026-05-01', price_avg: 240000, deal_count: 38 }),
  reRow({ area_band: 'ALL', month: '2026-06-01', price_avg: 250000, deal_count: 42 }),
  reRow({ area_band: '60~85', month: '2026-05-01', price_avg: 220000, deal_count: 20 }),
  reRow({ area_band: '60~85', month: '2026-06-01', price_avg: 228000, deal_count: 24 }),
]

const RE_MEDIA_ROWS: RealestateMediaRow[] = [
  {
    media_type: 'news',
    title: '서울 아파트값 상승세 둔화… 거래량은 여전히 활발',
    url: 'https://example.com/news/1',
    source: 'hankyung.com',
    thumbnail_url: null,
    published_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    media_type: 'news',
    title: '전세가율 60% 넘어선 수도권 단지 늘어',
    url: 'https://example.com/news/2',
    source: 'mk.co.kr',
    thumbnail_url: null,
    published_at: new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString(),
  },
  {
    media_type: 'video',
    title: '지금 부동산 시장, 이렇게 흘러갑니다',
    url: 'https://example.com/video/1',
    source: '부동산 채널',
    thumbnail_url: 'https://placehold.co/320x180?text=Video',
    published_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
  },
]

// ── 490590 매수체크 픽스처 ────────────────────────────────────────────────
// 카드가 받는 건 원본 일봉이 아니라 계산 결과라(EtfWatchCard 참고), 여기서도
// 합성 일봉 대신 결과 객체를 바로 손으로 채운다.
function etfStage(stage: 'A' | 'B' | 'C', reasons: string[], over: Partial<StageResult['detail']> = {}): StageResult {
  return {
    stage,
    label: stage === 'A' ? '하락 중' : stage === 'C' ? '상승 전환' : '하락 멈춤 (관찰)',
    reasons,
    detail: {
      close: 100, date: '2026-09-12', sma20: 98, aboveSma20: stage === 'C', sma20Rising: stage === 'C',
      brokeRecentHigh: stage === 'C', higherLow: stage === 'C', volumeUp: stage === 'C',
      lowerHighsAndLows: stage === 'A', freshLow: stage === 'A',
      ...over,
    },
  }
}

function proxyBasket(stages: Record<ProxyTicker, 'A' | 'B' | 'C'>): ProxyBasketAssessment {
  const perTicker = {} as Record<ProxyTicker, StageResult | null>
  for (const t of PROXY_TICKERS) {
    perTicker[t] = etfStage(
      stages[t],
      stages[t] === 'A'
        ? ['최근 3구간 고점·저점이 계속 낮아짐']
        : stages[t] === 'C'
          ? ['20일선 위로 회복', '직전 단기 고점 돌파', '거래량이 평소보다 증가']
          : ['하락 추세는 멈췄지만 상승 전환 조건은 5개 중 1개만 충족 (3개 이상 필요)'],
    )
  }
  const cStageCount = Object.values(stages).filter((s) => s === 'C').length
  const trafficLight = cStageCount <= 1 ? '🔴' : cStageCount === 2 ? '🟠' : cStageCount === 3 ? '🟡' : cStageCount === 4 ? '🟢' : '🟢🟢'
  const trafficLabel =
    cStageCount <= 1 ? '매수 보류 — 대장주 대부분이 아직 하락·관찰 단계'
    : cStageCount === 2 ? '관찰 — 상승 전환 조짐이 늘고 있음'
    : cStageCount === 3 ? '1차 매수 검토 가능'
    : cStageCount === 4 ? '적극적 분할매수 검토 가능'
    : '강한 상승 확인 — 대장주 전부 상승 전환'
  return { perTicker, cStageCount, evaluatedCount: 5, trafficLight, trafficLabel }
}

function trancheSteps(readyUpTo: 0 | 1 | 2 | 3 | 4): TrancheStep[] {
  const base: Omit<TrancheStep, 'autoReady'>[] = [
    { order: 1, amountManwon: 500, cumulativeManwon: 500, label: '1차', autoConditions: [
      { text: '구성종목 5개 중 2개 이상 상승 전환', met: readyUpTo >= 1 },
      { text: '490590이 저점을 방어 중 (하락 추세 아님)', met: readyUpTo >= 1 },
    ], manualConditions: ['FOMC 충격이 진정되는 모습인지 (아래 뉴스 참고)'] },
    { order: 2, amountManwon: 1500, cumulativeManwon: 2000, label: '2차', autoConditions: [
      { text: '구성종목 5개 중 3개 이상 상승 전환', met: readyUpTo >= 2 },
      { text: '490590 20일선 회복', met: readyUpTo >= 2 },
      { text: '490590 직전 단기 고점 돌파', met: readyUpTo >= 2 },
    ], manualConditions: [] },
    { order: 3, amountManwon: 1500, cumulativeManwon: 3500, label: '3차', autoConditions: [
      { text: 'AI 구성종목 대부분 상승 (5개 중 4개 이상)', met: readyUpTo >= 3 },
      { text: '490590이 추가로 고점을 높임', met: readyUpTo >= 3 },
    ], manualConditions: ['나스닥 추세가 안정적인지 (아래 뉴스 참고)'] },
    { order: 4, amountManwon: 1500, cumulativeManwon: 5000, label: '4차 — 무조건 넣을 필요 없음', autoConditions: [
      { text: '3차 조건이 흔들림 없이 계속 유지', met: readyUpTo >= 4 },
    ], manualConditions: ['조건이 확실하지 않으면 남은 돈은 투자하지 않는다'] },
  ]
  return base.map((s) => ({ ...s, autoReady: s.autoConditions.every((c) => c.met) }))
}

// 매수 중단 신호는 **상태에 따라 문장 자체가 바뀌므로**, 이상 없음/경고/확인 불가
// 세 가지를 한 화면에서 같이 봐야 문구가 어색하지 않은지 확인할 수 있다.
const STOP_SIGNALS_CALM: StopSignal[] = [
  { id: 'etfFreshLow', topic: '490590이 바닥을 지키고 있나', state: 'ok',
    headline: '490590이 최근 바닥을 잘 지키고 있습니다',
    detail: '최근 20거래일 중 가장 쌌던 가격 아래로는 안 내려갔습니다' },
  { id: 'proxyFreshLow', topic: '대장주들이 한꺼번에 무너지고 있나', state: 'ok',
    headline: '대장주가 한꺼번에 무너지는 모습은 아닙니다',
    detail: '최근 3거래일 안에 바닥을 깬 대장주 1개 (5개 중 3개 이상이면 경고)' },
  { id: 'yieldSpike', topic: '미국 금리가 갑자기 튀었나', state: 'ok',
    headline: '미국 국채 금리는 잠잠합니다',
    detail: '미국 10년물 국채 금리 어제 4.49% → 오늘 4.52% · 하루에 0.15%p 넘게 오르면 경고로 봅니다' },
  { id: 'allDownTogether', topic: 'AI 대장주 전체 분위기', state: 'ok',
    headline: 'AI 대장주가 다 같이 무너지지는 않았습니다',
    detail: '대장주 5개 중 1개가 하락 단계 (거의 전부면 경고)' },
]

// 경고 배너와 경고 배지가 실제로 뜨는지 보는 케이스. '확인 불가'도 하나 섞어
// 세 가지 상태가 한 화면에 같이 나오게 둔다.
const STOP_SIGNALS_TRIGGERED: StopSignal[] = [
  { id: 'etfFreshLow', topic: '490590이 바닥을 지키고 있나', state: 'alert',
    headline: '490590이 최근 바닥을 깨고 더 내려갔습니다',
    detail: '최근 20거래일 중 가장 쌌던 가격보다 더 싸게 거래됐습니다' },
  { id: 'proxyFreshLow', topic: '대장주들이 한꺼번에 무너지고 있나', state: 'alert',
    headline: '대장주 3개가 한꺼번에 바닥을 깼습니다',
    detail: '최근 3거래일 안에 바닥을 깬 대장주 3개 (5개 중 3개 이상이면 경고)' },
  { id: 'yieldSpike', topic: '미국 금리가 갑자기 튀었나', state: 'unknown',
    headline: '금리 데이터가 아직 없습니다',
    detail: '다음 자동 수집(하루 2번) 뒤부터 표시됩니다' },
  { id: 'allDownTogether', topic: 'AI 대장주 전체 분위기', state: 'ok',
    headline: 'AI 대장주가 다 같이 무너지지는 않았습니다',
    detail: '대장주 5개 중 2개가 하락 단계 (거의 전부면 경고)' },
]

function detailByBand(rows: RealestateMonthlyRow[]): Record<AreaBand, DetailMonthRow[]> {
  const byBand = {} as Record<AreaBand, DetailMonthRow[]>
  for (const band of AREA_BANDS) byBand[band] = withMomChange(rows.filter((r) => r.area_band === band))
  return byBand
}

export default function PreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound()

  // w-full: 부동산 상세의 넓은 표 때문에 <main>이 flex-stretch 대신 콘텐츠 폭으로 커지는
  // 문제가 있었다 — 실제 페이지(app/page.tsx, 부동산)와 같은 이유로 필요.
  return (
    <main className="mx-auto w-full max-w-4xl space-y-8 px-4 py-8">
      <h1 className="text-2xl font-bold text-foreground">컴포넌트 미리보기 (개발용)</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">사이트 진입 알림 팝업</h2>
        <DailyAlertPreview />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          저점 매집 후보 — 선정 기준 안내 (표가 있어 폰 폭에서 깨지기 쉽다)
        </h2>
        <CriteriaLegend />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          저점 매집 후보 카드 머리글 — 권장 관찰 기간 배지 (마지막 칸은 하락률 컬럼이 아직
          없을 때. 배지가 빠져도 줄이 안 깨져야 한다)
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            { name: '아주 긴 종목이름 주식회사', ticker: 'LONGNAME', dd: 58.4, score: 71, vol: true },
            { name: 'Mid Band Corp', ticker: 'MIDB', dd: 67.2, score: 64, vol: false },
            { name: 'Deep Drop Inc', ticker: 'DEEP', dd: 83.1, score: 88, vol: true },
            { name: '하락률 미기록', ticker: 'NODD', dd: null, score: 55, vol: false },
          ].map((f) => {
            const hint = holdHint(f.dd)
            return (
              <Card key={f.ticker} className={f.vol ? 'border-amber-300' : ''}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-base">
                    <span>
                      <span className="block">
                        {f.name}{' '}
                        <span className="text-sm font-normal text-muted-foreground">
                          ({f.ticker})
                        </span>
                      </span>
                    </span>
                    <div className="ml-2 flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                      {f.vol && <Badge className="bg-amber-500 text-white">⚡ 거래량</Badge>}
                      {hint && (
                        <Badge variant="outline" className={hint.className} title={hint.title}>
                          {hint.label}
                        </Badge>
                      )}
                      <Badge variant="secondary">{f.score}점</Badge>
                    </div>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {f.dd === null ? '하락률 —' : `52주 최고가 대비 ${f.dd.toFixed(1)}% 하락`}
                  </p>
                </CardHeader>
              </Card>
            )
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">성적 카드 — 상태별</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <ScorecardVerdict card={card({})} title="우위 있음 (본전선 위)" />
          <ScorecardVerdict
            card={card({ expectancyR: -0.28, targetHits: 9, stops: 35, hitRate: 9 / 47 })}
            title="우위 없음 (본전선 아래)"
          />
          <ScorecardVerdict
            card={card({ resolved: 8, pending: 30, expectancyR: 0.9, targetHits: 4, stops: 4, hitRate: 0.5 })}
            title="표본 부족"
          />
          <ScorecardVerdict card={card({ resolved: 0, pending: 5 })} title="판정 완료 0건" />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          저점 매집 후보 성적 카드 — 상태별
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <PatternScorecardVerdict card={patternCard({})} title="평균·중간값 같은 방향" />
          <PatternScorecardVerdict
            card={patternCard({ avgReturnPct: 9.4, medianReturnPct: -6.2, skewed: true, winRate: 0.33 })}
            title="쏠림 (소수가 평균을 끌어올림)"
          />
          <PatternScorecardVerdict
            card={patternCard({ avgReturnPct: -8.3, medianReturnPct: -11.0, winRate: 0.27 })}
            title="우위 없음"
          />
          <PatternScorecardVerdict
            card={patternCard({ settled: 11, pending: 40, avgReturnPct: 31.2, medianReturnPct: 18.0 })}
            title="표본 부족"
          />
          <PatternScorecardVerdict
            card={patternCard({ settled: 0, pending: 7 })}
            title="판정 완료 0건"
          />
        </div>
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">어떤 후보가 잘 맞았나</h2>
        <div className="space-y-5">
          <PatternSegmentTable
            title="저점 유지 기간별"
            hint="점수 가중치가 가장 큰 항목"
            segments={PATTERN_BY_DAYS}
          />
          <PatternSegmentTable title="VCP 충족 여부" segments={PATTERN_BY_VCP} />
          {/* 특성이 아직 기록되지 않은 상태 — 표가 통째로 사라지는 게 맞는지 확인용 */}
          <PatternSegmentTable title="하락률 구간별 (기록 없음)" segments={[]} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">매집 감시 카드 (뉴스는 실제 API 호출)</h2>
        <WatchlistCard rows={WATCHLIST} tickers={WATCHLIST_TICKERS} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          포지션 관리 카드 (손실/수익/평단가 없음/시세 없음 4가지)
        </h2>
        <PositionCard tickers={POSITION_TICKERS} history={WATCHLIST_HISTORY} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">포지션 관리 카드 (등록 종목 0개)</h2>
        <PositionCard tickers={[]} history={{}} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          눌림목 카드 — 손익비 목표가 근거 (뉴스·매수 버튼은 실제 API 호출)
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {STOCK_CARDS.map(({ stock, history, label }) => {
            const risk = computeStopTarget(history, stock.close)
            return (
              <div key={stock.ticker} className="flex flex-col gap-2">
                <p className="text-xs text-muted-foreground">{label}</p>
                <StockCard
                  stock={stock}
                  changePercent={calculateChangePercent(history.map((row) => row.close))}
                  market="KR"
                  usdKrwRate={1350}
                  stop={risk.stop}
                  target={risk.target}
                  riskReward={risk.riskReward}
                  riskReason={risk.reason}
                  riskFrame={risk.frame}
                  wayResistance={risk.wayResistance}
                  targetBasis={risk.targetBasis}
                />
              </div>
            )
          })}
        </div>
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">내 매매장 — 보유 중</h2>
        <PaperTradeTable items={OPEN_POSITIONS} showSell />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">내 매매장 — 청산 완료</h2>
        <PaperTradeSummary closed={CLOSED_POSITIONS} />
        <PaperTradeTable items={CLOSED_POSITIONS} showSell={false} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">시황 위젯 — 상승·하락 혼합</h2>
        <MarketOverviewWidget
          snapshots={[
            { index_name: '코스피', date: '2026-09-03', close: 2650.32, prev_close: 2610.5, updated_at: '2026-09-03T21:30:00Z' },
            { index_name: '코스닥', date: '2026-09-03', close: 780.11, prev_close: 795.4, updated_at: '2026-09-03T21:30:00Z' },
            { index_name: '다우존스', date: '2026-09-02', close: 41250.77, prev_close: 41100.2, updated_at: '2026-09-03T21:30:00Z' },
            { index_name: '나스닥', date: '2026-09-02', close: 17890.44, prev_close: 18010.9, updated_at: '2026-09-03T21:30:00Z' },
            { index_name: 'S&P500', date: '2026-09-02', close: 5620.15, prev_close: 5620.15, updated_at: '2026-09-03T21:30:00Z' },
          ]}
          usdKrwRate={1382.5}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          시황 위젯 — 미수집(섹션 자체가 숨겨져야 함)
        </h2>
        <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          {'<MarketOverviewWidget snapshots={[]} usdKrwRate={1382.5} />'} → null (아래에 카드가 안 보이면 정상)
        </div>
        <MarketOverviewWidget snapshots={[]} usdKrwRate={1382.5} />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">부동산 뉴스·영상 — 데이터 있음</h2>
        <RealestateMediaSection media={RE_MEDIA_ROWS} />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-semibold text-muted-foreground">부동산 뉴스·영상 — 미수집(섹션 자체가 숨겨져야 함)</h2>
        <div className="rounded-md border border-dashed border-border p-4 text-xs text-muted-foreground">
          {'<RealestateMediaSection media={[]} />'} → null (아래에 카드가 안 보이면 정상)
        </div>
        <RealestateMediaSection media={[]} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">부동산 동향 — 지역 목록 (상승·하락·표본 부족 혼합)</h2>
        <RealestateOverviewTable regions={regionOverview(RE_OVERVIEW_ROWS)} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">부동산 동향 — 지도 (일부 지역만 데이터 있음)</h2>
        <RealestateMap regions={regionOverview(RE_OVERVIEW_ROWS)} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">부동산 동향 — 지역 목록 (미수집)</h2>
        <RealestateOverviewTable regions={[]} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">부동산 동향 — 지역 상세 (구간별 펼치기 포함)</h2>
        <RealestateDetailTable regionName="서울 강남구" byBand={detailByBand(RE_DETAIL_BAND_ROWS)} />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">부동산 동향 — 지역 상세 (거래 없음)</h2>
        <RealestateDetailTable regionName="인천 옹진군" byBand={detailByBand([])} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          490590 매수체크 — 관찰 단계 (뉴스는 실제 API 호출)
        </h2>
        <EtfWatchCard
          proxyAssessment={proxyBasket({ ORCL: 'C', GOOGL: 'C', NVDA: 'B', AMD: 'A', MRVL: 'B' })}
          etfStage={etfStage('B', ['하락 추세는 멈췄지만', '상승 전환 조건은 5개 중 1개만 충족 (3개 이상 필요)'])}
          etfLatest={{ close: 9850, date: '2026-09-12' }}
          hasEtfData
          tranches={trancheSteps(1)}
          stopSignals={STOP_SIGNALS_CALM}
          tenYearYield={{ index_name: '미국10년물', date: '2026-09-12', close: 45.2, prev_close: 45.05, updated_at: '2026-09-12T21:30:00Z' }}
          nasdaq={{ index_name: '나스닥', date: '2026-09-12', close: 17890.44, prev_close: 18010.9, updated_at: '2026-09-12T21:30:00Z' }}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          490590 매수체크 — 매수 중단 신호 감지 (경고 배너가 떠야 정상)
        </h2>
        <EtfWatchCard
          proxyAssessment={proxyBasket({ ORCL: 'A', GOOGL: 'A', NVDA: 'A', AMD: 'B', MRVL: 'A' })}
          etfStage={etfStage('A', ['최근 3구간(각 20일) 고점이 계속 낮아짐', '최근 3구간 저점도 계속 낮아짐'])}
          etfLatest={{ close: 8420, date: '2026-09-12' }}
          hasEtfData
          tranches={trancheSteps(0)}
          stopSignals={STOP_SIGNALS_TRIGGERED}
          tenYearYield={{ index_name: '미국10년물', date: '2026-09-12', close: 46.8, prev_close: 45.1, updated_at: '2026-09-12T21:30:00Z' }}
          nasdaq={{ index_name: '나스닥', date: '2026-09-12', close: 17200.1, prev_close: 18010.9, updated_at: '2026-09-12T21:30:00Z' }}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          490590 매수체크 — 일봉 데이터 아직 없음 (감시 종목 추가 안내가 떠야 정상)
        </h2>
        <EtfWatchCard
          proxyAssessment={proxyBasket({ ORCL: 'B', GOOGL: 'B', NVDA: 'B', AMD: 'B', MRVL: 'B' })}
          etfStage={null}
          etfLatest={null}
          hasEtfData={false}
          tranches={trancheSteps(0)}
          stopSignals={STOP_SIGNALS_CALM}
          tenYearYield={null}
          nasdaq={null}
        />
      </section>

      <section className="space-y-4 rounded-xl bg-card p-5 shadow-[0_1px_2px_rgba(25,31,40,0.04),0_4px_16px_rgba(25,31,40,0.04)]">
        <h2 className="text-base font-semibold text-foreground">어떤 추천이 잘 맞았나</h2>
        <div className="space-y-5">
          <SegmentTable title="조건 충족도별" hint="화면에 뜨는 상위 후보 포함" segments={BY_MISS} />
          <SegmentTable title="장세별" segments={SEGMENTS} />
          <SegmentTable title="섹터별" hint="상위·하위" segments={SECTORS} />
        </div>
      </section>
    </main>
  )
}
