from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
import yfinance as yf

SP500_INDEX_TICKER = "^GSPC"


def get_sp500_index_history(end: date, lookback_days: int) -> pd.Series:
    start = end - timedelta(days=lookback_days)
    df = yf.download(SP500_INDEX_TICKER, start=start.isoformat(), end=end.isoformat(), progress=False)
    return df["Close"][SP500_INDEX_TICKER]


def get_us_stock_histories(tickers: list[str], end: date, lookback_days: int) -> dict[str, pd.DataFrame]:
    start = end - timedelta(days=lookback_days)
    raw = yf.download(
        tickers, start=start.isoformat(), end=end.isoformat(), progress=False, group_by="ticker",
    )
    histories: dict[str, pd.DataFrame] = {}
    for ticker in tickers:
        histories[ticker] = raw[ticker][["Open", "High", "Low", "Close", "Volume"]].dropna()
    return histories


def get_us_market_caps(tickers: list[str]) -> dict[str, float]:
    caps: dict[str, float] = {}
    for ticker in tickers:
        try:
            caps[ticker] = float(yf.Ticker(ticker).fast_info["marketCap"])
        except Exception:
            caps[ticker] = 0.0
    return caps
