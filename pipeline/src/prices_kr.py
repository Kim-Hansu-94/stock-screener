from __future__ import annotations

from datetime import date, timedelta

import FinanceDataReader as fdr
import pandas as pd

KOSPI_INDEX_TICKER = "KS11"


def get_kospi_index_history(end: date, lookback_days: int) -> pd.Series:
    start = end - timedelta(days=lookback_days)
    df = fdr.DataReader(KOSPI_INDEX_TICKER, start.isoformat(), end.isoformat())
    return df["Close"]


def get_kr_stock_history(ticker: str, end: date, lookback_days: int) -> pd.DataFrame:
    start = end - timedelta(days=lookback_days)
    df = fdr.DataReader(ticker, start.isoformat(), end.isoformat())
    return df[["Open", "High", "Low", "Close", "Volume"]]
