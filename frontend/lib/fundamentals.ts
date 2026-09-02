import type { FundamentalsRow } from './types'
import { broadSector } from './sectorMap'

// "주가가 빠질 때 실적도 같이 빠졌는가" — 가치 함정과 밸류에이션 조정을 가르는
// 판정. 차트는 둘을 구분하지 못하므로, 점수와 별개로 이 신호를 함께 보여준다.
//
// 판정 기준은 당기순이익이 아니라 **영업이익**이다 — 친절한 주식책 + 한눈에 보는
// 실전 재무제표가 같은 지적을 한다: 당기순이익은 자산 매각 같은 일회성 항목을
// 포함해 "진짜 돈을 버는 능력"을 왜곡한다(한국전력 2015년 사례: 본사 부지를
// 10조 넘게 매각해 영업이익 11.3조인데 당기순이익 13.4조로 부풀었다가, 이듬해
// 7조원대로 곤두박질). 영업이익 데이터가 없는 종목(구 데이터, 수집 실패)만
// 당기순이익으로 대체한다.

export type EarningsVerdict =
  | 'loss' // 최신 회계연도 적자 (영업이익 기준, 데이터 없으면 당기순이익)
  | 'deteriorating' // 매출·영업이익이 뚜렷하게 감소
  | 'mixed' // 한쪽만 감소하거나 감소폭이 애매
  | 'resilient' // 실적은 유지·성장 (주가만 하락 = 밸류에이션 조정)
  | 'unknown' // 데이터 부족

/** 매출이 이만큼 넘게 줄면 감소로 본다 (%) */
const REVENUE_DROP = 20
/** 이익이 이만큼 넘게 줄면 감소로 본다 (%) — 이익은 매출보다 변동이 커 기준을 완화 */
const PROFIT_DROP = 30
/** 실적 유지로 인정하는 상한 (%) */
const REVENUE_FLAT = 5
const PROFIT_FLAT = 10
/** 당기순이익이 영업이익과 이만큼(비율) 넘게 벌어지면 일회성 손익 경보 (한눈에 보는 실전 재무제표 15장) */
const ONE_TIME_GAIN_THRESHOLD = 0.3

export interface EarningsAssessment {
  verdict: EarningsVerdict
  /** 매출 변화율 % (직전 회계연도 대비) */
  revenueChange: number | null
  /** 이익 변화율 % — 영업이익 기준(없으면 당기순이익으로 대체) */
  profitChange: number | null
  /** profitChange가 어느 항목에서 나왔는지. 배지 문구에 씀. */
  profitSource: 'operating' | 'net' | null
  /** 당기순이익이 영업이익과 크게 벌어져 일회성 손익 비중이 커 보이는지 */
  oneTimeGainFlag: boolean
  years: { latest: number | null; prior: number | null }
}

function pctChange(latest: number | null, prior: number | null): number | null {
  if (latest === null || prior === null || prior === 0) return null
  // 직전이 적자면 변화율이 부호가 뒤집혀 의미를 잃으므로 절댓값을 분모로 쓴다.
  return ((latest - prior) / Math.abs(prior)) * 100
}

function primaryProfit(row: FundamentalsRow): { latest: number | null; prior: number | null; source: 'operating' | 'net' | null } {
  if (row.operating_income_latest !== null && row.operating_income_prior !== null) {
    return { latest: row.operating_income_latest, prior: row.operating_income_prior, source: 'operating' }
  }
  if (row.net_income_latest !== null && row.net_income_prior !== null) {
    return { latest: row.net_income_latest, prior: row.net_income_prior, source: 'net' }
  }
  return { latest: null, prior: null, source: null }
}

function detectOneTimeGain(row: FundamentalsRow): boolean {
  const { operating_income_latest: op, net_income_latest: net } = row
  if (op === null || net === null || op === 0) return false
  return Math.abs(net - op) / Math.abs(op) > ONE_TIME_GAIN_THRESHOLD
}

