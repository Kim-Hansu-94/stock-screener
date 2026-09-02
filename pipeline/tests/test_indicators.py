import pandas as pd
import numpy as np
import pytest

from pipeline.src.indicators import atr, sma, rsi, is_trending_up, volume_ratio


def test_sma_computes_rolling_mean():
    series = pd.Series([1, 2, 3, 4, 5])
    result = sma(series, window=2)
    assert result.iloc[-1] == pytest.approx(4.5)
    assert pd.isna(result.iloc[0])


def test_rsi_is_100_when_all_gains():
    series = pd.Series(range(1, 21))  # steadily increasing, no losses
    result = rsi(series, window=14)
    assert result.iloc[-1] == pytest.approx(100.0)


def test_rsi_is_0_when_all_losses():
    series = pd.Series(range(20, 0, -1))  # steadily decreasing, no gains
    result = rsi(series, window=14)
    assert result.iloc[-1] == pytest.approx(0.0)


def test_is_trending_up_true_when_ma_higher_than_lookback():
    ma_series = pd.Series([1, 2, 3, 4, 5, 6, 7])
    assert is_trending_up(ma_series, lookback=5) is True


def test_is_trending_up_false_when_ma_lower_than_lookback():
    ma_series = pd.Series([7, 6, 5, 4, 3, 2, 1])
    assert is_trending_up(ma_series, lookback=5) is False


def test_is_trending_up_false_when_not_enough_history():
    ma_series = pd.Series([1, 2, 3])
    assert is_trending_up(ma_series, lookback=5) is False


def test_volume_ratio_below_one_when_recent_volume_lower():
    volume = pd.Series([100.0] * 20 + [50.0] * 5)
    result = volume_ratio(volume, recent_window=5, baseline_window=20)
    assert result == pytest.approx(0.5)


def test_volume_ratio_above_one_when_recent_volume_higher():
    volume = pd.Series([100.0] * 20 + [150.0] * 5)
    result = volume_ratio(volume, recent_window=5, baseline_window=20)
    assert result == pytest.approx(1.5)


def test_atr_averages_true_range_over_window():
    # Constant close so true range == high-low every bar (no close-to-close gap).
    close = pd.Series([100.0] * 20)
    high = close + 2.0
    low = close - 2.0
    result = atr(high, low, close, window=14)
    assert result.iloc[-1] == pytest.approx(4.0)


def test_atr_picks_up_gap_when_wider_than_the_bar_range():
    # A gap-up day: yesterday's close is far below today's low, so true range should
    # be the gap distance, not the (narrow) high-low range.
    close = pd.Series([100.0] * 13 + [130.0])
    high = pd.Series([101.0] * 13 + [131.0])
    low = pd.Series([99.0] * 13 + [129.0])
    result = atr(high, low, close, window=14)
    # 13 quiet bars with TR=2, plus the gap day with TR=|131-100|=31
    expected = (2.0 * 13 + 31.0) / 14
    assert result.iloc[-1] == pytest.approx(expected)


def test_atr_is_nan_before_window_fills():
    close = pd.Series([100.0] * 5)
    high = close + 1
    low = close - 1
    result = atr(high, low, close, window=14)
    assert pd.isna(result.iloc[-1])
