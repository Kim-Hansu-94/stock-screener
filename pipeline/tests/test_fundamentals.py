from datetime import date

import pandas as pd

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
        lambda ticker, year, **kw: ({"ticker_seen": ticker, "per": None}, "ok"),
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
        lambda ticker, year, **kw: (None, reasons[ticker]),
    )

    refresh_fundamentals(db, "KR", ["A", "B", "C"], TODAY)

    out = capsys.readouterr().out
    assert "corp_code_not_found=2" in out
    assert "no_key_accounts=1" in out
    assert "corp_code_not_found 예: A, B" in out
    assert "no_key_accounts 예: C" in out


def test_corp_code_not_found_is_cached_so_it_is_not_retried_every_run(monkeypatch):
    """DART의 corpCode.xml 자체가 '이 티커는 없다'고 답한 확정적 실패다. 재시도해도
    결과가 달라지지 않으므로, 빈 행이라도 저장해 다음 30일간 _stale_tickers의
    재시도 대상에서 빠지게 한다. 안 그러면 우선주 같은 종목이 매 실행 헛되이
    재시도된다(실제로 20개 중 12개가 이 사유였다).
    """
    db = _CountingDB()
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    _patch(monkeypatch, db, stale=["005935"], extract=lambda _s: None)
    monkeypatch.setattr(
        fundamentals.dart_fundamentals, "extract",
        lambda ticker, year, **kw: (None, "corp_code_not_found"),
    )

    refresh_fundamentals(db, "KR", ["005935"], TODAY)

    saved = [r for chunk in db.saves for r in chunk]
    assert len(saved) == 1
    assert saved[0]["ticker"] == "005935"
    assert saved[0]["revenue_latest"] is None  # 데이터는 비어 있지만 저장은 됨


def test_no_key_accounts_is_not_cached_since_it_might_resolve_later(monkeypatch):
    """no_key_accounts(계정명 폴백 개선 등으로 나아질 수 있음)와 dart_status_013
    (다음 회계연도엔 보고서가 올라올 수 있음)은 corp_code_not_found와 달리
    확정적 실패가 아니므로 그냥 두면 30일 뒤 자연히 재시도된다 — 여기서 캐싱하면
    안 된다.
    """
    db = _CountingDB()
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    _patch(monkeypatch, db, stale=["005940"], extract=lambda _s: None)
    monkeypatch.setattr(
        fundamentals.dart_fundamentals, "extract",
        lambda ticker, year, **kw: (None, "no_key_accounts"),
    )

    refresh_fundamentals(db, "KR", ["005940"], TODAY)

    saved = [r for chunk in db.saves for r in chunk]
    assert saved == []


def test_reason_detail_is_bucketed_separately_from_the_count_key(monkeypatch, capsys):
    """no_key_accounts:영업수익 같은 상세 사유는 개수 집계에서 콜론 앞부분으로만
    묶여야 한다 — 안 그러면 티커마다 계정명이 달라 집계가 잘게 쪼개진다.
    상세는 예시 문자열에만 남는다.
    """
    db = _CountingDB()
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    _patch(monkeypatch, db, stale=["A", "B"], extract=lambda _s: None)

    reasons = {"A": "no_key_accounts:이자수익", "B": "no_key_accounts:보험료수익"}
    monkeypatch.setattr(
        fundamentals.dart_fundamentals, "extract",
        lambda ticker, year, **kw: (None, reasons[ticker]),
    )

    refresh_fundamentals(db, "KR", ["A", "B"], TODAY)

    out = capsys.readouterr().out
    assert "no_key_accounts=2" in out  # 상세가 달라도 개수는 하나로 묶임
    assert "A[이자수익]" in out
    assert "B[보험료수익]" in out


def test_kr_extract_receives_name_maps_for_preferred_stock_fallback(monkeypatch):
    """main.py가 넘긴 이름 매핑이 그대로 dart_fundamentals.extract까지 전달돼야
    우선주 폴백이 동작한다.
    """
    db = _CountingDB()
    monkeypatch.setenv("DART_API_KEY", "dummy-key")
    _patch(monkeypatch, db, stale=["005385"], extract=lambda _s: None)

    seen_kwargs = {}

    def fake_extract(ticker, year, **kwargs):
        seen_kwargs.update(kwargs)
        return {"revenue_latest": 1.0}, "ok_via_common_stock"

    monkeypatch.setattr(fundamentals.dart_fundamentals, "extract", fake_extract)

    refresh_fundamentals(
        db, "KR", ["005385"], TODAY,
        ticker_to_name={"005385": "현대차우"},
        name_to_ticker={"현대차": "005380"},
    )

    assert seen_kwargs == {"name": "현대차우", "name_to_ticker": {"현대차": "005380"}}


# ── 미장 비교 구간 — 국장(2년)과 맞추기 ────────────────────────────────
# 판정 임계값(REVENUE_DROP 20% / PROFIT_DROP 30%)은 구간 길이를 보지 않고 두 시장에
# 똑같이 적용된다. 미장만 3~4년 구간을 쓰면 같은 배지가 시장마다 다른 뜻이 된다 —
# 2년간 -20%는 연 -10.6%인데 4년간 -20%는 연 -5.4%라 미국이 2배 관대해진다.

def _income_stmt(years: list[int]) -> pd.DataFrame:
    """yfinance income_stmt 모양 — 열이 회계연도 Timestamp, 최신이 먼저."""
    cols = [pd.Timestamp(f"{y}-12-31") for y in years]
    return pd.DataFrame(
        [[float(y) for y in years]],  # 값은 연도로 둬서 어느 열이 뽑혔는지 바로 보이게
        index=["Total Revenue"],
        columns=cols,
    )


def test_prior_column_is_exactly_two_years_back_when_available():
    inc = _income_stmt([2025, 2024, 2023, 2022])
    prior = fundamentals._pick_prior_column(inc.columns, inc.columns[0])
    assert pd.Timestamp(prior).year == 2023  # 가장 오래된 2022가 아니라 2년 전


def test_prior_column_falls_back_to_oldest_when_two_years_back_is_missing():
    # 상장이 짧아 2년 전 열이 없으면 비교를 포기하지 않고 가장 먼 열을 쓴다
    inc = _income_stmt([2025, 2024])
    prior = fundamentals._pick_prior_column(inc.columns, inc.columns[0])
    assert pd.Timestamp(prior).year == 2024


def test_prior_column_is_none_when_only_one_year_exists():
    inc = _income_stmt([2025])
    assert fundamentals._pick_prior_column(inc.columns, inc.columns[0]) is None


def test_prior_column_handles_non_contiguous_fiscal_years():
    # 결측 연도가 있어도 정확히 2년 전이 있으면 그걸 고른다
    inc = _income_stmt([2025, 2023, 2020])
    prior = fundamentals._pick_prior_column(inc.columns, inc.columns[0])
    assert pd.Timestamp(prior).year == 2023
