from datetime import date

import pipeline.src.fundamentals as fundamentals
from pipeline.src.fundamentals import _candidates_first, refresh_fundamentals


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


class _CountingDB:
    """save_fundamentals 호출을 기록하는 DB 스텁."""

    def __init__(self):
        self.saves: list[list[dict]] = []
        self.client = _FakeClient([])

    def save_fundamentals(self, rows):
        self.saves.append(list(rows))


def _patch(monkeypatch, db, *, stale, extract, chunk=None, cap=None):
    monkeypatch.setattr(fundamentals, "_stale_tickers", lambda *a, **k: list(stale))
    monkeypatch.setattr(fundamentals, "_candidates_first", lambda _d, _m, p, _t: p)
    monkeypatch.setattr(fundamentals, "_extract", extract)
    if chunk is not None:
        monkeypatch.setattr(fundamentals, "SAVE_CHUNK", chunk)
    if cap is not None:
        monkeypatch.setattr(fundamentals, "MAX_PER_RUN", cap)
    return db


def test_saves_incrementally_so_an_interrupted_run_keeps_progress(monkeypatch):
    db = _CountingDB()
    tickers = [f"T{i:03d}" for i in range(10)]
    _patch(monkeypatch, db, stale=tickers, extract=lambda _s: {"per": 1.0}, chunk=4)

    refresh_fundamentals(db, "US", tickers, TODAY)

    # 4개씩 중간 저장 + 마지막 잔여분 → 한 번에 몰아 저장하지 않는다
    assert [len(s) for s in db.saves] == [4, 4, 2]
    assert sum(len(s) for s in db.saves) == 10


def test_failed_tickers_are_not_saved_so_they_retry_next_run(monkeypatch):
    db = _CountingDB()
    tickers = ["OK1", "BAD", "OK2"]
    _patch(
        monkeypatch,
        db,
        stale=tickers,
        extract=lambda symbol: None if symbol == "BAD" else {"per": 1.0},
        chunk=50,
    )

    refresh_fundamentals(db, "US", tickers, TODAY)

    saved = [r["ticker"] for chunk in db.saves for r in chunk]
    assert saved == ["OK1", "OK2"]


def test_respects_the_per_run_cap(monkeypatch):
    db = _CountingDB()
    tickers = [f"T{i:03d}" for i in range(20)]
    _patch(monkeypatch, db, stale=tickers, extract=lambda _s: {"per": 1.0}, chunk=50, cap=5)

    refresh_fundamentals(db, "US", tickers, TODAY)

    assert sum(len(s) for s in db.saves) == 5


def test_a_save_failure_does_not_abort_the_remaining_chunks(monkeypatch):
    class _FlakyDB(_CountingDB):
        def save_fundamentals(self, rows):
            if len(self.saves) == 0:
                self.saves.append([])
                raise RuntimeError("first chunk failed")
            super().save_fundamentals(rows)

    db = _FlakyDB()
    tickers = [f"T{i:03d}" for i in range(6)]
    _patch(monkeypatch, db, stale=tickers, extract=lambda _s: {"per": 1.0}, chunk=3)

    refresh_fundamentals(db, "US", tickers, TODAY)

    # 첫 청크 저장이 실패해도 두 번째 청크는 정상 저장된다
    assert len(db.saves[-1]) == 3