export function assessEarnings(row: FundamentalsRow | null | undefined): EarningsAssessment {
  if (!row) {
    return {
      verdict: 'unknown', revenueChange: null, profitChange: null, profitSource: null,
      oneTimeGainFlag: false, years: { latest: null, prior: null },
    }
  }

  const revenueChange = pctChange(row.revenue_latest, row.revenue_prior)
  const profit = primaryProfit(row)
  const profitChange = pctChange(profit.latest, profit.prior)
  const oneTimeGainFlag = detectOneTimeGain(row)
  const years = { latest: row.fiscal_year_latest, prior: row.fiscal_year_prior }

  if (profit.latest !== null && profit.latest < 0) {
    return { verdict: 'loss', revenueChange, profitChange, profitSource: profit.source, oneTimeGainFlag, years }
  }
  if (revenueChange === null && profitChange === null) {
    return { verdict: 'unknown', revenueChange, profitChange, profitSource: profit.source, oneTimeGainFlag, years }
  }

  const revenueDown = revenueChange !== null && revenueChange <= -REVENUE_DROP
  const profitDown = profitChange !== null && profitChange <= -PROFIT_DROP
  if (revenueDown && profitDown) {
    return { verdict: 'deteriorating', revenueChange, profitChange, profitSource: profit.source, oneTimeGainFlag, years }
  }

  const revenueHeld = revenueChange === null || revenueChange >= -REVENUE_FLAT
  const profitHeld = profitChange === null || profitChange >= -PROFIT_FLAT
  if (revenueHeld && profitHeld) {
    return { verdict: 'resilient', revenueChange, profitChange, profitSource: profit.source, oneTimeGainFlag, years }
  }

  return { verdict: 'mixed', revenueChange, profitChange, profitSource: profit.source, oneTimeGainFlag, years }
}

export const EARNINGS_LABEL: Record<EarningsVerdict, string> = {
  loss: '🚨 적자 전환',
  deteriorating: '⚠️ 실적 동반 하락',
  mixed: '실적 혼조',
  resilient: '실적 유지 · 밸류에이션 조정',
  unknown: '실적 데이터 없음',
}

// 실적 판정은 등락(가격 방향)이 아니라 좋음/나쁨이라 등락 색과 구분한다.
// 나쁨은 destructive, 좋음은 브랜드 블루, 경고는 앰버(방향과 무관한 주의색)로 둔다.
export const EARNINGS_CLASS: Record<EarningsVerdict, string> = {
  loss: 'bg-destructive/10 text-destructive',
  deteriorating: 'bg-amber-100 text-amber-800',
  mixed: 'bg-muted text-muted-foreground',
  resilient: 'bg-accent text-accent-foreground',
  unknown: 'bg-muted text-muted-foreground/70',
}

export const EARNINGS_NOTE: Record<EarningsVerdict, string> = {
  loss: '최신 회계연도가 적자입니다. 차트가 바닥처럼 보여도 실적이 먼저 돌아서야 합니다.',
  deteriorating:
    '주가와 함께 매출·영업이익도 뚜렷하게 줄었습니다. 구조적 문제일 수 있어 가치 함정에 주의하세요.',
  mixed: '매출과 영업이익의 방향이 엇갈립니다. 원인을 직접 확인해 보세요.',
  resilient:
    '실적은 유지되는데 주가만 하락했습니다. 밸류에이션 조정에 가까워 재평가 여지가 있습니다.',
  unknown: '실적 데이터를 아직 받지 못했습니다. 판단에 참고하지 마세요.',
}

/** 이익 항목 이름 — profitSource에 따라 배지·수치 라벨에 그대로 쓴다. */
export const PROFIT_SOURCE_LABEL: Record<'operating' | 'net', string> = {
  operating: '영업이익',
  net: '순이익', // 영업이익 데이터가 없어 당기순이익으로 대체된 경우
}

