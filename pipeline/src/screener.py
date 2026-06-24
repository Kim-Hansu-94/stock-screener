from __future__ import annotations

import pandas as pd

from .indicators import is_trending_up, rsi, sma, volume_ratio

MIN_HISTORY_DAYS = 85
LONG_TERM_WINDOW = 60
SHORT_TERM_WINDOW = 5
MID_TERM_WINDOW = 20
RSI_WINDOW = 14
RSI_LOW = 40
RSI_HIGH = 55
PULLBACK_TOLERANCE = 0.97


def passes_pullback_filter(close: pd.Series, volume: pd.Series) -> bool:
    if len(close) < MIN_HISTORY_DAYS:
        return False

    sma5 = sma(close, SHORT_TERM_WINDOW)
    sma20 = sma(close, MID_TERM_WINDOW)
    sma60 = sma(close, LONG_TERM_WINDOW)
    rsi14 = rsi(close, RSI_WINDOW)

    latest_close = close.iloc[-1]
    latest_sma60 = sma60.iloc[-1]
    latest_rsi = rsi14.iloc[-1]

    if pd.isna(latest_sma60) or pd.isna(latest_rsi):
        return False

    long_term_up = is_trending_up(sma60, lookback=SHORT_TERM_WINDOW) and latest_close > latest_sma60
    pullback = latest_close < sma5.iloc[-1] and latest_close >= sma20.iloc[-1] * PULLBACK_TOLERANCE
    rsi_ok = RSI_LOW <= latest_rsi <= RSI_HIGH
    volume_declining = volume_ratio(volume, recent_window=SHORT_TERM_WINDOW, baseline_window=MID_TERM_WINDOW) < 1

    return bool(long_term_up and pullback and rsi_ok and volume_declining)
