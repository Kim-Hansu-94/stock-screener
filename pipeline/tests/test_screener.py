import numpy as np
import pandas as pd

from pipeline.src.screener import (
    CRITERION_BOUNCE,
    CRITERION_IMPULSE,
    CRITERION_RSI_RISING,
    CRITERION_VOLUME,
    evaluate_pullback,
    passes_pullback_filter,
)

N_UP_DAYS = 95

Bars = tuple[pd.Series, pd.Series, pd.Series, pd.Series, pd.Series]  # close, volume, high, low, open


def _uptrend_with_pullback(drop_pct: float, volume_pullback) -> Bars:
    # Steep uptrend (100→200) so avg gains are large enough for RSI to sit in 40-55
    # after a meaningful pullback that still keeps price between sma10 and sma20
    base = 100 + np.linspace(0, 100, N_UP_DAYS)
    peak = base[-1]
    total_drop = peak * drop_pct
    pullback_days = [
        peak - total_drop * 0.3,
        peak - total_drop * 0.55,
        peak - total_drop * 0.75,
        peak - total_drop * 0.9,
        peak - total_drop,
    ]
    close = pd.Series(list(base) + pullback_days)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + list(volume_pullback))
    return close, volume, close + 1, close - 1, close.copy()


def _uptrend_with_recovering_pullback(
    drop_pct: float,
    volume_pullback,
    gain: float = 100.0,
    recovery_frac: float = 0.55,
    final_open_gap: float = 0.5,
) -> Bars:
    """Trough on day 2, then a genuine recovery into days 3-5.

    ``recovery_frac`` controls how much of ``total_drop`` the final close recovers —
    the 50% 룰 needs it >= 0.5 to confirm a bounce (see screener.BOUNCE_LOOKBACK).
    ``final_open_gap`` sets that day's open below its close (bullish) by default;
    pass a negative value to make it bearish for the "no bounce" tests.
    """
    base = 100 + np.linspace(0, gain, N_UP_DAYS)
    peak = base[-1]
    total_drop = peak * drop_pct
    trough = peak - total_drop
    pullback_days = [
        peak - total_drop * 0.5,
        trough,
        trough + total_drop * 0.2,
        trough + total_drop * 0.4,
        trough + total_drop * recovery_frac,
    ]
    close = pd.Series(list(base) + pullback_days)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + list(volume_pullback))
    high = close + 1
    low = close - 1
    open_ = close.copy()
    open_.iloc[-1] = close.iloc[-1] - final_open_gap
    return close, volume, high, low, open_


# 반등일 거래량 — 직전 20일 평균(우상향 구간의 1,000,000 다수 + 눌림 4일)보다는 높지만,
# 5일 평균이 20일 기준선의 65% 밑으로는 유지되도록 조정된 값(거래량 미감소 조건과 공존).
BOUNCE_VOLUME = [600_000, 550_000, 500_000, 480_000, 1_000_000]


def test_passes_when_healthy_pullback_in_uptrend():
    # 10% 조정 후 절반 이상(55%) 회복 + 거래량 증가 + 양봉 → 50% 룰 반등 확인 통과
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is True


def test_fails_when_rsi_too_low_oversold():
    close, volume, high, low, open_ = _uptrend_with_pullback(
        drop_pct=0.07,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_no_pullback_rsi_too_high():
    close, volume, high, low, open_ = _uptrend_with_pullback(
        drop_pct=0.005,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_volume_increasing_during_pullback():
    # same shape as the "passes" test so only volume blocks it
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10,
        volume_pullback=[1_200_000, 1_250_000, 1_300_000, 1_350_000, 1_400_000],
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_recovery_under_half():
    # 조정폭의 30%만 회복 — 50% 룰 미달
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME, recovery_frac=0.3,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_bounce_day_has_no_volume_increase():
    # 회복은 절반을 넘지만, 반등일 거래량이 직전 평균보다 낮음
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 400_000],
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_bounce_day_is_bearish():
    # 회복·거래량은 충족하지만 반등일이 음봉(시가 > 종가) — 거래량 늘고 음봉이면
    # 매매의 기술 매도 제2원칙에 해당하는 정황이라 반등으로 인정하지 않는다
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME, final_open_gap=-0.5,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_no_prior_impulse():
    # shallow uptrend: 60-day return ~6%, below the +15% impulse threshold, while
    # every other condition (zone, RSI, volume, bounce) still passes
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.02,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
        gain=12.0,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_fails_when_long_term_trend_is_down():
    base_down = 140 - np.linspace(0, 40, N_UP_DAYS)
    peak = base_down[-1]
    down_tail = [peak - 0.5, peak - 1.0, peak - 1.3, peak - 1.5, peak - 1.6]
    close = pd.Series(list(base_down) + down_tail)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + [600_000, 550_000, 500_000, 480_000, 450_000])
    assert passes_pullback_filter(close, volume, close.copy(), close.copy(), close.copy()) is False


def test_fails_when_not_enough_history():
    close = pd.Series(100 + np.linspace(0, 10, 50))
    volume = pd.Series([1_000_000.0] * 50)
    assert passes_pullback_filter(close, volume, close.copy(), close.copy(), close.copy()) is False


# ---- evaluate_pullback: 조건별 실패 라벨 (랭킹 표시용) ----

def test_evaluate_full_pass_has_no_failures():
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME,
    )
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert ev.passed is True
    assert ev.failed == []
    assert ev.impulse_gain >= 0.15


def test_evaluate_labels_volume_failure_only():
    # "passes" 케이스와 같은 가격 모양, 거래량만 증가 → 거래량 조건 하나만 미달
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10,
        volume_pullback=[1_200_000, 1_250_000, 1_300_000, 1_350_000, 1_400_000],
    )
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert ev.passed is False
    assert ev.failed == [CRITERION_VOLUME]


def test_evaluate_labels_rsi_direction_and_bounce_failures():
    # 단조 하락 꼬리: RSI가 3일 전보다 낮고(하락 중), 회복도 없어 50% 룰도 미달
    close, volume, high, low, open_ = _uptrend_with_pullback(
        drop_pct=0.07,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert ev.passed is False
    assert CRITERION_RSI_RISING in ev.failed
    assert CRITERION_BOUNCE in ev.failed


def test_evaluate_labels_impulse_failure():
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.02,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
        gain=12.0,
    )
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert CRITERION_IMPULSE in ev.failed
    assert ev.impulse_gain < 0.15


def test_evaluate_returns_none_when_insufficient_history():
    close = pd.Series(100 + np.linspace(0, 10, 50))
    volume = pd.Series([1_000_000.0] * 50)
    assert evaluate_pullback(close, volume, close.copy(), close.copy(), close.copy()) is None
