from __future__ import annotations

import pandas as pd


def leading_sectors(df: pd.DataFrame, top_n: int = 3, window: int = 5) -> list[str]:
    df = df.dropna(subset=["sector"]).sort_values("date")
    if df.empty:
        return []

    recent_dates = df["date"].drop_duplicates().sort_values().iloc[-window:]
    recent = df[df["date"].isin(recent_dates)].copy()
    recent["trading_value"] = recent["close"] * recent["volume"]
    trading_value_by_sector = recent.groupby("sector")["trading_value"].mean()

    first_date = recent_dates.iloc[0]
    last_date = recent_dates.iloc[-1]
    avg_close_first = df[df["date"] == first_date].groupby("sector")["close"].mean()
    avg_close_last = df[df["date"] == last_date].groupby("sector")["close"].mean()
    momentum = (avg_close_last / avg_close_first) - 1

    positive_momentum = momentum.reindex(trading_value_by_sector.index) > 0
    candidates = trading_value_by_sector[positive_momentum]
    return candidates.sort_values(ascending=False).head(top_n).index.tolist()
