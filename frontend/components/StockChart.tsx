'use client'

import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode, LineStyle } from 'lightweight-charts'
import { simpleMovingAverage, bollingerBands, relativeStrengthIndex } from '@/lib/calculations'
import type { PriceHistoryRow } from '@/lib/types'

interface StockChartProps {
  history: PriceHistoryRow[]
  monthly?: boolean
  bollinger?: boolean
  rsi?: boolean
  preAggregated?: boolean
  stopPrice?: number
  targetPrice?: number
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

export function StockChart({ history, monthly = false, bollinger = false, rsi = false, preAggregated = false, stopPrice, targetPrice }: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const rsiRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || history.length === 0) return

    const data = monthly && !preAggregated ? toMonthlyOHLCV(history) : history
    const maSet = monthly ? MONTHLY_MOVING_AVERAGES : DAILY_MOVING_AVERAGES
    const bbWindow = monthly ? 10 : 20
    const rsiWindow = monthly ? 6 : 14

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: rsi ? 240 : 300,
      crosshair: { mode: CrosshairMode.Normal },
    })

    const candleSeries = chart.addCandlestickSeries()
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
      const bbColor = '#93c5fd'
      const bbOpts = { color: bbColor, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, lastValueVisible: false, priceLineVisible: false }

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

    if (stopPrice !== undefined) {
      candleSeries.createPriceLine({ price: stopPrice, color: '#ef4444', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '손절' })
    }
    if (targetPrice !== undefined) {
      candleSeries.createPriceLine({ price: targetPrice, color: '#22c55e', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '목표' })
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
      rsiSeries.createPriceLine({ price: 70, color: '#ef4444', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' })
      rsiSeries.createPriceLine({ price: 30, color: '#22c55e', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' })
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
  }, [history, monthly, bollinger, rsi, stopPrice, targetPrice])

  if (history.length === 0) {
    return <p className="text-sm text-gray-500">차트 데이터가 없습니다.</p>
  }

  return (
    <div>
      <div ref={containerRef} />
      {rsi && <div ref={rsiRef} className="mt-1" />}
    </div>
  )
}
