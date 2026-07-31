from pipeline.src.split_guard import detect_adjusted


class _Query:
    """supabase-py 체이닝을 흉내내는 최소 스텁."""

    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def in_(self, *_a, **_k):
        return self

    def gte(self, *_a, **_k):
        return self

    def lte(self, *_a, **_k):
        return self

    def range(self, start, end):
        self._slice = (start, end)
        return self

    def execute(self):
        if isinstance(self._rows, Exception):
            raise self._rows
        start, end = getattr(self, "_slice", (0, 999))
        return type("R", (), {"data": self._rows[start : end + 1]})()


class _FakeDB:
    def __init__(self, stored):
        self.client = type("C", (), {"table": lambda _s, _n: _Query(stored)})()


def _row(ticker: str, date: str, close: float) -> dict:
    return {"ticker": ticker, "market": "KR", "date": date, "close": close}


def test_detects_a_ten_for_one_split():
    # 저장분은 분할 전 200,000, 새로 받은 같은 날짜는 조정된 20,000
    stored = [{"ticker": "005930", "date": "2026-07-20", "close": 200000.0}]
    incoming = [_row("005930", "2026-07-20", 20000.0), _row("005930", "2026-07-21", 20500.0)]

    assert detect_adjusted(_FakeDB(stored), "KR", incoming) == ["005930"]


def test_ignores_rounding_level_differences():
    # 소수점 반올림 수준(0.05%)의 차이는 조정이 아니다
    stored = [{"ticker": "AAPL", "date": "2026-07-20", "close": 200.0}]
    incoming = [_row("AAPL", "2026-07-20", 200.1)]

    assert detect_adjusted(_FakeDB(stored), "KR", incoming) == []


def test_ignores_tickers_with_no_stored_overlap():
    # 겹치는 날짜가 없으면 비교할 근거가 없으므로 조정으로 단정하지 않는다
    stored = [{"ticker": "AAA", "date": "2026-01-02", "close": 100.0}]
    incoming = [_row("AAA", "2026-07-20", 10.0)]

    assert detect_adjusted(_FakeDB(stored), "KR", incoming) == []


def test_compares_against_the_oldest_incoming_bar():
    # 티커별로 가장 오래된 날짜를 기준 삼아야 저장분과 겹칠 가능성이 크다
    stored = [{"ticker": "BBB", "date": "2026-07-18", "close": 100.0}]
    incoming = [_row("BBB", "2026-07-19", 50.0), _row("BBB", "2026-07-18", 50.0)]

    assert detect_adjusted(_FakeDB(stored), "KR", incoming) == ["BBB"]


def test_returns_empty_when_the_lookup_fails():
    # 감지는 보호 장치일 뿐이라, 조회 실패가 수집을 막아서는 안 된다
    assert detect_adjusted(_FakeDB(RuntimeError("db down")), "KR", [_row("AAA", "2026-07-20", 1.0)]) == []


def test_handles_empty_input():
    assert detect_adjusted(_FakeDB([]), "KR", []) == []
