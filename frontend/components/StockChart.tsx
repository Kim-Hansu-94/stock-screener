'use client'

import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts'
import { simpleMovingAverage, bollingerBands, relativeStrengthIndex, ichimokuLines } from '@/lib/calculations'
import type { PriceHistoryRow } from '@/lib/types'

interface StockChartProps {
  history: PriceHistoryRow[]
  monthly?: boolean
  bollinger?: boolean
  rsi?: boolean
  volume?: boolean
  ichimoku?: boolean
  preAggregated?: boolean
  stopPrice?: number
  targetPrice?: number
  /** 기본 이동평균선 세트(monthly 여부에 따른 DAILY/MONTHLY_MOVING_AVERAGES)를 덮어쓴다. */
  movingAverages?: Array<{ window: number; color: string }>
}

const DAILY_MOVING_AVERAGES: Array<{ window: number; color: string }> = [
  { window: 5, color: '#2563eb' },
  { window: 20, color: '#d97706' },
  { window: 60, color: '#7c3aed' },
]

const MONTHLY_MOVING_AVERAGES: Array<{ window: number; color: string }> = [
  { window: 3, color: '#2563eb' },
  { window: 6, color: '#d97706' },
]

// 일목균형표 표준 파라미터(9/26/52) + 선행스팬 이격(26봉).
const ICHIMOKU_TENKAN = 9
const ICHIMOKU_KIJUN = 26
const ICHIMOKU_SENKOU_B = 52
const ICHIMOKU_DISPLACEMENT = 26

// 캔들 색과 동일한 규칙: 양봉(상승) 계열 빨강, 음봉(하락) 계열 파랑.
const ICHIMOKU_SENKOU_A_COLOR = '#f0445299'
const ICHIMOKU_SENKOU_B_COLOR = '#3182f699'
const ICHIMOKU_TENKAN_COLOR = '#059669'
const ICHIMOKU_KIJUN_COLOR = '#db2777'
const ICHIMOKU_CHIKOU_COLOR = '#6b7280'

// 선행스팬(미래로 26봉)·후행스팬(과거로 26봉) 이동에 쓸 거래일 근사 — 주말만 건너뛰고
// 공휴일은 무시한다(시각적 참고용 보조지표라 이 정도 근사로 충분, 실제 거래일 데이터를
// 갖고 있지 않은 미래 구간은 애초에 근사 없이는 그릴 방법이 없다).
function addTradingDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  let remaining = days
  const step = days >= 0 ? 1 : -1
  while (remaining !== 0) {
    d.setUTCDate(d.getUTCDate() + step)
    const day = d.getUTCDay()
    if (day !== 0 && day !== 6) remaining -= step
  }
  return d.toISOString().slice(0, 10)
}

// 축·크로스헤어 가격에 천단위 구분점을 넣는다. 국장은 원 단위라 정수로, 미장은
// 달러라 소수 2자리로 — 자릿수가 큰 국장 가격(예: 1326000)이 특히 읽기 어려웠다.
function formatAxisPrice(price: number): string {
  return Math.abs(price) >= 1000
    ? Math.round(price).toLocaleString('en-US')
    : price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function toMonthlyOHLCV(daily: PriceHistoryRow[]): PriceHistoryRow[] {
  const months: Record<string, PriceHistoryRow[]> = {}
  for (const row of daily) {
    const key = row.date.slice(0, 7)
    ;(months[key] ??= []).push(row)
  }
  return Object.entries(months)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, rows]) => ({
      ticker: rows[0].ticker,
      market: rows[0].market,
      date: rows[rows.length - 1].date,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows[rows.length - 1].close,
      volume: rows.reduce((sum, r) => sum + r.volume, 0),
    }))
}