export const ONE_TIME_GAIN_LABEL = '💡 일회성 손익 비중 큼'
export const ONE_TIME_GAIN_NOTE =
  '당기순이익이 영업이익과 크게 다릅니다. 자산 매각 등 일회성 항목이 실적을 부풀리거나 깎았을 수 있어, 위 판정은 영업이익 기준으로 봤습니다.'

// ── 재무건전성 ──────────────────────────────────────────────────────────
// 한눈에 보는 실전 재무제표: "단기적 관점에서 재무 건전성을 측정하는 가장 중요한
// 지표는 유동성이다." 유동비율(유동자산÷유동부채)엔 책이 준 구체적 기준(2.0 이상
// 양호, "일반 제조업체 기준")이 있어 verdict로 등급을 매긴다. 부채비율(부채총계÷
// 자본총계)은 책 자신이 "업종별로 완전히 다르다"고 경고한 지표라(예: GM 4.0,
// 마이크로소프트 0.0 둘 다 정상) verdict에 안 넣고 참고용 숫자로만 보여준다 —
// PER/PBR과 같은 취급이다.
//
// 유동비율도 사실 업종별 편차가 있다 — 책이 준 2.0/1.0은 "일반 제조업체 기준"일
// 뿐이라, 재고 회전이 빠른 소매업이나 현금을 쌓아두는 바이오·헬스케어에 그대로
// 적용하면 오판정이 난다(2026-09-02, 사용자 제안 + 웹 조사, 책 근거 아님 — 여러
// 재무비율 벤치마크 사이트 종합, 출처마다 수치가 갈려 신뢰도가 낮으므로 업종별로
// "가장 낮은(=통과하기 쉬운) 쪽" 기준을 채택해 과도한 오탐(가짜 취약 판정)을
// 줄이는 쪽으로 잡았다). 은행·금융업은 "짧게 빌려 길게 빌려주는" 사업 구조상
// 유동비율 개념 자체가 안 맞는다는 게 여러 출처의 공통된 지적이라, 업종 자체를
// 판정 대상에서 뺀다('not_applicable').
//
// KR(DART)은 매일, US(yfinance)는 21:00 KST 전용 워크플로(같은 30일 주기)로
// 채운다 — 아직 안 채워진 종목은 자연히 'unknown'으로 뜬다.

export type FinancialHealthVerdict = 'healthy' | 'weak' | 'fragile' | 'not_applicable' | 'unknown'

/** 유동비율 기준 기본값(제조업 등, 책 근거) */
const DEFAULT_CURRENT_RATIO_THRESHOLDS = { healthy: 2.0, fragile: 1.0 }

/**
 * 업종별 유동비율 기준(웹 조사 기반, 책 근거 아님 — CLAUDE.md broadSector() 12개
 * 대분류 중 데이터가 있는 것만). 출처마다 범위가 갈려 각 업종 범위의 가장 낮은
 * 쪽을 healthy 기준으로 잡았다(=관대하게, 오탐 최소화). fragile은 그 절반 안팎.
 * 목록에 없는 업종(기술·커뮤니케이션·필수소비재·부동산·에너지·기타)은
 * 신뢰할 만한 수치를 못 찾아 기본값을 그대로 쓴다.
 */
const SECTOR_CURRENT_RATIO_THRESHOLDS: Partial<Record<string, { healthy: number; fragile: number }>> = {
  헬스케어: { healthy: 3.0, fragile: 1.5 }, // 바이오 등 현금 보유가 많아 원래 높게 나옴
  임의소비재: { healthy: 1.0, fragile: 0.6 }, // 소매업 — 재고 회전이 빨라 원래 낮게 나옴
  유틸리티: { healthy: 1.0, fragile: 0.6 }, // 현금흐름이 안정적이라 낮아도 무리 없다는 시각
  산업재: { healthy: 1.2, fragile: 0.8 }, // 제조업 중에서도 재고·매출채권 회전이 빠른 편
  소재: { healthy: 1.5, fragile: 1.0 },
}

