from datetime import date

import pipeline.src.fundamentals as fundamentals
from pipeline.src.fundamentals import refresh_fundamentals


TODAY = date(2026, 7, 31)


class _CountingDB:
    """save_fundamentals 호출을 기록하는 DB 스텁."""

    def __init__(self):
        self.saves: list[list[dict]] = []

    def save_fundamentals(self, rows):
        self.saves.append(list(rows))


def _patch(monkeypatch, db, *, stale, extract, chunk=None, cap=None):
    monkeypatch.setattr(fundamentals, "_stale_tickers", lambda *a, **k: list(stale))
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


def test_kr_skips_entirely_when_dart_api_key_is_unset(monkeypatch):
    monkeypatch.delenv("DART_API_KEY", raising=False)
    db = _CountingDB()
    _patch(monkeypatch, db, stale=["005930"], extract=lambda _s: {"per": 1.0})

    refresh_fundamentals(db, "KR", ["005930"], TODAY)

    # DART_API_KEY 없이 400종목을 개별 시도해 전부 실패로 남기지 않고, 아예 건너뛴다
    # (Yahoo _extract는 호출되지 않아야 한다 — KR은 더 이상 Yahoo 경로를 안 쓴다).
    assert db.saves == []


def test_kr_uses_dart_not_yahoo(monkeypatch):
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    db = _CountingDB()
    _patch(monkeypatch, db, stale=["005930"], extract=lambda _s: (_ for _ in ()).throw(
        AssertionError("KR 경로는 yfinance _extract를 호출하면 안 된다")
    ))
    monkeypatch.setattr(
        fundamentals.dart_fundamentals, "extract",
        lambda ticker, year: ({"ticker_seen": ticker, "per": None}, "ok"),
    )

    refresh_fundamentals(db, "KR", ["005930"], TODAY)

    saved = [r for chunk in db.saves for r in chunk]
    assert saved[0]["ticker"] == "005930"
    assert saved[0]["ticker_seen"] == "005930"


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


def test_kr_failure_log_includes_ticker_examples_per_reason(monkeypatch, capsys):
    """실패 사유별 개수만으로는 corp_code_not_found가 우선주 때문인지 다른
    이유인지 구분이 안 된다. 사유별로 실제 티커를 몇 개 찍어야 다음 실행에서
    바로 원인을 좁힐 수 있다.
    """
    db = _CountingDB()
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    _patch(monkeypatch, db, stale=["A", "B", "C"], extract=lambda _s: None)

    reasons = {"A": "corp_code_not_found", "B": "corp_code_not_found", "C": "no_key_accounts"}
    monkeypatch.setattr(
        fundamentals.dart_fundamentals, "extract",
        lambda ticker, year: (None, reasons[ticker]),
    )

    refresh_fundamentals(db, "KR", ["A", "B", "C"], TODAY)

    out = capsys.readouterr().out
    assert "corp_code_not_found=2" in out
    assert "no_key_accounts=1" in out
    assert "corp_code_not_found 예: A, B" in out
    assert "no_key_accounts 예: C" in out
