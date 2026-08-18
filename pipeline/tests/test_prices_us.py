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


# ── 캐시 깊이(과거로 얼마나 뻗어 있는지) 관련 ────────────────────────────
# 증분 경로는 최근 봉만 덧붙이므로, 한 번 짧게 캐시된 종목은 스스로 길어지지 못한다.
# 그 상태로 두면 200일선이 영영 NaN이 되어 스크리너가 "200일선 아래"로 잘못 떨어뜨린다.

def _frame(start: str, periods: int) -> pd.DataFrame:
    idx = pd.bdate_range(start=start, periods=periods)
    return pd.DataFrame(
        {"Open": 1.0, "High": 1.0, "Low": 1.0, "Close": 1.0, "Volume": 100},
        index=idx,
    )


def _patch_io(monkeypatch, cache, *, full_fetch):
    monkeypatch.setattr(prices_us, "_load_price_cache", lambda: cache)
    monkeypatch.setattr(prices_us, "_save_price_cache", lambda c: None)
    monkeypatch.setattr(prices_us, "_save_exch_cache", lambda: None)
    monkeypatch.setattr(prices_us, "_save_short_history", lambda: None)
    monkeypatch.setattr(prices_us, "_fetch_single", full_fetch)
    monkeypatch.setattr(prices_us, "_last_us_trading_day", lambda end: end)


def test_shallow_cache_triggers_a_full_refetch(monkeypatch):
    """캐시가 최신이어도 과거로 얕으면 전체를 다시 받아야 한다."""
    end = date(2026, 8, 18)
    # 최신 봉은 있지만 120봉뿐 — 200일선을 못 만든다
    cache = {"MU": _frame("2026-03-02", 120)}
    cache["MU"] = cache["MU"].set_index(
        pd.bdate_range(end=pd.Timestamp(end), periods=120)
    )
    calls = []

    def full_fetch(ticker, end_, lookback_days, session):
        calls.append(ticker)
        return _frame("2025-08-18", 260).set_index(
            pd.bdate_range(end=pd.Timestamp(end_), periods=260)
        )

    monkeypatch.setattr(prices_us, "_short_history", {})
    _patch_io(monkeypatch, cache, full_fetch=full_fetch)

    result = get_us_stock_histories(["MU"], end=end, lookback_days=380)

    assert calls == ["MU"], "얕은 캐시인데 전체 재수집이 일어나지 않았다"
    assert len(result["MU"]) >= 200


def test_deep_and_fresh_cache_is_reused_without_refetch(monkeypatch):
    """깊이가 충분하고 최신이면 API를 다시 부르지 않는다(기존 최적화 유지)."""
    end = date(2026, 8, 18)
    cache = {"AAPL": _frame("2025-01-01", 300).set_index(
        pd.bdate_range(end=pd.Timestamp(end), periods=300)
    )}
    calls = []

    def full_fetch(ticker, end_, lookback_days, session):
        calls.append(ticker)
        return pd.DataFrame()

    monkeypatch.setattr(prices_us, "_short_history", {})
    _patch_io(monkeypatch, cache, full_fetch=full_fetch)

    result = get_us_stock_histories(["AAPL"], end=end, lookback_days=380)

    assert calls == [], "깊고 최신인 캐시인데 불필요하게 재수집했다"
    assert len(result["AAPL"]) > 0


def test_genuinely_short_listing_is_not_refetched_every_run(monkeypatch):
    """상장이 짧아 원래 그만큼뿐인 종목은 기록해 두고 재수집을 반복하지 않는다."""
    end = date(2026, 8, 18)
    cache = {"NEWCO": _frame("2026-05-01", 80).set_index(
        pd.bdate_range(end=pd.Timestamp(end), periods=80)
    )}
    calls = []

    def full_fetch(ticker, end_, lookback_days, session):
        calls.append(ticker)
        return pd.DataFrame()

    # 이전 실행에서 "이 종목은 이 날짜가 최초"라고 확정해 둔 상태
    oldest = cache["NEWCO"].index.min().date().isoformat()
    monkeypatch.setattr(prices_us, "_short_history", {"NEWCO": oldest})
    _patch_io(monkeypatch, cache, full_fetch=full_fetch)

    get_us_stock_histories(["NEWCO"], end=end, lookback_days=380)

    assert calls == [], "상장이 짧은 게 확정된 종목을 또 전체 수집했다"


def test_failed_refetch_falls_back_to_the_shallow_cache(monkeypatch):
    """깊이를 채우러 갔다가 API가 실패하면 얕은 캐시라도 그대로 내준다.

    여기서 버리면 어제까지 나오던 종목이 일시적 장애로 화면에서 통째로 사라진다.
    """
    end = date(2026, 8, 18)
    cache = {"MU": _frame("2026-03-02", 120).set_index(
        pd.bdate_range(end=pd.Timestamp(end), periods=120)
    )}

    def full_fetch(ticker, end_, lookback_days, session):
        raise RuntimeError("KIS 일시 장애")

    monkeypatch.setattr(prices_us, "_short_history", {})
    _patch_io(monkeypatch, cache, full_fetch=full_fetch)

    result = get_us_stock_histories(["MU"], end=end, lookback_days=380)

    assert "MU" in result, "재수집 실패로 기존 캐시까지 잃었다"
    assert len(result["MU"]) == 120