/** 유동비율 판정 자체가 무의미한 업종. 짧게 빌려 길게 빌려주는 구조라 "단기 지급 능력"이라는 전제가 안 맞는다. */
const CURRENT_RATIO_NOT_APPLICABLE_SECTORS = new Set(['금융'])

function currentRatioThresholds(sector: string | null | undefined) {
  const broad = broadSector(sector)
  return SECTOR_CURRENT_RATIO_THRESHOLDS[broad] ?? DEFAULT_CURRENT_RATIO_THRESHOLDS
}

export interface FinancialHealthAssessment {
  verdict: FinancialHealthVerdict
  /** 유동자산 ÷ 유동부채 */
  currentRatio: number | null
  /** 부채총계 ÷ 자본총계 — 업종별 편차가 커서 verdict에는 반영하지 않는 참고값 */
  debtToEquity: number | null
}

export function assessFinancialHealth(
  row: FundamentalsRow | null | undefined,
  sector?: string | null,
): FinancialHealthAssessment {
  if (!row) return { verdict: 'unknown', currentRatio: null, debtToEquity: null }

  const { current_assets, current_liabilities, total_liabilities, total_equity } = row
  const currentRatio =
    current_assets !== null && current_liabilities !== null && current_liabilities !== 0
      ? current_assets / current_liabilities
      : null
  const debtToEquity =
    total_liabilities !== null && total_equity !== null && total_equity !== 0
      ? total_liabilities / total_equity
      : null

  if (CURRENT_RATIO_NOT_APPLICABLE_SECTORS.has(broadSector(sector))) {
    return { verdict: 'not_applicable', currentRatio, debtToEquity }
  }
  if (currentRatio === null) return { verdict: 'unknown', currentRatio, debtToEquity }

  const { healthy, fragile } = currentRatioThresholds(sector)
  if (currentRatio >= healthy) return { verdict: 'healthy', currentRatio, debtToEquity }
  if (currentRatio >= fragile) return { verdict: 'weak', currentRatio, debtToEquity }
  return { verdict: 'fragile', currentRatio, debtToEquity }
}

export const FINANCIAL_HEALTH_LABEL: Record<FinancialHealthVerdict, string> = {
  healthy: '유동성 양호',
  weak: '유동성 보통',
  fragile: '⚠️ 유동성 취약',
  not_applicable: '업종 특성상 판단 곤란',
  unknown: '재무 데이터 없음',
}

export const FINANCIAL_HEALTH_CLASS: Record<FinancialHealthVerdict, string> = {
  healthy: 'bg-accent text-accent-foreground',
  weak: 'bg-muted text-muted-foreground',
  fragile: 'bg-destructive/10 text-destructive',
  not_applicable: 'bg-muted text-muted-foreground/70',
  unknown: 'bg-muted text-muted-foreground/70',
}

export const FINANCIAL_HEALTH_NOTE: Record<FinancialHealthVerdict, string> = {
  healthy: '유동자산이 유동부채 대비 업종 기준 이상입니다. 단기 지급 능력에 여유가 있습니다.',
  weak: '유동비율이 업종 기준의 취약선~양호선 사이입니다. 지급 책임은 가까스로 이행하는 수준이라 여유가 크지 않습니다.',
  fragile: '유동비율이 업종 기준의 취약선 아래입니다. 유동부채가 유동자산보다 많아 단기 지급 능력에 위험 신호가 있습니다.',
  not_applicable:
    '은행·금융업은 "짧게 빌려 길게 빌려주는" 사업 구조라 유동비율로 단기 지급 능력을 재는 게 애초에 안 맞습니다. 판단에 참고하지 마세요.',
  unknown: '유동자산·유동부채 데이터를 아직 받지 못했습니다. 판단에 참고하지 마세요.',
}
