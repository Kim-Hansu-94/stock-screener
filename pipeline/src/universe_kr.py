from __future__ import annotations

import FinanceDataReader as fdr
import pandas as pd


def get_kr_universe(min_market_cap: float) -> pd.DataFrame:
    listing = fdr.StockListing("KRX")[["Code", "Name", "Market", "Marcap"]]
    desc = fdr.StockListing("KRX-DESC")[["Code", "Sector"]]

    universe = listing.merge(desc, on="Code", how="left")
    universe = universe.rename(columns={
        "Code": "ticker",
        "Name": "name",
        "Marcap": "market_cap",
        "Sector": "sector",
    })
    universe["meets_cap_threshold"] = universe["market_cap"] >= min_market_cap
    result = universe[["ticker", "name", "sector", "market_cap", "meets_cap_threshold"]].copy()
    result["meets_cap_threshold"] = result["meets_cap_threshold"].astype(object)
    return result
