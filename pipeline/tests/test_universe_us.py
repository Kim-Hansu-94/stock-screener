import pandas as pd
from unittest.mock import patch

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
