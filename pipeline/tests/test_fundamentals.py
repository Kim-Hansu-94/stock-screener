from datetime import date

from pipeline.src.fundamentals import _candidates_first


class _FakeRpc:
    def __init__(self, rows: list[dict] | Exception):
        self._rows = rows

    def execute(self):
        if isinstance(self._rows, Exception):
            raise self._rows
        return type("Result", (), {"data": self._rows})()


class _FakeClient:
    def __init__(self, rows: list[dict] | Exception):
        self._rows = rows
        self.calls = 0

    def rpc(self, name: str, params: dict):
        self.calls += 1
        assert name == "get_opp_drawdowns"
        if isinstance(self._rows, Exception):
            return _FakeRpc(self._rows)
        wanted = set(params["p_tickers"])
        return _FakeRpc([r for r in self._rows if r["ticker"] in wanted])


class _FakeDB:
    def __init__(self, rows: list[dict] | Exception):
        self.client = _FakeClient(rows)


TODAY = date(2026, 7, 31)


def test_moves_drawdown_band_tickers_to_the_front():
    # AAA: -30% (밴드 안), BBB: -5% (얕음), CCC: -70% (너무 깊음)
    rows = [
        {"ticker": "AAA", "high3y": 100.0, "current_close": 70.0},
        {"ticker": "BBB", "high3y": 100.0, "current_close": 95.0},
        {"ticker": "CCC", "high3y": 100.0, "current_close": 30.0},
    ]
    ordered = _candidates_first(_FakeDB(rows), "US", ["BBB", "CCC", "AAA"], TODAY)
    assert ordered[0] == "AAA"
    # 밴드 밖 종목도 버리지 않고 뒤로 밀 뿐이다
    assert sorted(ordered) == ["AAA", "BBB", "CCC"]


def test_keeps_original_order_when_rpc_fails():
    pending = ["AAA", "BBB"]
    assert _candidates_first(_FakeDB(RuntimeError("boom")), "US", pending, TODAY) == pending


def test_keeps_original_order_when_nothing_is_in_band():
    rows = [{"ticker": "AAA", "high3y": 100.0, "current_close": 99.0}]
    pending = ["AAA"]
    assert _candidates_first(_FakeDB(rows), "US", pending, TODAY) == pending


def test_ignores_tickers_without_a_valid_high():
    rows = [
        {"ticker": "AAA", "high3y": 0.0, "current_close": 10.0},
        {"ticker": "BBB", "high3y": 100.0, "current_close": 60.0},
    ]
    ordered = _candidates_first(_FakeDB(rows), "US", ["AAA", "BBB"], TODAY)
    assert ordered[0] == "BBB"
