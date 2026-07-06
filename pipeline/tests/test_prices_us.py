from datetime import date
from unittest.mock import MagicMock, patch

import pandas as pd

from pipeline.src import prices_us
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


def _fake_fetch_single(ticker, end, lookback_days, session):
    # get_us_stock_histories는 yfinance가 아닌 KIS API(_fetch_single)를 사용하므로,
    # 실제 네트워크/디스크 캐시를 우회하려면 이 헬퍼를 몽키패치해야 한다.
    closes = {"AAPL": [104, 105], "MSFT": [204, 205]}[ticker]
    return pd.DataFrame(
        {"Open": [c - 4 for c in closes], "High": [c + 1 for c in closes],
         "Low": [c - 5 for c in closes], "Close": closes, "Volume": [1000, 1100]},
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


@patch("pipeline.src.prices_us.yf.download", side_effect=_fake_single_ticker_download)
def test_get_sp500_index_history_returns_close_series(mock_download):
    result = get_sp500_index_history(end=date(2024, 1, 2), lookback_days=400)
    assert list(result) == [104, 105]


def test_get_us_stock_histories_returns_per_ticker_frames(monkeypatch):
    monkeypatch.setattr(prices_us, "_load_price_cache", lambda: {})
    monkeypatch.setattr(prices_us, "_fetch_single", _fake_fetch_single)
    monkeypatch.setattr(prices_us, "_save_price_cache", lambda cache: None)
    monkeypatch.setattr(prices_us, "_save_exch_cache", lambda: None)

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


@patch("pipeline.src.prices_us.yf.Ticker")
def test_get_us_market_caps_handles_partial_failure(mock_ticker_cls):
    def side_effect_fn(ticker):
        if ticker == "BROKEN":
            raise RuntimeError("network error")
        fake_ticker = MagicMock()
        fake_ticker.fast_info = {"marketCap": 1000.0 if ticker == "AAPL" else 2000.0}
        return fake_ticker

    mock_ticker_cls.side_effect = side_effect_fn
    result = get_us_market_caps(["AAPL", "BROKEN", "MSFT"])
    assert result == {"AAPL": 1000.0, "BROKEN": 0.0, "MSFT": 2000.0}