export function StockChart({
  history,
  monthly = false,
  bollinger = false,
  rsi = false,
  volume = false,
  ichimoku = false,
  preAggregated = false,
  stopPrice,
  targetPrice,
  movingAverages,
}: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || history.length === 0) return

    const data = monthly && !preAggregated ? toMonthlyOHLCV(history) : history
    const maSet = movingAverages ?? (monthly ? MONTHLY_MOVING_AVERAGES : DAILY_MOVING_AVERAGES)
    const bbWindow = monthly ? 10 : 20
    const rsiWindow = monthly ? 6 : 14

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: rsi ? 240 : 300,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { priceFormatter: formatAxisPrice },
    })

    // lightweight-charts 기본값은 상승=초록/하락=빨강(서양식)이라 명시적으로 덮어써야 한다.
    // 한국 관례: 상승=빨강(--up), 하락=파랑(--down).
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#f04452',
      downColor: '#3182f6',
      borderUpColor: '#f04452',
      borderDownColor: '#3182f6',
      wickUpColor: '#f04452',
      wickDownColor: '#3182f6',
    })
    candleSeries.setData(
      data.map((row) => ({
        time: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    )

    const closes = data.map((row) => row.close)

    for (const { window, color } of maSet) {
      const maValues = simpleMovingAverage(closes, window)
      const lineSeries = chart.addLineSeries({ color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false })
      lineSeries.setData(
        data
          .map((row, index) => ({ time: row.date, value: maValues[index] }))
          .filter((point): point is { time: string; value: number } => point.value !== null),
      )
    }

    if (bollinger) {
      const bbValues = bollingerBands(closes, bbWindow)
      const bbColor = '#60a5fa'
      const bbOpts = { color: bbColor, lineWidth: 2 as const, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false }

      const upperSeries = chart.addLineSeries(bbOpts)
      upperSeries.setData(
        data
          .map((row, index) => ({ time: row.date, value: bbValues[index].upper }))
          .filter((p): p is { time: string; value: number } => p.value !== null),
      )

      const lowerSeries = chart.addLineSeries(bbOpts)
      lowerSeries.setData(
        data
          .map((row, index) => ({ time: row.date, value: bbValues[index].lower }))
          .filter((p): p is { time: string; value: number } => p.value !== null),
      )
    }

    if (ichimoku) {
      const highs = data.map((row) => row.high)
      const lows = data.map((row) => row.low)
      const { tenkan, kijun, senkouA, senkouB } = ichimokuLines(highs, lows, {
        tenkanWindow: ICHIMOKU_TENKAN,
        kijunWindow: ICHIMOKU_KIJUN,
        senkouBWindow: ICHIMOKU_SENKOU_B,
      })

      const addLine = (color: string, dashed: boolean) =>
        chart.addLineSeries({
          color,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          lastValueVisible: false,
          priceLineVisible: false,
        })

      // lightweight-charts는 시간이 엄격히 오름차순이어야 한다. 선행스팬처럼 날짜를
      // 거래일 수만큼 계산해서 옮기는 경우, 원본 날짜에 주말이 끼어 있으면(실거래
      // 데이터엔 없지만 방어적으로) 서로 다른 두 봉이 같은 이동 후 날짜로 겹칠 수
      // 있다 — 그런 점은 건너뛰어 항상 오름차순을 유지한다.
      const setLineData = (
        series: ReturnType<typeof addLine>,
        values: (number | null)[],
        timeAt: (index: number) => string,
      ) => {
        const points: { time: string; value: number }[] = []
        let lastTime: string | null = null
        for (let index = 0; index < values.length; index++) {
          const value = values[index]
          if (value === null) continue
          const time = timeAt(index)
          if (lastTime !== null && time <= lastTime) continue
          points.push({ time, value })
          lastTime = time
        }
        series.setData(points)
      }

      // 전환선·기준선은 지금 시점 그대로.
      setLineData(addLine(ICHIMOKU_TENKAN_COLOR, false), tenkan, (i) => data[i].date)
      setLineData(addLine(ICHIMOKU_KIJUN_COLOR, false), kijun, (i) => data[i].date)

      // 선행스팬A/B는 26봉 앞(미래)으로 투영 — 구름의 경계선. 실제 v4 lightweight-charts는
      // 두 선 사이를 채우는 밴드 시리즈가 없어(플러그인 없이는), 경계선 두 개로만 표시한다.
      setLineData(addLine(ICHIMOKU_SENKOU_A_COLOR, true), senkouA, (i) =>
        addTradingDays(data[i].date, ICHIMOKU_DISPLACEMENT),
      )
      setLineData(addLine(ICHIMOKU_SENKOU_B_COLOR, true), senkouB, (i) =>
        addTradingDays(data[i].date, ICHIMOKU_DISPLACEMENT),
      )

      // 후행스팬은 오늘 종가를 26봉 뒤(과거)로 투영 — i번째 종가를 (i-26)번째 날짜에 찍는다.
      const chikouSeries = addLine(ICHIMOKU_CHIKOU_COLOR, true)
      chikouSeries.setData(
        closes
          .map((close, i) =>
            i >= ICHIMOKU_DISPLACEMENT ? { time: data[i - ICHIMOKU_DISPLACEMENT].date, value: close } : null,
          )
          .filter((p): p is { time: string; value: number } => p !== null),
      )
    }

    // 거래량은 별도 패널이 아니라 가격 차트 아래 20%에 겹쳐 그린다(별도 priceScaleId로
    // 축을 분리). 봉 색과 같은 규칙(양봉=빨강, 음봉=파랑)으로 칠해 캔들과 바로 대응되게 한다.
    if (volume) {
      const volumeSeries = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: '',
        lastValueVisible: false,
        priceLineVisible: false,
      })
      chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
      volumeSeries.setData(
        data.map((row) => ({
          time: row.date,
          value: row.volume,
          color: row.close >= row.open ? '#f0445280' : '#3182f680',
        })),
      )
    }

    // 손절은 현재가 아래(하락) 방향이라 파랑, 목표는 위(상승) 방향이라 빨강 —
    // StockCard의 손익비 막대와 같은 규칙.
    if (stopPrice !== undefined) {
      candleSeries.createPriceLine({ price: stopPrice, color: '#3182f6', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '손절' })
    }
    if (targetPrice !== undefined) {
      candleSeries.createPriceLine({ price: targetPrice, color: '#f04452', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '목표' })
    }

    chart.timeScale().fitContent()

    let rsiChart: ReturnType<typeof createChart> | null = null

    if (rsi && rsiRef.current) {
      rsiChart = createChart(rsiRef.current, {
        width: rsiRef.current.clientWidth,
        height: 80,
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { scaleMargins: { top: 0.15, bottom: 0.15 } },
      })

      const rsiValues = relativeStrengthIndex(closes, rsiWindow)
      const rsiSeries = rsiChart.addLineSeries({
        color: '#7c3aed',
        lineWidth: 1,
        lastValueVisible: true,
        priceLineVisible: false,
      })
      rsiSeries.setData(
        data
          .map((row, index) => ({ time: row.date, value: rsiValues[index] }))
          .filter((p): p is { time: string; value: number } => p.value !== null),
      )
      // 70/30은 가격 방향이 아니라 과매수·과매도 참고선이라 등락 색(빨강/파랑)을 쓰지 않는다.
      rsiSeries.createPriceLine({ price: 70, color: '#8b95a1', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' })
      rsiSeries.createPriceLine({ price: 30, color: '#8b95a1', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' })
      rsiChart.timeScale().fitContent()
    }

    const handleResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
      if (rsiChart && rsiRef.current) rsiChart.applyOptions({ width: rsiRef.current.clientWidth })
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
      rsiChart?.remove()
    }
  }, [history, monthly, bollinger, rsi, volume, ichimoku, preAggregated, stopPrice, targetPrice, movingAverages])

  if (history.length === 0) {
    return <p className="text-sm text-muted-foreground">차트 데이터가 없습니다.</p>
  }

  const legendMaSet = movingAverages ?? (monthly ? MONTHLY_MOVING_AVERAGES : DAILY_MOVING_AVERAGES)
  const maUnit = monthly ? '개월선' : '일선'

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
        {legendMaSet.map(({ window, color }) => (
          <span key={window} className="flex items-center gap-1">
            <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ backgroundColor: color }} />
            {window}
            {maUnit}
          </span>
        ))}
        {bollinger && (
          <span className="flex items-center gap-1">
            <span className="inline-block w-3.5" style={{ borderTop: '2px dashed #60a5fa' }} />
            볼린저밴드
          </span>
        )}
        {volume && (
          <span className="flex items-center gap-1">
            <span className="inline-block h-2.5 w-1.5 rounded-[1px] bg-muted-foreground/50" />
            거래량
          </span>
        )}
        {ichimoku && (
          <>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ backgroundColor: ICHIMOKU_TENKAN_COLOR }} />
              전환선
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-0.5 w-3.5 rounded-full" style={{ backgroundColor: ICHIMOKU_KIJUN_COLOR }} />
              기준선
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3.5" style={{ borderTop: `2px dashed ${ICHIMOKU_SENKOU_A_COLOR}` }} />
              선행스팬A/B(구름)
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-3.5" style={{ borderTop: `2px dashed ${ICHIMOKU_CHIKOU_COLOR}` }} />
              후행스팬
            </span>
          </>
        )}
      </div>
      <div ref={containerRef} />
      {rsi && (
        <>
          <p className="mt-1 text-[11px] text-muted-foreground">RSI ({monthly ? 6 : 14})</p>
          <div ref={rsiRef} />
        </>
      )}
    </div>
  )
}
