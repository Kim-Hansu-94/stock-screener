import pandas as pd
from unittest.mock import patch

from pipeline.src import universe_kr
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
            # Industry가 있으면 Sector보다 우선 사용되고, 둘 다 없으면 NaN이 유지되어야 한다.
            "Industry": ["반도체 제조업", None, None],
            "Sector": ["Electronics", None, "Misc"],
        })
    raise ValueError(f"unexpected market arg: {market}")


@patch("pipeline.src.universe_kr.fdr.StockListing", side_effect=_fake_listing)
def test_merges_listing_and_sector_with_cap_threshold(mock_listing, monkeypatch, tmp_path):
    # 실제 캐시 파일(pipeline/.kr_universe_cache.pkl)을 건드리면, 이 테스트가 과거에 성공했을 때
    # 남긴 낡은 캐시가 있을 경우 fetch가 깨져도 그 낡은 데이터로 조용히 "통과"해버릴 수 있다
    # (실측: Industry 컬럼 누락으로 매번 실패하는데도 낡은 캐시 덕에 51/51 통과로 보였던 사고).
    # 테스트마다 격리된 임시 경로를 쓰게 해 이런 오탐을 원천 차단한다.
    monkeypatch.setattr(universe_kr, "_CACHE_PATH", tmp_path / "kr_universe_cache.pkl")

    result = get_kr_universe(min_market_cap=300_000_000_000)
    result = result.set_index("ticker")

    assert result.loc["005930", "sector"] == "반도체 제조업"  # Industry가 Sector보다 우선
    assert result.loc["005930", "meets_cap_threshold"] is True
    assert result.loc["000660", "meets_cap_threshold"] is True
    assert result.loc["999999", "meets_cap_threshold"] is False
    assert pd.isna(result.loc["000660", "sector"])  # Industry, Sector 모두 없으면 NaN
    assert result.loc["999999", "sector"] == "Misc"  # Industry 없으면 Sector로 대체(fallback)
