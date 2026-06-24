import pandas as pd
from unittest.mock import patch

from pipeline.src.universe_kr import get_kr_universe


def _fake_listing(market):
    if market == "KRX":
        return pd.DataFrame({
            "Code": ["005930", "000660", "999999"],
            "Name": ["Samsung", "SK Hynix", "Tiny Corp"],
            "Market": ["KOSPI", "KOSPI", "KOSDAQ"],
            "Marcap": [400_000_000_000_000, 350_000_000_000, 10_000_000_000],
        })
    if market == "KRX-DESC":
        return pd.DataFrame({
            "Code": ["005930", "000660", "999999"],
            "Name": ["Samsung", "SK Hynix", "Tiny Corp"],
            "Market": ["KOSPI", "KOSPI", "KOSDAQ"],
            "Sector": ["Electronics", None, "Misc"],
        })
    raise ValueError(f"unexpected market arg: {market}")


@patch("pipeline.src.universe_kr.fdr.StockListing", side_effect=_fake_listing)
def test_merges_listing_and_sector_with_cap_threshold(mock_listing):
    result = get_kr_universe(min_market_cap=300_000_000_000)
    result = result.set_index("ticker")

    assert result.loc["005930", "sector"] == "Electronics"
    assert result.loc["005930", "meets_cap_threshold"] is True
    assert result.loc["000660", "meets_cap_threshold"] is True
    assert result.loc["999999", "meets_cap_threshold"] is False
    assert pd.isna(result.loc["000660", "sector"])
