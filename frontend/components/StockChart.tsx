'use client'

import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'
import { simpleMovingAverage } from '@/lib/calculations'
import type { PriceHistoryRow } from '@/lib/types'

interface StockChartProps {
  history: PriceHistoryRow[]
  monthly?: boolean
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

export function StockChart({ history, monthly = false }: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || history.length === 0) return

    const data = monthly ? toMonthlyOHLCV(history) : history
    const maSet = monthly ? MONTHLY_MOVING_AVERAGES : DAILY_MOVING_AVERAGES

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 300,
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
      const lineSeries = chart.addLineSeries({ color, lineWidth: 1 })
      lineSeries.setData(
        data
          .map((row, index) => ({ time: row.date, value: maValues[index] }))
          .filter((point): point is { time: string; value: number } => point.value !== null),
      )
    }

    const volumeSeries = chart.addHistogramSeries({
      color: '#94a3b8',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    })
    volumeSeries.setData(data.map((row) => ({ time: row.date, value: row.volume })))

    const handleResize = () => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [history, monthly])

  if (history.length === 0) {
    return <p className="text-sm text-gray-500">차트 데이터가 없습니다.</p>
  }

  return <div ref={containerRef} />
}
