"""저점 매집 후보(Gold Standard 패턴) 스코어러 테스트.

거래량 트리거 판정에 집중한다 — 화면의 ⚡ 배지가 이 값 하나로 갈리는데,
예전에는 거래량만 보고 봉의 방향을 안 봐서 투매(대량거래 장대음봉)와 반등
신호를 구분하지 못했다.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline.src.pattern_discovery import (
    DOJI_BODY_RATIO,
    VOL_TRIGGER_MULTIPLIER,
    _is_volume_trigger_today,
    compute_pattern_matches,
)


def _bars(
    n: int = 100,
    *,
    last_open: float,
    last_high: float,
    last_low: float,
    last_close: float,
    last_vol: float,
    baseline_vol: float = 1_000.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """마지막 봉만 지정하고 앞은 평범한 봉으로 채운 배열 묶음."""
    open_ = np.full(n, 10.0)
    high = np.full(n, 10.5)
    low = np.full(n, 9.5)
    close = np.full(n, 10.0)
    vol = np.full(n, baseline_vol)

    open_[-1], high[-1], low[-1], close[-1], vol[-1] = (
        last_open, last_high, last_low, last_close, last_vol,
    )
    return open_, high, low, close, vol


def test_거래량_급증_양봉이면_트리거():
    args = _bars(last_open=10.0, last_high=11.0, last_low=9.9, last_close=10.8, last_vol=3_000)
    assert _is_volume_trigger_today(*args) is True


def test_거래량_급증_음봉이면_트리거_아님():
    """책의 거래량 8원칙 2번: 거래량 증가 + 장대음봉 = 매물. 매수 신호가 아니다."""
    args = _bars(last_open=10.8, last_high=11.0, last_low=9.0, last_close=9.2, last_vol=3_000)
    assert _is_volume_trigger_today(*args) is False


def test_거래량_급증_십자형이면_트리거():
    """대량거래인데 몸통이 거의 없는 봉 — 책은 큰 폭 하락 후 십자형을 매수 신호로 본다."""
    # 몸통 0.02 / 전체폭 1.0 = 2% ≤ DOJI_BODY_RATIO(10%)
    args = _bars(last_open=10.0, last_high=10.5, last_low=9.5, last_close=9.98, last_vol=3_000)
    assert abs(9.98 - 10.0) / (10.5 - 9.5) <= DOJI_BODY_RATIO
    assert _is_volume_trigger_today(*args) is True


def test_몸통이_도지_기준을_넘는_음봉은_트리거_아님():
    # 몸통 0.3 / 전체폭 1.0 = 30% > 10%
    args = _bars(last_open=10.0, last_high=10.5, last_low=9.5, last_close=9.7, last_vol=3_000)
    assert _is_volume_trigger_today(*args) is False


def test_거래량이_안_터지면_양봉이어도_트리거_아님():
    args = _bars(last_open=10.0, last_high=11.0, last_low=9.9, last_close=10.8, last_vol=1_100)
    assert 1_100 < 1_000 * VOL_TRIGGER_MULTIPLIER
    assert _is_volume_trigger_today(*args) is False


def test_고가와_저가가_같은_봉은_트리거_아님():
    """하루 내내 가격이 안 움직인 봉 — 싸움 자체가 없었으므로 십자형으로 세지 않는다."""
    args = _bars(last_open=10.0, last_high=10.0, last_low=10.0, last_close=10.0, last_vol=3_000)
    assert _is_volume_trigger_today(*args) is False


def _bottom_history(*, last_open: float, last_close: float, last_vol: float) -> pd.DataFrame:
    """하드 필터를 넉넉히 통과하는 바닥 패턴 일봉.

    52주 고점 20 → 현재 6 근처(하락률 약 70% ≥ 55%), 최저 종가는 70봉 전이라
    저점 갱신 중단 69일 ≥ 15일. 점수가 MIN_SCORE 경계에 걸리지 않게 두 값 모두
    기준보다 크게 잡았다 — 경계에 두면 보너스(VCP·이평) 유무로 테스트가 흔들린다.
    """
    n = 150
    close = np.full(n, 6.0)
    close[0] = 20.0          # 52주 고점
    close[-70] = 5.0         # 가장 최근 저점
    high = close + 0.3
    low = close - 0.3
    open_ = close.copy()

    open_[-1] = last_open
    close[-1] = last_close
    high[-1] = max(last_open, last_close) + 0.3
    low[-1] = min(last_open, last_close) - 0.3

    vol = np.full(n, 100_000.0)
    vol[-1] = last_vol

    return pd.DataFrame(
        {"Open": open_, "High": high, "Low": low, "Close": close, "Volume": vol},
        index=pd.date_range("2026-01-01", periods=n, freq="B"),
    )


def _universe() -> pd.DataFrame:
    return pd.DataFrame([{"ticker": "TEST", "name": "Test Co", "sector": "Technology"}])


def test_추천_결과에_집계용_원본_수치가_담긴다():
    """matched_bottom은 사람이 읽는 문자열이라 성적 집계에 못 쓴다 — 원본 수치가 따로 있어야 한다."""
    hist = _bottom_history(last_open=6.0, last_close=6.2, last_vol=100_000)
    matches = compute_pattern_matches({"TEST": hist}, _universe())

    assert len(matches) == 1
    m = matches[0]
    assert m["drawdown_pct"] > 55
    assert m["days_since_low"] >= 15
    assert isinstance(m["vol_ratio"], float)
    assert isinstance(m["vcp"], bool)
    assert isinstance(m["ma_align"], bool)
    assert isinstance(m["higher_low"], bool)


def test_대량거래_음봉_종목은_배지가_안_붙는다():
    """같은 거래량이라도 봉 방향에 따라 volume_triggered가 갈린다."""
    up = compute_pattern_matches(
        {"TEST": _bottom_history(last_open=6.0, last_close=6.5, last_vol=1_000_000)}, _universe()
    )
    down = compute_pattern_matches(
        {"TEST": _bottom_history(last_open=6.5, last_close=5.8, last_vol=1_000_000)}, _universe()
    )

    assert up[0]["volume_triggered"] is True
    assert down[0]["volume_triggered"] is False


def test_시가가_전부_종가와_같으면_트리거를_끈다():
    """시가 칸이 없는 소스를 종가로 메운 경우 — 모든 대량거래일이 십자형으로 잡히면 안 된다."""
    hist = _bottom_history(last_open=6.0, last_close=6.0, last_vol=1_000_000)
    hist["Open"] = hist["Close"]
    matches = compute_pattern_matches({"TEST": hist}, _universe())

    assert matches[0]["volume_triggered"] is False


def test_저점_높이기는_기록만_하고_점수에는_안_들어간다():
    """관측에서는 뚜렷했지만 가산점으로 주니 선발 구성이 바뀌어 역효과였다(2026-09-14).

    되살리려면 백테스트 재검증이 먼저다 — 그냥 보너스를 더하면 이 테스트가 잡는다.
    """
    from pipeline.src import pattern_discovery
    from pipeline.src.pattern_discovery import _is_higher_low

    span = pattern_discovery.HIGHER_LOW_SPAN
    rising = np.concatenate([np.full(span, 5.0), np.full(span, 6.0)])   # 직전 5.0 → 최근 6.0
    falling = np.concatenate([np.full(span, 6.0), np.full(span, 5.0)])

    assert _is_higher_low(rising) is True
    assert _is_higher_low(np.full(2 * span, 5.0)) is False   # 같으면 미충족
    assert _is_higher_low(falling) is False
    assert _is_higher_low(np.full(2 * span - 1, 5.0)) is False  # 봉 부족

    # 점수에 더하는 상수가 없어야 한다
    assert not hasattr(pattern_discovery, "HIGHER_LOW_BONUS")
    assert not hasattr(pattern_discovery, "_higher_low_bonus_val")


def test_저점_높이기_여부가_점수를_바꾸지_않는다():
    """같은 봉인데 저점만 높인 종목이 더 높은 점수를 받으면 안 된다(기록만 하므로)."""
    from pipeline.src.pattern_discovery import _score_candidate

    n = 150
    base_close = np.full(n, 6.0)
    base_close[0] = 20.0
    base_close[-70] = 5.0
    vol = np.full(n, 100_000.0)

    def score_with(low: np.ndarray) -> float:
        ok, stats = _score_candidate(base_close + 0.3, low, base_close, vol, 20.3)
        assert ok
        return stats["score"]

    flat_low = base_close - 0.3
    rising_low = flat_low.copy()
    rising_low[-20:] += 0.2          # 최근 20봉 저점만 들어올린다

    assert score_with(rising_low) == score_with(flat_low)


def test_소진일수_커트라인은_15일이다():
    """30으로 올려봤다가 되돌린 값이다 (2026-09-14, docstring v5).

    15~29일이 유일한 마이너스 구간이라 잘라냈는데, 그 자리를 다른 나쁜 종목이
    메워서(30~44일 중간값 12.44% → 0.99%) 합격 기준을 못 넘겼다.
    다시 올리려면 백테스트 재검증이 먼저다 — 그냥 바꾸면 이 테스트가 잡는다.
    """
    from pipeline.src.pattern_discovery import EXHAUSTION_FULL_SPAN, MIN_DAYS_SINCE_LOW

    assert MIN_DAYS_SINCE_LOW == 15
    assert MIN_DAYS_SINCE_LOW + EXHAUSTION_FULL_SPAN == 60.0


def test_만점_지점은_넓게_유지한다():
    """당겨봤다가 되돌린 값 — 65%/50일로 당기면 대부분이 만점이라 줄이 안 선다."""
    from pipeline.src.pattern_discovery import (
        DRAWDOWN_FULL_SPAN,
        EXHAUSTION_FULL_SPAN,
        MIN_DAYS_SINCE_LOW,
        MIN_DRAWDOWN,
    )

    assert MIN_DRAWDOWN + DRAWDOWN_FULL_SPAN == 0.90
    assert MIN_DAYS_SINCE_LOW + EXHAUSTION_FULL_SPAN == 60.0


def test_이평_정배열_보너스는_점수에_남아_있다():
    """빼봤다가 되돌린 조건이다 (2026-09-14).

    관측만 보면 정배열 종목이 나빴지만, 실제로 빼고 재검증하니 전체가 나아지지
    않았고(순위 1~5위 중간값 0.00% → -2.25%) 다른 조건의 관측값까지 뒤집혔다.
    **다시 빼려면 백테스트 재검증이 먼저다** — 그냥 지우면 이 테스트가 잡는다.
    """
    from pipeline.src import pattern_discovery
    from pipeline.src.pattern_discovery import MA_ALIGN_BONUS, _ma_align_bonus_val

    # 값이 전부 같으면 현재가 > SMA5가 성립하지 않는다 → 정배열 아님
    assert _ma_align_bonus_val(np.full(60, 10.0)) == 0.0
    # 매일 오르면 현재가 > SMA5 > SMA10 > SMA20
    assert _ma_align_bonus_val(np.arange(60, dtype=float)) == MA_ALIGN_BONUS
    # 20봉이 안 되면 판정하지 않는다
    assert _ma_align_bonus_val(np.full(pattern_discovery.MA_SHORT3 - 1, 10.0)) == 0.0


def test_정배열이면_점수가_실제로_올라간다():
    """상수만 남고 채점에서 빠지는 일이 없도록 `_score_candidate`까지 확인한다."""
    from pipeline.src.pattern_discovery import MA_ALIGN_BONUS, _score_candidate

    n = 150
    close = np.full(n, 6.0)
    close[0] = 20.0
    close[-70] = 5.0
    vol = np.full(n, 100_000.0)

    ok_flat, flat = _score_candidate(close + 0.3, close - 0.3, close, vol, 20.3)

    aligned = close.copy()
    aligned[-20:] = np.linspace(5.9, 6.0, 20)   # 최근 20봉만 우상향 → 정배열
    ok_up, up = _score_candidate(aligned + 0.3, aligned - 0.3, aligned, vol, 20.3)

    assert ok_flat and ok_up
    assert flat["ma_align"] is False
    assert up["ma_align"] is True
    assert up["score"] == flat["score"] + MA_ALIGN_BONUS
