from datetime import date
from unittest.mock import patch

import pandas as pd

from pipeline.src.prices_kr import get_kospi_index_history, get_kr_stock_history

FAKE_OHLCV = pd.DataFrame({
    "Open": [100, 101],
    "High": [105, 106],
    "Low": [99, 100],
    "Close": [104, 105],
    "Volume": [1000, 1100],
    "Change": [0.01, 0.01],
}, index=pd.to_datetime(["2024-01-01", "2024-01-02"]))


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
def test_get_kospi_index_history_returns_close_series(mock_reader):
    result = get_kospi_index_history(end=date(2024, 1, 2), lookback_days=300)
    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "KS11"
    assert list(result) == [104, 105]


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
def test_get_kr_stock_history_returns_ohlcv_columns(mock_reader):
    result = get_kr_stock_history("005930", end=date(2024, 1, 2), lookback_days=120)
    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "005930"
    assert list(result.columns) == ["Open", "High", "Low", "Close", "Volume"]
