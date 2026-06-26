from __future__ import annotations

import io

import FinanceDataReader as fdr
import pandas as pd
import requests

NASDAQ100_WIKI_URL = "https://en.wikipedia.org/wiki/Nasdaq-100"

# Yahoo Finance uses hyphens for share class suffixes (BRK-B, BF-B).
# Some data sources omit the separator entirely (BRKB, BFB) — correct those explicitly.
_TICKER_CORRECTIONS: dict[str, str] = {
    "BRKB": "BRK-B",
    "BFB": "BF-B",
}


def _normalize_ticker(t: str) -> str:
    if t in _TICKER_CORRECTIONS:
        return _TICKER_CORRECTIONS[t]
    return t.replace(".", "-")


def _fetch_nasdaq100_table() -> pd.DataFrame:
    headers = {"User-Agent": "Mozilla/5.0"}
    html = requests.get(NASDAQ100_WIKI_URL, headers=headers, timeout=30).text
    tables = pd.read_html(io.StringIO(html))
    for table in tables:
        columns = [str(c) for c in table.columns]
        if "Ticker" in columns and "Company" in columns:
            return table[["Ticker", "Company"]].rename(columns={"Ticker": "ticker", "Company": "name"})
    raise ValueError("Nasdaq-100 constituent table not found on Wikipedia page")


def get_us_universe() -> pd.DataFrame:
    sp500 = fdr.StockListing("S&P500")[["Symbol", "Name", "Sector"]]
    sp500 = sp500.rename(columns={"Symbol": "ticker", "Name": "name", "Sector": "sector"})
    sp500["index_membership"] = "S&P500"

    nasdaq100 = _fetch_nasdaq100_table()
    nasdaq100["sector"] = None
    nasdaq100["index_membership"] = "NASDAQ100"

    universe = pd.concat([sp500, nasdaq100], ignore_index=True)
    universe["ticker"] = universe["ticker"].map(_normalize_ticker)
    universe = universe.drop_duplicates(subset="ticker", keep="first")
    return universe[["ticker", "name", "sector", "index_membership"]]
