/**
 * 눌림목 스크리너 조건 관련 상수. pipeline/src/screener.py의 CRITERION_* 및
 * pipeline/src/pipeline.py의 MARKET_BEAR_CRITERION과 동기 유지.
 */

/** 종목 단위 조건 개수 (screener.py의 CRITERION_* 10개) */
export const STOCK_CRITERIA_COUNT = 10

/**
 * 시장 단위 미달 조건. 하락장인 날은 pipeline.py가 이걸 모든 후보의
 * failed_criteria에 붙이므로, 그날은 전 종목이 passed=false가 된다.
 * 즉 "미달 개수"를 셀 때 이건 빼야 종목 자체의 완성도를 볼 수 있다.
 */
export const MARKET_BEAR_CRITERION = '시장 하락장'

/** 종목 자체가 못 맞춘 조건 수 (시장 단위 조건 제외) */
export function stockMissCount(failedCriteria: string[]): number {
  return failedCriteria.filter((c) => c !== MARKET_BEAR_CRITERION).length
}
