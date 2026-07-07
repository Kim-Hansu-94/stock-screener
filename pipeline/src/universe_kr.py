from __future__ import annotations

import FinanceDataReader as fdr
import pandas as pd


def get_kr_universe(min_market_cap: float) -> pd.DataFrame:
    listing = fdr.StockListing("KRX")[["Code", "Name", "Market", "Marcap"]]
    # KRX-DESC의 "Sector"는 KOSPI 종목엔 전부 NaN이고 KOSDAQ 시장구분(벤처/우량기업부)만
    # 담긴다. 실제 업종 분류는 "Industry"(예: "반도체 제조업")에 있으므로 이를 섹터로 쓴다.
    desc = fdr.StockListing("KRX-DESC")[["Code", "Industry", "Sector"]]
    desc["sector"] = desc["Industry"].fillna(desc["Sector"])

    universe = listing.merge(desc[["Code", "sector"]], on="Code", how="left")
    universe = universe.rename(columns={
        "Code": "ticker",
        "Name": "name",
        "Market": "index_membership",
        "Marcap": "market_cap",
    })
    universe["meets_cap_threshold"] = universe["market_cap"] >= min_market_cap
    result = universe[
        ["ticker", "name", "sector", "index_membership", "market_cap", "meets_cap_threshold"]
    ].copy()
    result["meets_cap_threshold"] = result["meets_cap_threshold"].astype(object)
    return result
