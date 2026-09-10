import type { Market } from '@/lib/types'

/**
 * 분할매수 평단 계산 — "차수별로 얼마에 몇 주 샀나"를 넣으면 평단가·평가손익을 낸다.
 *
 * 포지션 관리 카드의 평단가는 지금까지 손으로 계산해 넣은 단일 숫자였다. 그런데 이
 * 카드의 존재 이유가 추가 매수(물타기)라, 살 때마다 사용자가 밖에서 평단을 다시
 * 계산해 와야 했다. 여기서 그 계산을 대신하고, 결과를 그대로 avg_cost에 저장한다.
 *
 * 순수 함수라 averageCost.test.ts로 검증한다.
 */

export type BuyLot = {
  /** 매수 단가 */
  price: number
  /** 매수 수량 */
  qty: number
}

export type AverageCostResult = {
  /** 총 보유 수량 */
  totalQty: number
  /** 총 매입금액 (단가×수량 합) */
  totalCost: number
  /** 평단가 = 총 매입금액 / 총 수량 */
  avgCost: number
  /** 현재가 기준 평가금액 */
  marketValue: number
  /** 매도 비용 차감 전 평가손익 */
  grossPnl: number
  grossPnlPct: number
  /** 지금 전량 매도한다고 볼 때 나가는 비용(거래세+수수료) */
  sellCost: number
  /** 매도 비용까지 뺀 평가손익 */
  netPnl: number
  netPnlPct: number
  /**
   * 비용까지 물고 본전이 되는 가격. 비용이 0이면 평단가와 같다.
   * 평단가만 넘으면 본전이라고 보면 실제로는 세금만큼 손해라 따로 낸다.
   */
  breakevenPrice: number
  /** 현재가에서 본전까지 몇 % 올라야 하는지 (이미 넘었으면 음수) */
  breakevenUpsidePct: number
}

/**
 * 매도 시 나가는 비용의 기본값(%).
 *
 * KR 0.165% = 증권거래세·농어촌특별세 0.15% + 증권사 수수료 약 0.015%.
 * US는 거래세가 없어 수수료만 잡았다(양도소득세는 연 단위 정산이라 여기서 안 센다).
 * 증권사·계좌마다 다르므로 화면에서 직접 고칠 수 있게 열어둔다.
 */
export const DEFAULT_SELL_COST_PCT: Record<Market, number> = { KR: 0.165, US: 0.07 }

function round(value: number, digits = 6): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

/** 값이 유효한 매수 행인지 — 화면에서 빈 행을 그대로 넘겨도 되게 여기서 거른다. */
export function isValidLot(lot: BuyLot): boolean {
  return Number.isFinite(lot.price) && lot.price > 0 && Number.isFinite(lot.qty) && lot.qty > 0
}

/**
 * @param lots 차수별 매수 내역 (유효하지 않은 행은 무시)
 * @param currentPrice 현재가
 * @param sellCostPct 매도 시 비용률(%). 0이면 비용을 안 뺀다.
 * @returns 유효한 매수 행이 하나도 없으면 null
 */
export function computeAverageCost(
  lots: BuyLot[],
  currentPrice: number,
  sellCostPct = 0,
): AverageCostResult | null {
  const valid = lots.filter(isValidLot)
  if (valid.length === 0) return null

  const totalQty = valid.reduce((sum, l) => sum + l.qty, 0)
  const totalCost = valid.reduce((sum, l) => sum + l.price * l.qty, 0)
  const avgCost = totalCost / totalQty

  const price = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 0
  const marketValue = price * totalQty
  const grossPnl = marketValue - totalCost

  const rate = Number.isFinite(sellCostPct) && sellCostPct > 0 ? sellCostPct / 100 : 0
  const sellCost = marketValue * rate
  const netPnl = grossPnl - sellCost

  // 매도금액에서 비용을 뺀 값이 매입금액과 같아지는 지점: p*q*(1-rate) = totalCost
  const breakevenPrice = rate < 1 ? avgCost / (1 - rate) : avgCost

  return {
    totalQty: round(totalQty),
    totalCost: round(totalCost, 2),
    avgCost: round(avgCost, 4),
    marketValue: round(marketValue, 2),
    grossPnl: round(grossPnl, 2),
    grossPnlPct: totalCost > 0 ? round((grossPnl / totalCost) * 100, 4) : 0,
    sellCost: round(sellCost, 2),
    netPnl: round(netPnl, 2),
    netPnlPct: totalCost > 0 ? round((netPnl / totalCost) * 100, 4) : 0,
    breakevenPrice: round(breakevenPrice, 4),
    breakevenUpsidePct: price > 0 ? round((breakevenPrice / price - 1) * 100, 4) : 0,
  }
}

export type AddBuySimulation = {
  /** 추가 매수 후 평단가 */
  newAvgCost: number
  /** 추가 매수 후 총 수량 */
  newTotalQty: number
  /** 평단가가 몇 % 내려가는지 (올라가면 양수) */
  avgCostChangePct: number
  /** 추가 매수에 드는 금액 */
  addCost: number
}

/**
 * 물타기 시뮬레이션 — "지금 가격에 N주 더 사면 평단이 얼마가 되나".
 *
 * 지지 신호가 몇 개 겹쳤는지를 보고 추가 매수를 고민하는 자리라, 그 옆에 바로
 * 있어야 의미가 있다. 실제로 사기 전에는 아무 것도 저장하지 않는다.
 */
export function simulateAddBuy(
  lots: BuyLot[],
  addPrice: number,
  addQty: number,
): AddBuySimulation | null {
  const base = computeAverageCost(lots, addPrice)
  if (!base) return null
  if (!isValidLot({ price: addPrice, qty: addQty })) return null

  const newTotalQty = base.totalQty + addQty
  const addCost = addPrice * addQty
  const newAvgCost = (base.totalCost + addCost) / newTotalQty

  return {
    newAvgCost: round(newAvgCost, 4),
    newTotalQty: round(newTotalQty),
    avgCostChangePct: round((newAvgCost / base.avgCost - 1) * 100, 4),
    addCost: round(addCost, 2),
  }
}
