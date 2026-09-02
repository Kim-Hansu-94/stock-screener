import pandas as pd
import requests
from unittest.mock import MagicMock, patch

from pipeline.src.universe_us import _backfill_missing_sectors, _YFINANCE_SECTOR_TO_GICS, get_us_universe

FAKE_SP500 = pd.DataFrame({
    "Symbol": ["AAPL", "MSFT", "BRK.B", "BF.B", "BRKB"],
    "Name": ["Apple", "Microsoft", "Berkshire B", "Brown-Forman B", "Berkshire B dup"],
    "Sector": ["Information Technology", "Information Technology", "Financials", "Consumer Staples", "Financials"],
    "Industry": ["Tech Hardware", "Software", "Insurance", "Spirits", "Insurance"],
})

FAKE_NASDAQ100_HTML = """
<html><body>
<table><tr><th>Other</th></tr><tr><td>irrelevant</td></tr></table>
<table>
<tr><th>Symbol</th><th>Company Name</th><th>Market Cap</th></tr>
<tr><td>AAPL</td><td>Apple</td><td>3T</td></tr>
<tr><td>PDD</td><td>PDD Holdings</td><td>200B</td></tr>
</table>
</body></html>
"""


@patch("pipeline.src.universe_us.yf.Ticker")
@patch("pipeline.src.universe_us.requests.get")
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_combines_sp500_and_nasdaq100_without_duplicates(mock_listing, mock_get, mock_yf_ticker):
    mock_get.return_value.text = FAKE_NASDAQ100_HTML
    # Consumer Cyclical은 yfinance식 이름 — GICS(Consumer Discretionary)로 정규화돼야 한다
    mock_yf_ticker.return_value.info = {"sector": "Consumer Cyclical"}

    result = get_us_universe().set_index("ticker")

    assert result.loc["AAPL", "index_membership"] == "S&P500"  # SP500 entry kept (first), not overwritten
    assert result.loc["AAPL", "sector"] == "Information Technology"
    assert result.loc["MSFT", "index_membership"] == "S&P500"
    assert result.loc["PDD", "index_membership"] == "NASDAQ100"
    # PDD는 S&P500에 없어 원래 sector가 비어 있지만, NASDAQ100 전용 종목은
    # yfinance로 보완된다(_backfill_missing_sectors) — GICS 이름으로 정규화된 값이어야 한다.
    assert result.loc["PDD", "sector"] == "Consumer Discretionary"
    mock_yf_ticker.assert_called_once_with("PDD")
    # dot-separated class share tickers are normalized to Yahoo Finance hyphen format
    assert "BRK-B" in result.index
    assert "BRK.B" not in result.index
    assert "BF-B" in result.index
    assert "BF.B" not in result.index
    # no-separator variant (BRKB) also normalized, then deduped with BRK-B
    assert "BRKB" not in result.index


FAKE_SP400_HTML = """
<html><body>
<table>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>MID</td><td>MidCap Co</td><td>Industrials</td></tr>
</table>
</body></html>
"""

FAKE_SP600_HTML = """
<html><body>
<table>
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td>SML</td><td>SmallCap Co</td><td>Financials</td></tr>
</table>
</body></html>
"""


def _routed_get(url, **kwargs):
    resp = MagicMock()
    if "nasdaq-100-stocks" in url:
        resp.text = FAKE_NASDAQ100_HTML
    elif "S%26P_400" in url:
        resp.text = FAKE_SP400_HTML
    elif "S%26P_600" in url:
        resp.text = FAKE_SP600_HTML
    elif "vanguard" in url:
        resp.json.return_value = {
            "size": 2,
            "fund": {"entity": [
                {"ticker": "RUS", "longName": "Russell Only Co"},
                {"ticker": "MID", "longName": "MidCap dup"},
            ]},
        }
    else:  # KIS 마스터 파일 등 — 실패해도 파이프라인은 정상 동작해야 한다
        raise requests.RequestException("unavailable in test")
    return resp


