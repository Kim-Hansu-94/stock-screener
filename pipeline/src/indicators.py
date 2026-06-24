from __future__ import annotations

import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window).mean()


def rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.rolling(window=window).mean()
    avg_loss = loss.rolling(window=window).mean()
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def is_trending_up(ma_series: pd.Series, lookback: int = 5) -> bool:
    valid = ma_series.dropna()
    if len(valid) <= lookback:
        return False
    return bool(ma_series.iloc[-1] > ma_series.iloc[-1 - lookback])


def volume_ratio(volume: pd.Series, recent_window: int = 5, baseline_window: int = 20) -> float:
    recent_avg = volume.iloc[-recent_window:].mean()
    baseline_avg = volume.iloc[-(recent_window + baseline_window):-recent_window].mean()
    return float(recent_avg / baseline_avg)
