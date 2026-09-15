// 매물대(가격대별 거래량, Volume Profile) 계산 — 순수 함수.
//
// "이 종목이 어느 가격대에서 많이 거래됐나"를 보는 지표다. 거래가 많았던 가격대는
// 그 가격에 물린(또는 이익 중인) 사람이 많다는 뜻이라, 위에 있으면 저항, 아래에 있으면
// 지지로 작용하는 경향이 있다. 국내 HTS에서 흔히 '매물대'라고 부른다.
//
// **거래량을 봉의 저가~고가에 고르게 흩뿌린다.** 일봉만으로는 하루 중 어느 가격에서
// 얼마나 체결됐는지 알 수 없어서(틱 데이터가 없다) 근사할 수밖에 없는데, 종가 한 점에
// 몰아주는 방식보다 구간에 나누는 쪽이 실제 체결 분포에 가깝다. 어차피 "대략 어디가
// 두꺼운가"를 보는 지표라 이 근사로 충분하다 — **정확한 체결가별 거래량이 아니다.**
import type { PriceHistoryRow } from './types'

/** 가격 구간 하나 */
export interface VolumeProfileBin {
  /** 구간 하단 가격 */
  low: number
  /** 구간 상단 가격 */
  high: number
  /** 이 가격대에서 거래된 것으로 추정한 거래량 */
  volume: number
}

export interface VolumeProfile {
  bins: VolumeProfileBin[]
  /** 거래량이 가장 두꺼운 구간의 가운데 가격 — 매물대의 중심(POC, Point of Control) */
  pocPrice: number
  /** 그 구간의 거래량 — 막대 길이를 0~1로 정규화할 때 쓴다 */
  maxVolume: number
  /** 전체 거래량 (POC가 전체의 몇 %인지 같은 설명에 쓴다) */
  totalVolume: number
}

/** 구간을 몇 칸으로 나눌지. 너무 잘게 나누면 들쭉날쭉해서 '두꺼운 곳'이 안 보인다. */
export const VOLUME_PROFILE_BINS = 24

/**
 * 일봉 배열 → 매물대.
 *
 * 다음 경우는 계산하지 않고 `null`을 돌려준다(화면은 매물대만 빼고 그대로 그린다):
 *  - 봉이 없거나
 *  - 가격이 전 구간 동일해서 나눌 구간이 없거나
 *  - 거래량 합이 0(거래량을 안 주는 데이터 소스)
 */
export function computeVolumeProfile(
  bars: PriceHistoryRow[],
  binCount: number = VOLUME_PROFILE_BINS,
): VolumeProfile | null {
  if (bars.length === 0 || binCount < 1) return null

  const minPrice = Math.min(...bars.map((b) => b.low))
  const maxPrice = Math.max(...bars.map((b) => b.high))
  if (!(maxPrice > minPrice)) return null

  const binSize = (maxPrice - minPrice) / binCount
  const volumes = new Array<number>(binCount).fill(0)

  for (const bar of bars) {
    if (!(bar.volume > 0)) continue
    const lo = Math.max(minPrice, Math.min(bar.low, bar.high))
    const hi = Math.min(maxPrice, Math.max(bar.low, bar.high))

    if (!(hi > lo)) {
      // 고가=저가(상·하한가 등)면 나눌 수 없으니 그 가격이 속한 칸에 통째로 넣는다.
      const idx = Math.min(binCount - 1, Math.max(0, Math.floor((lo - minPrice) / binSize)))
      volumes[idx] += bar.volume
      continue
    }

    // 봉이 걸친 칸마다 "겹친 길이 ÷ 봉 전체 길이"만큼 나눠 준다.
    const firstBin = Math.min(binCount - 1, Math.max(0, Math.floor((lo - minPrice) / binSize)))
    const lastBin = Math.min(binCount - 1, Math.max(0, Math.floor((hi - minPrice) / binSize)))
    const span = hi - lo
    for (let i = firstBin; i <= lastBin; i++) {
      const binLow = minPrice + i * binSize
      const binHigh = binLow + binSize
      const overlap = Math.min(hi, binHigh) - Math.max(lo, binLow)
      if (overlap > 0) volumes[i] += (bar.volume * overlap) / span
    }
  }

  const totalVolume = volumes.reduce((a, b) => a + b, 0)
  if (totalVolume <= 0) return null

  let maxIndex = 0
  for (let i = 1; i < binCount; i++) if (volumes[i] > volumes[maxIndex]) maxIndex = i

  return {
    bins: volumes.map((volume, i) => ({
      low: minPrice + i * binSize,
      high: minPrice + (i + 1) * binSize,
      volume,
    })),
    pocPrice: minPrice + (maxIndex + 0.5) * binSize,
    maxVolume: volumes[maxIndex],
    totalVolume,
  }
}
