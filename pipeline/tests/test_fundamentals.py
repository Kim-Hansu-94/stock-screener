from datetime import date

from pipeline.src import fundamentals


class FakeTicker:
    def __init__(self, info_by_symbol: dict[str, dict], symbol: str):
        self._info = info_by_symbol.get(symbol)

    def get_info(self):
        if self._info is None:
            raise RuntimeError("symbol not found")
        return self._info


def _patch_yf(monkeypatch, info_by_symbol: dict[str, dict]) -> list[str]:
    requested: list[str] = []

    def fake_ticker(symbol: str):
        requested.append(symbol)
        return FakeTicker(info_by_symbol, symbol)

    monkeypatch.setattr(fundamentals.yf, "Ticker", fake_ticker)
    return requested


def test_us_ticker_extracts_and_converts_fractions(monkeypatch):
    _patch_yf(monkeypatch, {
        "AAPL": {
            "trailingPE": 28.5, "priceToBook": 45.2, "trailingEps": 6.42,
            "returnOnEquity": 1.474, "dividendYield": 0.55,
            "revenueGrowth": 0.061, "profitMargins": 0.25,
        },
    })

    rows = fundamentals.get_fundamentals(["AAPL"], "US", date(2024, 1, 2))

    assert rows == [{
        "ticker": "AAPL", "market": "US",
        "per": 28.5, "pbr": 45.2, "eps": 6.42, "dividend_yield": 0.55,
        "roe": 147.4, "revenue_growth": 6.1, "profit_margin": 25.0,
        "updated_at": "2024-01-02",
    }]


def test_kr_ticker_falls_back_from_ks_to_kq(monkeypatch):
    requested = _patch_yf(monkeypatch, {
        "247540.KQ": {"trailingPE": 90.1},
    })

    rows = fundamentals.get_fundamentals(["247540"], "KR", date(2024, 1, 2))

    assert requested == ["247540.KS", "247540.KQ"]
    assert len(rows) == 1
    assert rows[0]["ticker"] == "247540"  # 접미사 없는 원본 티커로 저장
    assert rows[0]["market"] == "KR"
    assert rows[0]["per"] == 90.1


def test_skips_tickers_without_any_usable_field(monkeypatch):
    _patch_yf(monkeypatch, {
        "GOOD": {"trailingPE": 10.0},
        "EMPTY": {"symbol": "EMPTY", "trailingPE": None},
    })

    rows = fundamentals.get_fundamentals(["GOOD", "EMPTY", "MISSING"], "US", date(2024, 1, 2))

    assert [r["ticker"] for r in rows] == ["GOOD"]


def test_deduplicates_tickers(monkeypatch):
    requested = _patch_yf(monkeypatch, {"AAPL": {"trailingPE": 28.5}})

    rows = fundamentals.get_fundamentals(["AAPL", "AAPL"], "US", date(2024, 1, 2))

    assert requested == ["AAPL"]
    assert len(rows) == 1


def test_rejects_non_numeric_and_nan_values(monkeypatch):
    _patch_yf(monkeypatch, {
        "WEIRD": {"trailingPE": "Infinity-ish", "priceToBook": float("nan"), "trailingEps": True, "dividendYield": 1.2},
    })

    rows = fundamentals.get_fundamentals(["WEIRD"], "US", date(2024, 1, 2))

    assert rows[0]["per"] is None
    assert rows[0]["pbr"] is None
    assert rows[0]["eps"] is None
    assert rows[0]["dividend_yield"] == 1.2
