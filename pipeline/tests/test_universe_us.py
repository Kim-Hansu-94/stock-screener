import pandas as pd
import requests
from unittest.mock import MagicMock, patch

from pipeline.src.universe_us import get_us_universe

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
<tr><th>Ticker</th><th>Company</th><th>ICB Industry</th></tr>
<tr><td>AAPL</td><td>Apple</td><td>Technology</td></tr>
<tr><td>PDD</td><td>PDD Holdings</td><td>Consumer Discretionary</td></tr>
</table>
</body></html>
"""


@patch("pipeline.src.universe_us.requests.get")
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_combines_sp500_and_nasdaq100_without_duplicates(mock_listing, mock_get):
    mock_get.return_value.text = FAKE_NASDAQ100_HTML

    result = get_us_universe().set_index("ticker")

    assert result.loc["AAPL", "index_membership"] == "S&P500"  # SP500 entry kept (first), not overwritten
    assert result.loc["AAPL", "sector"] == "Information Technology"
    assert result.loc["MSFT", "index_membership"] == "S&P500"
    assert result.loc["PDD", "index_membership"] == "NASDAQ100"
    assert pd.isna(result.loc["PDD", "sector"])
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
    if "Nasdaq-100" in url:
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


@patch("pipeline.src.universe_us.requests.get", side_effect=_routed_get)
@patch("pipeline.src.universe_us.fdr.StockListing", return_value=FAKE_SP500)
def test_always_includes_sp400_and_sp600_alongside_russell3000(mock_listing, mock_get):
    result = get_us_universe().set_index("ticker")

    # S&P400/S&P600은 VTHR(Russell 3000) 성공 여부와 무관하게 항상 포함
    assert result.loc["MID", "index_membership"] == "S&P400"
    assert result.loc["SML", "index_membership"] == "S&P600"
    # VTHR 단독 종목은 Russell3000으로 남는다
    assert result.loc["RUS", "index_membership"] == "Russell3000"
    # 중복 시 S&P 지수 라벨이 Russell3000보다 우선한다
    assert result.loc["AAPL", "index_membership"] == "S&P500"
