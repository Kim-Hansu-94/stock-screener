import pandas as pd

from pipeline.src.sp500_monitor import (
    ETF_TICKER,
    compute_daily_state,
    daily_rows,
    etf_history_rows,
    etf_quote_row,
)


def _series(prices: list[float]) -> pd.Series:
    idx = pd.bdate_range("2026-01-01", periods=len(prices))
    return pd.Series(prices, index=idx, dtype=float)


def _ohlcv(closes: list[float]) -> pd.DataFrame:
    idx = pd.bdate_range("2026-01-01", periods=len(closes))
    return pd.DataFrame({
        "Open": closes, "High": closes, "Low": closes,
        "Close": closes, "Volume": [100] * len(closes),
    }, index=idx)


def test_drawdown_uses_running_high():
    daily = compute_daily_state(_series([100.0, 110.0, 99.0]))
    assert daily["high_52w"].tolist() == [100.0, 110.0, 110.0]
    assert round(float(daily["drawdown_pct"].iloc[-1]), 2) == -10.0
    assert float(daily["drawdown_pct"].iloc[1]) == 0.0


def test_daily_rows_serialization():
    rows = daily_rows(compute_daily_state(_series([100.0, 95.0])))
    assert rows[0]["date"] == "2026-01-01"
    assert rows[1] == {
        "date": "2026-01-02", "close": 95.0, "high_52w": 100.0, "drawdown_pct": -5.0,
    }


def test_etf_quote_row_change_pct():
    quote = etf_quote_row(_ohlcv([10000.0, 10100.0]))
    assert quote["ticker"] == ETF_TICKER
    assert quote["currency"] == "KRW"
    assert quote["change_pct"] == 1.0
    assert quote["as_of"] == "2026-01-02"


def test_etf_history_rows_match_price_history_schema():
    rows = etf_history_rows(_ohlcv([10000.0, 10100.0]))
    assert rows[0] == {
        "ticker": ETF_TICKER, "market": "KR", "date": "2026-01-01",
        "open": 10000.0, "high": 10000.0, "low": 10000.0,
        "close": 10000.0, "volume": 100,
    }
