from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .indicators import is_trending_up, rsi, sma, volume_ratio

MIN_HISTORY_DAYS = 85
LONG_TERM_WINDOW = 60
SMA200_WINDOW = 200
SHORT_TERM_WINDOW = 5
MID_TERM_WINDOW = 20
PULLBACK_UPPER_WINDOW = 10
RSI_WINDOW = 14
RSI_LOW = 40
RSI_HIGH = 60  # raised from 55: 10-20MA zone stocks haven't cooled as far as 20MA-zone stocks
RSI_DIRECTION_LOOKBACK = 3
VOLUME_DECLINE_THRESHOLD = 0.85  # recent 5d avg vol must drop to 85% of prior 20d avg (was <1.0)
IMPULSE_LOOKBACK_DAYS = 60
IMPULSE_MIN_GAIN = 0.15  # 선행 임팩트: 최근 60거래일 수익률 +15% 이상인 종목만
PULLBACK_LOWER_TOLERANCE = 0.05  # sma20 대비 5%까지 하회 허용 — 대형주는 변동성이 낮아
# 좁은 눌림목 구간(sma20~sma10)에 잘 걸리지 않아 하한을 sma20 아래로 넓힌다.


# 조건별 실패 라벨 — DB(failed_criteria text[])에 그대로 저장되어 프론트에 표시된다.
CRITERION_SMA200 = "200일선 아래"
CRITERION_LONG_TREND = "장기 추세 꺾임"
CRITERION_PULLBACK_ZONE = "눌림 구간 밖"
CRITERION_RSI_RANGE = "RSI 범위 밖"
CRITERION_RSI_RISING = "RSI 하락 중"
CRITERION_VOLUME = "거래량 미감소"
CRITERION_IMPULSE = "선행 상승 부족"
CRITERION_BOUNCE = "반등 미확인"


@dataclass
class PullbackEvaluation:
    passed: bool
    failed: list[str] = field(default_factory=list)
    impulse_gain: float = 0.0  # 최근 60거래일 수익률 — 근접 종목 랭킹 타이브레이커


def evaluate_pullback(
    close: pd.Series,
    volume: pd.Series,
    high: pd.Series,
    *,
    require_sma200: bool = False,
) -> PullbackEvaluation | None:
    """모든 눌림목 조건을 평가해 미달 조건 목록을 반환한다.

    통과/탈락 이분법 대신 "어떤 조건이 몇 개 미달인지"를 남겨, 전 조건 통과
    종목이 없는 날에도 가장 근접한 상위 종목을 랭킹으로 보여줄 수 있게 한다.
    데이터가 부족해 평가 자체가 불가능하면 None (랭킹 대상에서 제외).
    """
    if len(close) < MIN_HISTORY_DAYS:
        return None

    sma10 = sma(close, PULLBACK_UPPER_WINDOW)
    sma20 = sma(close, MID_TERM_WINDOW)
    sma60 = sma(close, LONG_TERM_WINDOW)
    rsi14 = rsi(close, RSI_WINDOW)

    latest_close = close.iloc[-1]
    latest_sma10 = sma10.iloc[-1]
    latest_sma20 = sma20.iloc[-1]
    latest_sma60 = sma60.iloc[-1]
    latest_rsi = rsi14.iloc[-1]

    if pd.isna(latest_sma60) or pd.isna(latest_rsi) or pd.isna(latest_sma10) or pd.isna(latest_sma20):
        return None

    failed: list[str] = []

    # Require close above 200-day MA to exclude long-term downtrend stocks (KR + US).
    if require_sma200:
        sma200 = sma(close, SMA200_WINDOW)
        latest_sma200 = sma200.iloc[-1]
        if pd.isna(latest_sma200) or latest_close <= latest_sma200:
            failed.append(CRITERION_SMA200)

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    if not long_term_up:
        failed.append(CRITERION_LONG_TREND)

    pullback_lower_bound = latest_sma20 * (1 - PULLBACK_LOWER_TOLERANCE)
    if not (pullback_lower_bound <= latest_close <= latest_sma10):
        failed.append(CRITERION_PULLBACK_ZONE)

    if not (RSI_LOW <= latest_rsi <= RSI_HIGH):
        failed.append(CRITERION_RSI_RANGE)

    if not (latest_rsi > rsi14.iloc[-1 - RSI_DIRECTION_LOOKBACK]):
        failed.append(CRITERION_RSI_RISING)

    volume_declining = (
        volume_ratio(volume, recent_window=SHORT_TERM_WINDOW, baseline_window=MID_TERM_WINDOW)
        < VOLUME_DECLINE_THRESHOLD
    )
    if not volume_declining:
        failed.append(CRITERION_VOLUME)

    # 선행 임팩트: 눌림목 이전에 강한 상승 파동이 있었던 종목만.
    impulse_gain = float(latest_close / close.iloc[-1 - IMPULSE_LOOKBACK_DAYS] - 1)
    if impulse_gain < IMPULSE_MIN_GAIN:
        failed.append(CRITERION_IMPULSE)

    # 반등 확인: 당일 종가가 전일 고가를 넘어야 진입 — 하락 중 매수(falling knife) 방지.
    # 백테스트(KR 시총 상위 500, 2010~) 전 보유기간에서 유일하게 일관된 개선 조건.
    if not (latest_close > high.iloc[-2]):
        failed.append(CRITERION_BOUNCE)

    return PullbackEvaluation(passed=not failed, failed=failed, impulse_gain=impulse_gain)


def passes_pullback_filter(
    close: pd.Series,
    volume: pd.Series,
    high: pd.Series,
    *,
    require_sma200: bool = False,
) -> bool:
    ev = evaluate_pullback(close, volume, high, require_sma200=require_sma200)
    return ev is not None and ev.passed
