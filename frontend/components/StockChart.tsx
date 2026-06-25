'use client'

import { useEffect, useRef } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'
import { simpleMovingAverage } from '@/lib/calculations'
import type { PriceHistoryRow } from '@/lib/types'

interface StockChartProps {
  history: PriceHistoryRow[]
}

const MOVING_AVERAGES: Array<{ window: number; color: string }> = [
  { window: 5, color: '#2563eb' },
  { window: 20, color: '#d97706' },
  { window: 60, color: '#7c3aed' },
]

export function StockChart({ history }: StockChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || history.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 300,
      crosshair: { mode: CrosshairMode.Normal },
    })

    const candleSeries = chart.addCandlestickSeries()
    candleSeries.setData(
      history.map((row) => ({
        time: row.date,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    )

    const closes = history.map((row) => row.close)

    for (const { window, color } of MOVING_AVERAGES) {
      const maValues = simpleMovingAverage(closes, window)
      const lineSeries = chart.addLineSeries({ color, lineWidth: 1 })
      lineSeries.setData(
        history
          .map((row, index) => ({ time: row.date, value: maValues[index] }))
          .filter((point): point is { time: string; value: number } => point.value !== null),
      )
    }

    const volumeSeries = chart.addHistogramSeries({
      color: '#94a3b8',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    })
    volumeSeries.setData(history.map((row) => ({ time: row.date, value: row.volume })))

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
  }, [history])

  if (history.length === 0) {
    return <p className="text-sm text-gray-500">차트 데이터가 없습니다.</p>
  }

  return <div ref={containerRef} />
}
