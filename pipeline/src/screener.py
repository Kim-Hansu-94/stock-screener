from __future__ import annotations

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
CONSECUTIVE_DOWN_THRESHOLD = 0.01  # 1% per day — minor noise is allowed, sustained drops are not
VOLUME_DECLINE_THRESHOLD = 0.85  # recent 5d avg vol must drop to 85% of prior 20d avg (was <1.0)
IMPULSE_LOOKBACK_DAYS = 60
IMPULSE_MIN_GAIN = 0.15  # 선행 임팩트: 최근 60거래일 수익률 +15% 이상인 종목만
PULLBACK_LOWER_TOLERANCE = 0.05  # sma20 대비 5%까지 하회 허용 — 대형주는 변동성이 낮아
# 좁은 눌림목 구간(sma20~sma10)에 잘 걸리지 않아 하한을 sma20 아래로 넓힌다.


def passes_pullback_filter(
    close: pd.Series,
    volume: pd.Series,
    high: pd.Series,
    *,
    require_sma200: bool = False,
) -> bool:
    if len(close) < MIN_HISTORY_DAYS:
        return False

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
        return False

    # Require close above 200-day MA to exclude long-term downtrend stocks (KR + US).
    if require_sma200:
        sma200 = sma(close, SMA200_WINDOW)
        latest_sma200 = sma200.iloc[-1]
        if pd.isna(latest_sma200) or latest_close <= latest_sma200:
            return False

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    pullback_lower_bound = latest_sma20 * (1 - PULLBACK_LOWER_TOLERANCE)
    pullback = pullback_lower_bound <= latest_close <= latest_sma10
    rsi_ok = RSI_LOW <= latest_rsi <= RSI_HIGH
    rsi_rising = latest_rsi > rsi14.iloc[-1 - RSI_DIRECTION_LOOKBACK]
    volume_declining = (
        volume_ratio(volume, recent_window=SHORT_TERM_WINDOW, baseline_window=MID_TERM_WINDOW)
        < VOLUME_DECLINE_THRESHOLD
    )

    # Block only when both consecutive down days AND each drop exceeds threshold.
    # Trivial noise (<1%/day) in a pullback is normal; sustained selling pressure is not.
    d1 = (close.iloc[-2] - close.iloc[-3]) / close.iloc[-3]
    d2 = (close.iloc[-1] - close.iloc[-2]) / close.iloc[-2]
    strong_consecutive_down = (d1 < -CONSECUTIVE_DOWN_THRESHOLD) and (d2 < -CONSECUTIVE_DOWN_THRESHOLD)

    # 선행 임팩트: 눌림목 이전에 강한 상승 파동이 있었던 종목만.
    impulse = (latest_close / close.iloc[-1 - IMPULSE_LOOKBACK_DAYS] - 1) >= IMPULSE_MIN_GAIN

    # 반등 확인: 당일 종가가 전일 고가를 넘어야 진입 — 하락 중 매수(falling knife) 방지.
    # 백테스트(KR 시총 상위 500, 2010~) 전 보유기간에서 유일하게 일관된 개선 조건.
    bounce_confirmed = latest_close > high.iloc[-2]

    return bool(long_term_up and pullback and rsi_ok and rsi_rising
                and not strong_consecutive_down and volume_declining
                and impulse and bounce_confirmed)
