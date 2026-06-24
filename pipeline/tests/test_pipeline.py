from datetime import date

import numpy as np
import pandas as pd
import pytest

from pipeline.src import pipeline as pl


def _passing_history(n_up=95, drop_pct=0.030) -> pd.DataFrame:
    base = 100 + np.linspace(0, 40, n_up)
    peak = base[-1]
    total_drop = peak * drop_pct
    pullback = [peak - total_drop * f for f in (0.3, 0.55, 0.75, 0.9, 1.0)]
    close = list(base) + pullback
    volume = [1_000_000.0] * n_up + [600_000, 550_000, 500_000, 480_000, 450_000]
    return pd.DataFrame({
        "Open": close, "High": close, "Low": close, "Close": close, "Volume": volume,
    })


def _flat_history(n=30) -> pd.DataFrame:
    close = [100.0] * n
    volume = [500_000.0] * n
    return pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": volume})


@pytest.fixture
def kr_universe_df():
    return pd.DataFrame([
        {"ticker": "AAA", "name": "Stock AAA", "sector": "Semiconductors",
         "market_cap": 4e14, "meets_cap_threshold": True},
        {"ticker": "BBB", "name": "Stock BBB", "sector": "Semiconductors",
         "market_cap": 1e9, "meets_cap_threshold": False},
    ])


def test_run_kr_pipeline_screens_only_leading_sector_and_cap_qualified_stocks(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: pd.Series(100 + np.linspace(0, 100, 250)),
    )

    def fake_history(ticker, today, lookback_days):
        return _passing_history() if lookback_days == pl.FULL_HISTORY_LOOKBACK_DAYS else _flat_history()

    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", fake_history)
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: ["Semiconductors"])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.market == "KR"
    assert result.regime == "bull"
    assert result.leading_sectors == ["Semiconductors"]
    tickers = [s.ticker for s in result.screened_stocks]
    assert tickers == ["AAA"]  # BBB excluded by market cap threshold
    assert "AAA" in result.price_history


def test_run_kr_pipeline_returns_no_stocks_when_no_leading_sectors(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: pd.Series(100 - np.linspace(0, 50, 250)),
    )
    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", lambda *a, **k: _flat_history())
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: [])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.regime == "bear"
    assert result.leading_sectors == []
    assert result.screened_stocks == []
