import pandas as pd
from unittest.mock import patch

from pipeline.src.universe_us import get_us_universe

FAKE_SP500 = pd.DataFrame({
    "Symbol": ["AAPL", "MSFT"],
    "Name": ["Apple", "Microsoft"],
    "Sector": ["Information Technology", "Information Technology"],
    "Industry": ["Tech Hardware", "Software"],
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
    assert len(result) == 3
