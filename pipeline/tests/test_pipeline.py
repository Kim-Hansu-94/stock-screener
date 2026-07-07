from datetime import date

import numpy as np
import pandas as pd
import pytest

from pipeline.src import pipeline as pl


# 파이프라인 실행 시각(today)과 실제 마지막 봉의 날짜(as_of)가 다를 수 있음을
# 재현하기 위해, 모든 fixture의 마지막 봉 날짜를 today(2024-01-02)보다 하루 뒤로 고정한다.
LAST_BAR_DATE = date(2024, 1, 3)


def _passing_history(n_up=195, total_gain=120, drop_pct=0.038) -> pd.DataFrame:
    # screener.py's rsi_rising 조건(3일 전보다 RSI가 높아야 함)을 만족하려면 단순
    # 단조 하락 꼬리로는 안 되고, 하락 뒤에 최근 3일간 반등이 있어야 RSI가 다시
    # 올라간다. day1에 급락 후 day3~5에 완만히 반등하는 모양으로 구성한다.
    # total_gain=120(60거래일 impulse 조건 +15% 충족)과 drop_pct=0.038(sma20<=close<=sma10
    # 눌림목 구간에 정확히 걸치도록)은 실험적으로 맞춘 값이다.
    base = 100 + np.linspace(0, total_gain, n_up)
    peak = base[-1]
    day1 = peak * (1 - drop_pct)
    day2 = day1
    day3 = day2 * 1.002
    day4 = day3 * 1.006
    day5 = day4 * 1.008
    pullback = [day1, day2, day3, day4, day5]
    close = list(base) + pullback
    volume = [1_000_000.0] * n_up + [600_000, 550_000, 500_000, 480_000, 450_000]
    index = pd.date_range(end=LAST_BAR_DATE, periods=len(close))
    return pd.DataFrame({
        "Open": close, "High": close, "Low": close, "Close": close, "Volume": volume,
    }, index=index)


def _flat_history(n=30) -> pd.DataFrame:
    close = [100.0] * n
    volume = [500_000.0] * n
    index = pd.date_range(end=LAST_BAR_DATE, periods=n)
    return pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": volume}, index=index)


def _index_series(values) -> pd.Series:
    return pd.Series(values, index=pd.date_range(end=LAST_BAR_DATE, periods=len(values)))


@pytest.fixture
def kr_universe_df():
    df = pd.DataFrame([
        {"ticker": "AAA", "name": "Stock AAA", "sector": "Semiconductors",
         "market_cap": 4e14, "meets_cap_threshold": True},
        {"ticker": "BBB", "name": "Stock BBB", "sector": "Semiconductors",
         "market_cap": 1e9, "meets_cap_threshold": False},
    ])
    # Production's universe_kr.get_kr_universe() explicitly casts this column to
    # object dtype (see universe_kr.py) so that `is True`/`is False` identity
    # checks behave correctly. Reproduce that here so the boolean mask in
    # run_kr_pipeline is exercised against the same dtype shape as production.
    df["meets_cap_threshold"] = df["meets_cap_threshold"].astype(object)
    return df


@pytest.fixture
def us_universe_df():
    return pd.DataFrame([
        {"ticker": "AAA", "name": "Stock AAA", "sector": "Technology", "index_membership": "S&P500"},
        {"ticker": "BBB", "name": "Stock BBB", "sector": "Technology", "index_membership": "S&P500"},
        {"ticker": "CCC", "name": "Stock CCC", "sector": "Technology", "index_membership": "S&P400"},
        {"ticker": "DDD", "name": "Stock DDD", "sector": "Technology", "index_membership": "S&P600"},
        {"ticker": "EEE", "name": "Stock EEE", "sector": "Technology", "index_membership": "Russell3000"},
        {"ticker": "FFF", "name": "Stock FFF", "sector": "Technology", "index_membership": "S&P500"},
    ])


def test_run_kr_pipeline_screens_only_leading_sector_and_cap_qualified_stocks(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: _index_series(100 + np.linspace(0, 100, 250)),
    )

    def fake_history(ticker, today, lookback_days):
        return _passing_history() if lookback_days == pl.FULL_HISTORY_LOOKBACK_DAYS else _flat_history()

    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", fake_history)
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: ["Semiconductors"])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.market == "KR"
    assert result.regime == "bull"
    assert result.leading_sectors == ["Semiconductors"]
    assert result.as_of == LAST_BAR_DATE
    tickers = [s.ticker for s in result.screened_stocks]
    assert tickers == ["AAA"]  # BBB excluded by market cap threshold
    assert "AAA" in result.price_history
    assert result.screened_stocks[0].as_of == LAST_BAR_DATE


