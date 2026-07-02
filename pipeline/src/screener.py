from __future__ import annotations

import pandas as pd

from .indicators import is_trending_up, rsi, sma, volume_ratio

MIN_HISTORY_DAYS = 85
LONG_TERM_WINDOW = 60
SHORT_TERM_WINDOW = 5
MID_TERM_WINDOW = 20
PULLBACK_UPPER_WINDOW = 10
RSI_WINDOW = 14
RSI_LOW = 40
RSI_HIGH = 60  # raised from 55: 10-20MA zone stocks haven't cooled as far as 20MA-zone stocks
RSI_DIRECTION_LOOKBACK = 3
CONSECUTIVE_DOWN_THRESHOLD = 0.01  # 1% per day — minor noise is allowed, sustained drops are not


def passes_pullback_filter(close: pd.Series, volume: pd.Series) -> bool:
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

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    pullback = latest_sma20 <= latest_close <= latest_sma10
    rsi_ok = RSI_LOW <= latest_rsi <= RSI_HIGH
    rsi_rising = latest_rsi > rsi14.iloc[-1 - RSI_DIRECTION_LOOKBACK]
    volume_declining = volume_ratio(volume, recent_window=SHORT_TERM_WINDOW, baseline_window=MID_TERM_WINDOW) < 1

    # Block only when both consecutive down days AND each drop exceeds threshold.
    # Trivial noise (<1%/day) in a pullback is normal; sustained selling pressure is not.
    d1 = (close.iloc[-2] - close.iloc[-3]) / close.iloc[-3]
    d2 = (close.iloc[-1] - close.iloc[-2]) / close.iloc[-2]
    strong_consecutive_down = (d1 < -CONSECUTIVE_DOWN_THRESHOLD) and (d2 < -CONSECUTIVE_DOWN_THRESHOLD)

    return bool(long_term_up and pullback and rsi_ok and rsi_rising
                and not strong_consecutive_down and volume_declining)
