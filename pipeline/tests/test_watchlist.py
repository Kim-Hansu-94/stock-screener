import re
from datetime import date

from pipeline.src import watchlist as watchlist_module
from pipeline.src.watchlist import BOX_WINDOW, MIN_BARS, detect_box_breakout, evaluate_watch


def _bar(i: int, close: float, spread: float = 1.0, volume: float = 1000.0) -> dict:
    return {
        "date": f"D{i:04d}",
        "open": close,
        "high": close + spread / 2,
        "low": close - spread / 2,
        "close": close,
        "volume": volume,
    }


def _base_forming_bars() -> list[dict]:
    """고점 100 → 55까지 하락 → 저점 다지며 완만히 상승하는 횡보 베이스."""
    bars: list[dict] = []
    i = 0
    # 3년 고점 구간
    for _ in range(50):
        bars.append(_bar(i, 100.0, spread=2.0))
        i += 1
    # 하락 구간: 100 → 55
    for k in range(100):
        bars.append(_bar(i, 100.0 - 0.45 * (k + 1), spread=2.0))
        i += 1
    # 횡보 베이스: 저점 55 부근에서 완만히 상승, 변동성·거래량 수축
    for k in range(250):
        close = 56.0 + min(3.0, k * 0.02)
        volume = 1000.0 if k < 210 else 600.0  # 최근 20일 거래량 소진 (직전 40일 대비 0.6)
        bars.append(_bar(i, close, spread=0.8, volume=volume))
        i += 1
    return bars


