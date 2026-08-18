from datetime import date

import pipeline.src.opportunities as opportunities
from pipeline.src.opportunities import refresh_opportunity_snapshot

TODAY = date(2026, 7, 31)


class _Table:
    def __init__(self, log):
        self._log = log

    def delete(self):
        self._log.append("delete")
        return self

    def eq(self, *_a):
        return self

    def lt(self, *_a):
        return self

    def execute(self):
        return type("R", (), {"data": []})()


class _Client:
    def __init__(self):
        self.log: list[str] = []

    def table(self, _name):
        return _Table(self.log)

    def rpc(self, _name, _params):
        return type("R", (), {"execute": lambda _s: type("X", (), {"data": []})()})()


class _DB:
    def __init__(self):
        self.client = _Client()
        self.saved: list[dict] = []

    def save_opportunity_snapshot(self, rows):
        self.saved.extend(rows)


UNIVERSE = [
    {"ticker": "AAA", "name": "A corp", "name_kr": "에이", "sector": "IT", "index_membership": "KOSPI"},
    {"ticker": "BBB", "name": "B corp", "name_kr": "비", "sector": "IT", "index_membership": "KOSPI"},
]


def _patch(monkeypatch, *, in_band, bars, evaluate):
    monkeypatch.setattr(opportunities, "in_band_tickers", lambda *_a: in_band)
    monkeypatch.setattr(opportunities, "_fetch_bars_bulk", lambda *_a: bars)
    monkeypatch.setattr(opportunities, "evaluate_watch", evaluate)


def _qualified(**over):
    base = {
        "qualified": True, "reason": None, "score": 0.82, "days_since_low": 130,
        "vcp": True, "higher_lows": True, "volume_dry": True,
        "aligned_mas": False, "volume_trigger": False,
    }
    base.update(over)
    return base


def test_saves_only_tickers_that_pass_the_hard_filters(monkeypatch):
    db = _DB()
    _patch(
        monkeypatch,
        in_band={
            "AAA": {"high3y": 100.0, "current_close": 70.0, "drawdown": 30.0},
            "BBB": {"high3y": 100.0, "current_close": 60.0, "drawdown": 40.0},
        },
        bars={
            "AAA": [{"date": "2026-07-30", "close": 70.0}],
            "BBB": [{"date": "2026-07-30", "close": 60.0}],
        },
        evaluate=lambda bars: _qualified() if bars[0]["close"] == 70.0 else {"qualified": False},
    )

    refresh_opportunity_snapshot(db, "KR", UNIVERSE, TODAY)

    assert [r["ticker"] for r in db.saved] == ["AAA"]


def test_carries_scores_names_and_as_of_date(monkeypatch):
    db = _DB()
    _patch(
        monkeypatch,
        in_band={"AAA": {"high3y": 100.0, "current_close": 70.0, "drawdown": 30.0}},
        bars={"AAA": [{"date": "2026-07-29", "close": 71.0}, {"date": "2026-07-30", "close": 70.0}]},
        evaluate=lambda _b: _qualified(score=0.91),
    )

    refresh_opportunity_snapshot(db, "KR", UNIVERSE, TODAY)

    row = db.saved[0]
    assert row["score"] == 0.91
    assert row["name_kr"] == "에이"
    assert row["drawdown"] == 30.0
    # 마지막 봉 날짜가 카드의 "기준일"이 된다
    assert row["as_of_date"] == "2026-07-30"
    assert row["computed_at"] == "2026-07-31"


def test_clears_stale_rows_so_dropouts_disappear(monkeypatch):
    db = _DB()
    _patch(
        monkeypatch,
        in_band={"AAA": {"high3y": 100.0, "current_close": 70.0, "drawdown": 30.0}},
        bars={"AAA": [{"date": "2026-07-30", "close": 70.0}]},
        evaluate=lambda _b: _qualified(),
    )

    refresh_opportunity_snapshot(db, "KR", UNIVERSE, TODAY)

    assert "delete" in db.client.log


def test_survives_a_failure_without_raising(monkeypatch):
    db = _DB()

    def _boom(*_a):
        raise RuntimeError("table missing")

    monkeypatch.setattr(opportunities, "in_band_tickers", _boom)

    refresh_opportunity_snapshot(db, "KR", UNIVERSE, TODAY)  # 예외가 새어나오면 실패

    assert db.saved == []
