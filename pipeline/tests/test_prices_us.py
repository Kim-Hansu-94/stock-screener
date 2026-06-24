from datetime import date
from unittest.mock import MagicMock, patch

import pandas as pd

from pipeline.src.prices_us import (
    get_sp500_index_history,
    get_us_market_caps,
    get_us_stock_histories,
)


def _fake_single_ticker_download(*args, **kwargs):
    columns = pd.MultiIndex.from_tuples([
        ("Close", "^GSPC"), ("Open", "^GSPC"), ("High", "^GSPC"), ("Low", "^GSPC"), ("Volume", "^GSPC"),
    ])
    return pd.DataFrame(
        [[104, 100, 105, 99, 1000], [105, 101, 106, 100, 1100]],
        columns=columns,
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


def _fake_multi_ticker_download(*args, **kwargs):
    columns = pd.MultiIndex.from_tuples([
        ("AAPL", "Open"), ("AAPL", "High"), ("AAPL", "Low"), ("AAPL", "Close"), ("AAPL", "Volume"),
        ("MSFT", "Open"), ("MSFT", "High"), ("MSFT", "Low"), ("MSFT", "Close"), ("MSFT", "Volume"),
    ])
    return pd.DataFrame(
        [[100, 105, 99, 104, 1000, 200, 205, 199, 204, 2000],
         [101, 106, 100, 105, 1100, 201, 206, 200, 205, 2100]],
        columns=columns,
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


@patch("pipeline.src.prices_us.yf.download", side_effect=_fake_single_ticker_download)
def test_get_sp500_index_history_returns_close_series(mock_download):
    result = get_sp500_index_history(end=date(2024, 1, 2), lookback_days=400)
    assert list(result) == [104, 105]


@patch("pipeline.src.prices_us.yf.download", side_effect=_fake_multi_ticker_download)
def test_get_us_stock_histories_returns_per_ticker_frames(mock_download):
    result = get_us_stock_histories(["AAPL", "MSFT"], end=date(2024, 1, 2), lookback_days=200)
    assert set(result.keys()) == {"AAPL", "MSFT"}
    assert list(result["AAPL"].columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert result["AAPL"]["Close"].iloc[-1] == 105


@patch("pipeline.src.prices_us.yf.Ticker")
def test_get_us_market_caps_returns_value_per_ticker(mock_ticker_cls):
    fake_ticker = MagicMock()
    fake_ticker.fast_info = {"marketCap": 123.0}
    mock_ticker_cls.return_value = fake_ticker

    result = get_us_market_caps(["AAPL"])
    assert result == {"AAPL": 123.0}


@patch("pipeline.src.prices_us.yf.Ticker")
def test_get_us_market_caps_defaults_to_zero_on_error(mock_ticker_cls):
    mock_ticker_cls.side_effect = RuntimeError("network error")
    result = get_us_market_caps(["BROKEN"])
    assert result == {"BROKEN": 0.0}
