import numpy as np
import pandas as pd

from pipeline.src.screener import passes_pullback_filter

N_UP_DAYS = 95


def _uptrend_with_pullback(drop_pct: float, volume_pullback) -> tuple[pd.Series, pd.Series]:
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
    return close, volume


def test_passes_when_healthy_pullback_in_uptrend():
    # 3.3% drop: price (193.4) sits just above sma20 (193.26), RSI ~59 (within 40-60)
    close, volume = _uptrend_with_pullback(
        drop_pct=0.033,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is True


def test_fails_when_rsi_too_low_oversold():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.07,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_no_pullback_rsi_too_high():
    close, volume = _uptrend_with_pullback(
        drop_pct=0.005,
        volume_pullback=[600_000, 550_000, 500_000, 480_000, 450_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_volume_increasing_during_pullback():
    # same drop_pct as the "passes" test so only volume blocks it
    close, volume = _uptrend_with_pullback(
        drop_pct=0.033,
        volume_pullback=[1_200_000, 1_250_000, 1_300_000, 1_350_000, 1_400_000],
    )
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_long_term_trend_is_down():
    base_down = 140 - np.linspace(0, 40, N_UP_DAYS)
    peak = base_down[-1]
    down_tail = [peak - 0.5, peak - 1.0, peak - 1.3, peak - 1.5, peak - 1.6]
    close = pd.Series(list(base_down) + down_tail)
    volume = pd.Series([1_000_000.0] * N_UP_DAYS + [600_000, 550_000, 500_000, 480_000, 450_000])
    assert passes_pullback_filter(close, volume) is False


def test_fails_when_not_enough_history():
    close = pd.Series(100 + np.linspace(0, 10, 50))
    volume = pd.Series([1_000_000.0] * 50)
    assert passes_pullback_filter(close, volume) is False
