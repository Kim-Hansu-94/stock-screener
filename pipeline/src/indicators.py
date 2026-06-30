from __future__ import annotations

import pandas as pd


def sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window=window).mean()


def rsi(series: pd.Series, window: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    result = pd.Series(float('nan'), index=series.index)
    if len(series) <= window:
        return result

    # Wilder's smoothed RSI: SMA seed, then SMMA — matches frontend calculations.ts
    avg_gain = float(gain.iloc[1:window + 1].mean())
    avg_loss = float(loss.iloc[1:window + 1].mean())
    result.iloc[window] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    for i in range(window + 1, len(series)):
        avg_gain = (avg_gain * (window - 1) + float(gain.iloc[i])) / window
        avg_loss = (avg_loss * (window - 1) + float(loss.iloc[i])) / window
        result.iloc[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    return result


def is_trending_up(ma_series: pd.Series, lookback: int = 5) -> bool:
    valid = ma_series.dropna()
    if len(valid) <= lookback:
        return False
    return bool(ma_series.iloc[-1] > ma_series.iloc[-1 - lookback])


def volume_ratio(volume: pd.Series, recent_window: int = 5, baseline_window: int = 20) -> float:
    recent_avg = volume.iloc[-recent_window:].mean()
    baseline_avg = volume.iloc[-(recent_window + baseline_window):-recent_window].mean()
    return float(recent_avg / baseline_avg)
