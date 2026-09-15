// 매물대를 차트 위에 그리는 lightweight-charts 프리미티브.
//
// 커스텀 시리즈(IchimokuCloudSeries)가 아니라 프리미티브(attachPrimitive)를 쓰는 이유:
// 매물대는 **시간축을 따라 흐르는 값이 아니라** 가격축에 붙어 있는 가로 막대라, 시점별
// 데이터 배열로 표현할 수가 없다. 프리미티브는 캔버스에 직접 그릴 수 있어 이런 모양에 맞다.
//
// 막대는 왼쪽 끝에서 오른쪽으로 자란다 — 최근 봉은 오른쪽에 있으므로, 왼쪽에 두면
// 지금 보는 가격대를 가리지 않는다. zOrder도 'bottom'이라 캔들 뒤에 깔린다.
import type {
  ISeriesApi,
  ISeriesPrimitive,
  ISeriesPrimitivePaneRenderer,
  ISeriesPrimitivePaneView,
  SeriesAttachedParameter,
  SeriesPrimitivePaneViewZOrder,
  SeriesType,
  Time,
} from 'lightweight-charts'
import type { CanvasRenderingTarget2D } from 'fancy-canvas'
import type { VolumeProfile } from './volumeProfile'

export interface VolumeProfileStyle {
  /** 일반 구간 막대 색 */
  barColor: string
  /** 가장 두꺼운 구간(POC) 막대 색 */
  pocColor: string
  /** 차트 가로폭 대비 가장 긴 막대의 길이 비율 (0~1) */
  widthRatio: number
}

export const DEFAULT_VOLUME_PROFILE_STYLE: VolumeProfileStyle = {
  // 등락 색(빨강·파랑)과 섞이면 "오른 매물대/내린 매물대"로 오해되므로 중립 슬레이트를
  // 쓴다 — 박스 구간 표시와 같은 색 계열이다.
  barColor: 'rgba(100, 116, 139, 0.34)',
  pocColor: 'rgba(100, 116, 139, 0.68)',
  widthRatio: 0.22,
}

class VolumeProfileRenderer implements ISeriesPrimitivePaneRenderer {
  constructor(private readonly _source: VolumeProfilePrimitive) {}

  draw(target: CanvasRenderingTarget2D): void {
    const series = this._source.series
    const profile = this._source.profile
    if (!series || !profile || profile.maxVolume <= 0) return
    const style = this._source.style

    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context
      const maxBarWidth = scope.mediaSize.width * style.widthRatio * scope.horizontalPixelRatio

      for (const bin of profile.bins) {
        if (bin.volume <= 0) continue
        const yTop = series.priceToCoordinate(bin.high)
        const yBottom = series.priceToCoordinate(bin.low)
        if (yTop === null || yBottom === null) continue

        const top = yTop * scope.verticalPixelRatio
        const bottom = yBottom * scope.verticalPixelRatio
        // 칸이 1px보다 얇아지면 아예 안 보이므로 최소 높이를 준다. 칸 사이를 살짝
        // 띄워야 계단 모양이 읽히므로 아래쪽 1px을 비운다.
        const height = Math.max(1, bottom - top - scope.verticalPixelRatio)
        const width = Math.max(1, (bin.volume / profile.maxVolume) * maxBarWidth)

        ctx.fillStyle = bin.volume === profile.maxVolume ? style.pocColor : style.barColor
        ctx.fillRect(0, top, width, height)
      }
    })
  }
}

class VolumeProfilePaneView implements ISeriesPrimitivePaneView {
  private readonly _renderer: VolumeProfileRenderer

  constructor(source: VolumeProfilePrimitive) {
    this._renderer = new VolumeProfileRenderer(source)
  }

  zOrder(): SeriesPrimitivePaneViewZOrder {
    return 'bottom'
  }

  renderer(): ISeriesPrimitivePaneRenderer {
    return this._renderer
  }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  readonly style: VolumeProfileStyle
  series: ISeriesApi<SeriesType, Time> | null = null
  private readonly _paneViews: ISeriesPrimitivePaneView[]

  constructor(
    public readonly profile: VolumeProfile,
    style: Partial<VolumeProfileStyle> = {},
  ) {
    this.style = { ...DEFAULT_VOLUME_PROFILE_STYLE, ...style }
    this._paneViews = [new VolumeProfilePaneView(this)]
  }

  attached(param: SeriesAttachedParameter<Time, SeriesType>): void {
    this.series = param.series
  }

  detached(): void {
    this.series = null
  }

  updateAllViews(): void {
    // 막대 위치는 매 draw에서 priceToCoordinate로 다시 구하므로 캐시할 게 없다.
  }

  paneViews(): readonly ISeriesPrimitivePaneView[] {
    return this._paneViews
  }
}