def test_run_kr_pipeline_returns_no_stocks_when_no_leading_sectors(monkeypatch, kr_universe_df):
    monkeypatch.setattr(pl.universe_kr, "get_kr_universe", lambda min_market_cap: kr_universe_df)
    monkeypatch.setattr(
        pl.prices_kr, "get_kospi_index_history",
        lambda today, lookback_days: _index_series(100 - np.linspace(0, 50, 250)),
    )
    monkeypatch.setattr(pl.prices_kr, "get_kr_stock_history", lambda *a, **k: _flat_history())
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: [])

    result = pl.run_kr_pipeline(today=date(2024, 1, 2))

    assert result.regime == "bear"
    assert result.leading_sectors == []
    assert result.screened_stocks == []
    assert result.as_of == LAST_BAR_DATE


def test_run_us_pipeline_screens_only_leading_sector_and_cap_qualified_stocks(monkeypatch, us_universe_df):
    monkeypatch.setattr(pl.universe_us, "get_us_universe", lambda: us_universe_df)
    monkeypatch.setattr(
        pl.prices_us, "get_us_market_caps",
        # BBB($1억)·FFF($10억)는 US_MIN_MARKET_CAP($20억) 미달로 제외되어야 한다.
        lambda tickers: {"AAA": 4e14, "BBB": 1e8, "CCC": 4e14, "DDD": 4e14, "EEE": 4e14, "FFF": 1e9},
    )
    monkeypatch.setattr(
        pl.prices_us, "get_sp500_index_history",
        lambda today, lookback_days: _index_series(100 + np.linspace(0, 100, 250)),
    )

    def fake_histories(tickers, today, lookback_days):
        # run_us_pipeline은 섹터 판별과 종목 스크리닝에 동일한 단일 호출
        # (US_UNIVERSE_HISTORY_LOOKBACK_DAYS)을 재사용하므로, 여기서도 그 한 번의
        # 호출에 대해 스크리닝 통과용 히스토리를 반환해야 한다.
        return {ticker: _passing_history() for ticker in tickers}

    monkeypatch.setattr(pl.prices_us, "get_us_stock_histories", fake_histories)
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: ["Technology"])

    result = pl.run_us_pipeline(today=date(2024, 1, 2))

    assert result.market == "US"
    assert result.regime == "bull"
    assert result.leading_sectors == ["Technology"]
    assert result.as_of == LAST_BAR_DATE
    tickers = [s.ticker for s in result.screened_stocks]
    # BBB·FFF는 시총 미달, EEE는 Russell3000 단독 편입이라 눌림목 스크리너 대상이 아님.
    # S&P400(CCC)·S&P600(DDD)은 S&P1500 확장으로 스크리너에 포함된다.
    assert tickers == ["AAA", "CCC", "DDD"]
    assert "AAA" in result.price_history
    # US price_history는 스크리닝 통과 여부와 무관하게 S&P1500+NASDAQ100 전체를
    # 담는다 (main.py의 패턴 매칭 커버리지용, pipeline.py의 run_us_pipeline 참고).
    assert "BBB" in result.price_history
    # Russell3000 단독 종목 히스토리는 main.py에서 yfinance 배치로 별도 수집.
    assert "EEE" not in result.price_history
    assert result.screened_stocks[0].as_of == LAST_BAR_DATE


def test_run_us_pipeline_returns_no_stocks_when_no_leading_sectors(monkeypatch, us_universe_df):
    monkeypatch.setattr(pl.universe_us, "get_us_universe", lambda: us_universe_df)
    monkeypatch.setattr(
        pl.prices_us, "get_us_market_caps",
        lambda tickers: {"AAA": 4e14, "BBB": 4e14},
    )
    monkeypatch.setattr(
        pl.prices_us, "get_sp500_index_history",
        lambda today, lookback_days: _index_series(100 - np.linspace(0, 50, 250)),
    )
    monkeypatch.setattr(
        pl.prices_us, "get_us_stock_histories",
        lambda tickers, today, lookback_days: {ticker: _flat_history() for ticker in tickers},
    )
    monkeypatch.setattr(pl.sectors, "leading_sectors", lambda df, top_n: [])

    result = pl.run_us_pipeline(today=date(2024, 1, 2))

    assert result.regime == "bear"
    assert result.leading_sectors == []
    assert result.screened_stocks == []
    assert result.as_of == LAST_BAR_DATE