@patch("pipeline.src.universe_us.yf.Ticker")
@patch("pipeline.src.universe_us.requests.get", side_effect=_routed_get)
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_always_includes_sp400_and_sp600_alongside_russell3000(mock_listing, mock_get, mock_yf_ticker):
    mock_yf_ticker.return_value.info = {}  # PDD(NASDAQ100 전용)의 업종 보완 시도 — 이 테스트는 결과 무관, 네트워크 접근만 막음
    result = get_us_universe().set_index("ticker")

    # S&P400/S&P600은 VTHR(Russell 3000) 성공 여부와 무관하게 항상 포함
    assert result.loc["MID", "index_membership"] == "S&P400"
    assert result.loc["SML", "index_membership"] == "S&P600"
    # VTHR 단독 종목은 Russell3000으로 남는다
    assert result.loc["RUS", "index_membership"] == "Russell3000"
    # 중복 시 S&P 지수 라벨이 Russell3000보다 우선한다
    assert result.loc["AAPL", "index_membership"] == "S&P500"


# ── NASDAQ100 전용 종목 업종 보완 (_backfill_missing_sectors) ──────────────
# NASDAQ100 데이터 소스(stockanalysis.com)엔 sector가 아예 없어, S&P500에도
# 속하지 않은 종목은 sector가 비어 화면의 업종 필터·재무건전성 업종별 기준이
# '미분류'로 빠진다. 개수가 적어(보통 10개 안팎) yfinance로 개별 보완한다.

def _universe(rows):
    return pd.DataFrame(rows)


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_only_targets_nasdaq100_only_tickers_with_missing_sector(mock_yf_ticker):
    mock_yf_ticker.return_value.info = {"sector": "Technology"}
    universe = _universe([
        {"ticker": "AAPL", "sector": "Information Technology", "index_membership": "S&P500"},
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
        # 다른 지수의 결측 sector는(현재 발생 안 하지만) 대상이 아니다 — NASDAQ100만 보완 범위
        {"ticker": "OTH", "sector": None, "index_membership": "S&P400"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert result.loc["PDD", "sector"] == "Technology"
    assert pd.isna(result.loc["OTH", "sector"])  # NASDAQ100이 아니므로 손대지 않음
    mock_yf_ticker.assert_called_once_with("PDD")


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_normalizes_yfinance_sector_names_to_gics(mock_yf_ticker):
    """yfinance는 GICS와 다른 이름을 쓰는 업종이 4개 있다(Consumer Cyclical/Defensive,
    Financial Services, Basic Materials). S&P500(FDR)이 채우는 sector는 GICS 이름을
    쓰고 broadSector()도 GICS 이름을 기준으로 매칭하므로, 정규화 없이 그대로 저장하면
    같은 컬럼 안에 두 이름 체계가 섞여 이 업종의 NASDAQ100 전용 종목이 broadSector()
    에서 '기타'로 잘못 빠진다.
    """
    for yfinance_name, gics_name in _YFINANCE_SECTOR_TO_GICS.items():
        mock_yf_ticker.return_value.info = {"sector": yfinance_name}
        universe = _universe([{"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"}])

        result = _backfill_missing_sectors(universe).set_index("ticker")

        assert result.loc["PDD", "sector"] == gics_name, f"{yfinance_name} → {gics_name} 정규화 실패"


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_leaves_sector_null_when_yfinance_fails(mock_yf_ticker):
    mock_yf_ticker.side_effect = RuntimeError("rate limited")
    universe = _universe([
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert pd.isna(result.loc["PDD", "sector"])  # 실패해도 죽지 않고 미분류로 남음


@patch("pipeline.src.universe_us.yf.Ticker")
def test_backfill_leaves_sector_null_when_yfinance_has_no_sector_key(mock_yf_ticker):
    mock_yf_ticker.return_value.info = {}  # info는 왔지만 sector 필드 자체가 없음
    universe = _universe([
        {"ticker": "PDD", "sector": None, "index_membership": "NASDAQ100"},
    ])

    result = _backfill_missing_sectors(universe).set_index("ticker")

    assert pd.isna(result.loc["PDD", "sector"])


def test_backfill_is_a_noop_when_nothing_is_missing():
    universe = _universe([
        {"ticker": "AAPL", "sector": "Information Technology", "index_membership": "S&P500"},
    ])

    result = _backfill_missing_sectors(universe)

    assert result.loc[0, "sector"] == "Information Technology"