def test_insufficient_bars_reports_reason():
    bars = [_bar(i, 100.0) for i in range(MIN_BARS - 1)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert "데이터 부족" in status["reason"]


def test_free_fall_rejected_by_new_low_filter():
    # 꾸준한 하락 지속: 마지막 봉이 항상 52주 신저가 → 하드 필터 1에 걸려야 한다
    bars = [_bar(i, 300.0 - i * 0.5) for i in range(400)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert status["no_new_low"] is False
    assert "신저가" in status["reason"]


def test_shallow_drawdown_rejected_by_band():
    # 조정폭 ~10%: 횡보이긴 하나 "조정 종목" 범위(20~60%) 미달
    bars = [_bar(i, 100.0, spread=1.0) for i in range(200)]
    bars += [_bar(200 + i, 90.0, spread=1.0) for i in range(200)]
    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert status["in_drawdown_band"] is False
    assert "조정폭" in status["reason"]


def test_mid_decline_bounce_is_not_higher_lows():
    """2년 하락 중 마지막 6개월만 반등한 형태 — 1년 단위 비교로는 저점 상승이 아니다.

    프론트(opportunityScore.test.ts)의 동일 시나리오와 짝을 이룬다.
    """
    bars: list[dict] = []
    for i in range(140):
        bars.append(_bar(i, 300 - (i * 100) / 139, spread=3.0))
    for i in range(60):
        bars.append(_bar(140 + i, 200 - (i * 45) / 59, spread=2.0, volume=900.0))
    for i in range(60):
        bars.append(_bar(200 + i, 160 + (i * 30) / 59, spread=2.0, volume=700.0))

    status = evaluate_watch(bars)
    assert status["qualified"] is True, status["reason"]
    assert status["higher_lows"] is False


def test_formed_base_qualifies_with_signals():
    status = evaluate_watch(_base_forming_bars())
    assert status["qualified"] is True, status["reason"]
    assert status["in_drawdown_band"] is True
    assert status["no_new_low"] is True
    assert status["box_ok"] is True
    assert 0.0 < status["score"] <= 1.0
    assert status["higher_lows"] is True
    assert status["volume_dry"] is True


def test_wide_box_reports_actual_percentage_in_reason():
    """box_ok 미달 사유에 "30% 초과"라는 고정 문구 대신 실제 계산값이 나와야, 기준(30%)에
    얼마나 못 미쳤는지(턱걸이인지 훨씬 넓은지) 판단할 수 있다."""
    bars: list[dict] = []
    i = 0
    for _ in range(300):
        bars.append(_bar(i, 100.0, spread=1.0))
        i += 1
    for k in range(100):
        bars.append(_bar(i, 100.0 - 0.4 * (k + 1), spread=1.0))  # 100 → 60
        i += 1
    for k in range(60):
        # 최근 60일 구간 자체가 60~90을 오가는 넓은 박스 — 박스 수축 미달을 의도적으로 만든다.
        close = 90.0 if k % 2 == 0 else 60.0
        bars.append(_bar(i, close, spread=1.0))
        i += 1

    status = evaluate_watch(bars)
    assert status["qualified"] is False
    assert status["box_ok"] is False
    match = re.search(r"60일 박스폭 (\d+)% \(기준 30% 이하", status["reason"])
    assert match is not None, status["reason"]
    assert int(match.group(1)) > 30


def _flat_bars(n: int, close: float = 100.0, volume: float = 1000.0) -> list[dict]:
    return [_bar(i, close, spread=1.0, volume=volume) for i in range(n)]


def test_detect_box_breakout_needs_more_than_box_window_bars():
    bars = _flat_bars(BOX_WINDOW)
    assert detect_box_breakout(bars) is False


def test_detect_box_breakout_false_when_price_stays_inside_the_box():
    bars = _flat_bars(96)
    assert detect_box_breakout(bars) is False


def test_detect_box_breakout_true_on_price_break_with_volume_confirmation():
    bars = _flat_bars(95)
    bars.append(_bar(95, close=110.0, spread=1.0, volume=3000.0))
    assert detect_box_breakout(bars) is True


def test_detect_box_breakout_false_without_volume_confirmation():
    # 가격은 박스 상단을 뚫었지만 거래량이 평소 수준이면 아직 확인된 돌파가 아니다.
    bars = _flat_bars(95)
    bars.append(_bar(95, close=110.0, spread=1.0, volume=1000.0))
    assert detect_box_breakout(bars) is False


def test_detect_box_breakout_false_without_price_break():
    # 거래량만 터지고 박스 상단은 못 넘었으면 돌파가 아니다(예: 하락 갭에 거래량 급증).
    bars = _flat_bars(95)
    bars.append(_bar(95, close=95.0, spread=1.0, volume=3000.0))
    assert detect_box_breakout(bars) is False


class _FakeTable:
    def __init__(self, sink: list[dict]):
        self._sink = sink

    def upsert(self, payload: dict) -> "_FakeTable":
        self._sink.append(payload)
        return self

    def execute(self) -> None:
        return None


class _FakeClient:
    def __init__(self, sink: list[dict]):
        self._sink = sink

    def table(self, name: str) -> _FakeTable:
        assert name == "watchlist_status"
        return _FakeTable(self._sink)


class _FakeDB:
    """run_watchlist이 필요로 하는 최소 인터페이스만 흉내낸 테스트용 더블."""

    def __init__(self, status_rows: dict[tuple[str, str], dict]):
        self.upserts: list[dict] = []
        self.client = _FakeClient(self.upserts)
        self._status_rows = status_rows

    def get_watchlist_tickers(self) -> list[tuple[str, str, str]]:
        return []

    def prune_watchlist_status(self, keep: list[tuple[str, str]]) -> None:
        self.pruned_with = keep

    def get_watchlist_status_rows(self) -> dict[tuple[str, str], dict]:
        return self._status_rows


def test_run_watchlist_does_not_prune_when_the_list_is_empty(monkeypatch):
    """감시 목록이 비면 정리까지 건너뛴다.

    prune_watchlist_status([])는 watchlist_status를 통째로 지운다. 그런데 이
    "비었음"은 진짜 빈 것일 수도, get_watchlist_tickers가 조회에 실패해 빈 목록을
    돌려준 것일 수도 있어(그 메서드는 예외를 삼키고 []를 반환한다) 구분이 안 된다.
    예전엔 WATCHLIST 상수에 종목이 박혀 있어 이 경우가 없었지만, 상수를 비운 뒤로는
    일시적 조회 실패 한 번에 전체 평가 결과가 날아갈 수 있다.
    """
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [])

    db = _FakeDB(status_rows={})
    db.pruned_with = None
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.pruned_with is None  # prune 자체를 안 불러야 한다


def test_run_watchlist_keeps_qualified_since_while_continuously_qualified(monkeypatch):
    """분할매수 컨셉: 어제도 통과 상태였다면 매집 구간 시작일(qualified_since)이
    끊기지 않고 이어져야 한다 — 매일 새로 "오늘 처음 통과했다"로 리셋되면 안 된다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": True, "score": 0.5, "aligned_mas": False},
    )

    db = _FakeDB(status_rows={("US", "TICK"): {"qualified": True, "qualified_since": "2024-01-10"}})
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["qualified_since"] == "2024-01-10"


def test_run_watchlist_starts_new_streak_when_first_qualified(monkeypatch):
    """어제까지는 미달이었다가 오늘 처음 통과했다면 오늘 날짜로 새로 시작해야 한다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": True, "score": 0.5, "aligned_mas": False},
    )

    db = _FakeDB(status_rows={("US", "TICK"): {"qualified": False, "qualified_since": None}})
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["qualified_since"] == "2024-01-11"


