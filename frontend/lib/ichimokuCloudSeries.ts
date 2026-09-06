// 일목균형표 구름(선행스팬A·B 사이 채우기) 커스텀 시리즈.
//
// lightweight-charts v4는 두 선 사이를 채우는 밴드 시리즈를 기본 제공하지 않는다 —
// Area 시리즈는 항상 "선 → 가격축 바닥"까지만 채운다. 대신 Custom Series API
// (v4.1+, addCustomSeries)로 직접 그려야 진짜 구름 모양이 나온다. 예전 구현은 이
// 제약 때문에 경계선 두 개(얇고 반투명한 대시선)만 그렸는데, 다른 이동평균선·
// 볼린저밴드·캔들과 겹치면 거의 안 보였다.
import {
  customSeriesDefaultOptions,
  type CustomData,
  type CustomSeriesOptions,
  type CustomSeriesPricePlotValues,
  type ICustomSeriesPaneRenderer,
  type ICustomSeriesPaneView,
  type PaneRendererCustomData,
  type PriceToCoordinateConverter,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts'
import type { BitmapCoordinatesRenderingScope, CanvasRenderingTarget2D } from 'fancy-canvas'

export interface IchimokuCloudData extends CustomData<Time> {
  senkouA: number
  senkouB: number
}

export interface IchimokuCloudSeriesOptions extends CustomSeriesOptions {
  /** 선행스팬A가 B보다 위(상승 구름)일 때 채움색 */
  upColor: string
  /** 선행스팬A가 B보다 아래(하락 구름)일 때 채움색 */
  downColor: string
}

const defaultOptions: IchimokuCloudSeriesOptions = {
  ...customSeriesDefaultOptions,
  upColor: 'rgba(240, 68, 82, 0.22)',
  downColor: 'rgba(49, 130, 246, 0.22)',
} as const

function isCloudData(
  data: IchimokuCloudData | WhitespaceData<Time>,
): data is IchimokuCloudData {
  return (data as Partial<IchimokuCloudData>).senkouA !== undefined
}

class IchimokuCloudRenderer implements ICustomSeriesPaneRenderer {
  private _data: PaneRendererCustomData<Time, IchimokuCloudData> | null = null
  private _options: IchimokuCloudSeriesOptions | null = null

  update(data: PaneRendererCustomData<Time, IchimokuCloudData>, options: IchimokuCloudSeriesOptions): void {
    this._data = data
    this._options = options
  }

  draw(target: CanvasRenderingTarget2D, priceToCoordinate: PriceToCoordinateConverter): void {
    target.useBitmapCoordinateSpace((scope) => this._drawImpl(scope, priceToCoordinate))
  }

  private _drawImpl(scope: BitmapCoordinatesRenderingScope, priceToCoordinate: PriceToCoordinateConverter): void {
    const data = this._data
    const options = this._options
    if (!data || !options || data.bars.length < 2) return

    const ctx = scope.context
    const points = data.bars.map((bar) => ({
      x: bar.x * scope.horizontalPixelRatio,
      aY: (priceToCoordinate(bar.originalData.senkouA) ?? 0) * scope.verticalPixelRatio,
      bY: (priceToCoordinate(bar.originalData.senkouB) ?? 0) * scope.verticalPixelRatio,
      a: bar.originalData.senkouA,
      b: bar.originalData.senkouB,
    }))

    // 세그먼트별로 채운다 — 구간 중간에 A/B가 역전(우세 전환)하면 색이 거기서 바뀌어야
    // 하므로 전체를 한 번에 채우지 않는다.
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1]
      const curr = points[i]
      ctx.beginPath()
      ctx.moveTo(prev.x, prev.aY)
      ctx.lineTo(curr.x, curr.aY)
      ctx.lineTo(curr.x, curr.bY)
      ctx.lineTo(prev.x, prev.bY)
      ctx.closePath()
      const bullish = prev.a + curr.a >= prev.b + curr.b
      ctx.fillStyle = bullish ? options.upColor : options.downColor
      ctx.fill()
    }
  }
}

export class IchimokuCloudSeries implements ICustomSeriesPaneView<Time, IchimokuCloudData, IchimokuCloudSeriesOptions> {
  private _renderer = new IchimokuCloudRenderer()

  priceValueBuilder(plotRow: IchimokuCloudData): CustomSeriesPricePlotValues {
    return [plotRow.senkouA, plotRow.senkouB]
  }

  isWhitespace(data: IchimokuCloudData | WhitespaceData<Time>): data is WhitespaceData<Time> {
    return !isCloudData(data)
  }

  renderer(): ICustomSeriesPaneRenderer {
    return this._renderer
  }

  update(data: PaneRendererCustomData<Time, IchimokuCloudData>, options: IchimokuCloudSeriesOptions): void {
    this._renderer.update(data, options)
  }

  defaultOptions(): IchimokuCloudSeriesOptions {
    return defaultOptions
  }
}
