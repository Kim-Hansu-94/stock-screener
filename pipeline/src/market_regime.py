from __future__ import annotations

import pandas as pd

from .indicators import sma


def determine_market_regime(close: pd.Series) -> str:
    sma50 = sma(close, 50)
    sma200 = sma(close, 200)

    latest_sma200 = sma200.iloc[-1]
    if pd.isna(latest_sma200):
        return "bear"

    latest_close = close.iloc[-1]
    latest_sma50 = sma50.iloc[-1]
    if latest_close > latest_sma50 and latest_sma50 > latest_sma200:
        return "bull"
    return "bear"