def test_run_watchlist_clears_qualified_since_when_no_longer_qualified(monkeypatch):
    """매집 구간이 끊기면(오늘 미달) qualified_since는 null이어야 한다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": False, "reason": "조정폭 미달", "aligned_mas": None},
    )

    db = _FakeDB(status_rows={("US", "TICK"): {"qualified": True, "qualified_since": "2024-01-05"}})
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["qualified_since"] is None


def test_run_watchlist_keeps_aligned_since_while_continuously_aligned(monkeypatch):
    """qualified_since와 같은 방식: 어제도 정배열이었다면 aligned_since가 이어져야 한다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": True, "score": 0.5, "aligned_mas": True},
    )

    db = _FakeDB(status_rows={
        ("US", "TICK"): {
            "qualified": True, "qualified_since": "2024-01-01",
            "aligned_mas": True, "aligned_since": "2024-01-08",
        },
    })
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["aligned_since"] == "2024-01-08"


def test_run_watchlist_starts_new_aligned_streak_when_newly_aligned(monkeypatch):
    """어제까지는 정배열이 아니었다가 오늘 막 정배열이 됐다면 오늘 날짜로 시작한다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": True, "score": 0.5, "aligned_mas": True},
    )

    db = _FakeDB(status_rows={
        ("US", "TICK"): {
            "qualified": True, "qualified_since": "2024-01-01",
            "aligned_mas": False, "aligned_since": None,
        },
    })
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["aligned_since"] == "2024-01-11"


def test_run_watchlist_clears_aligned_since_when_no_longer_aligned(monkeypatch):
    """정배열이 끝나면(오늘 미충족) aligned_since는 null이어야 한다 — 안 그러면
    전환이 끝난 뒤에도 "상승 전환" 배지가 계속 떠 있게 된다."""
    monkeypatch.setattr(watchlist_module, "WATCHLIST", [("TICK", "US", "테스트종목")])
    monkeypatch.setattr(watchlist_module, "_fetch_bars", lambda db, ticker, market, today: [])
    monkeypatch.setattr(
        watchlist_module, "evaluate_watch",
        lambda bars: {"qualified": True, "score": 0.5, "aligned_mas": False},
    )

    db = _FakeDB(status_rows={
        ("US", "TICK"): {
            "qualified": True, "qualified_since": "2024-01-01",
            "aligned_mas": True, "aligned_since": "2024-01-08",
        },
    })
    watchlist_module.run_watchlist(db, date(2024, 1, 11))

    assert db.upserts[-1]["aligned_since"] is None
