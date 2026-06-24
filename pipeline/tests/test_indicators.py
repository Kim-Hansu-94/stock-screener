import pandas as pd
import numpy as np
import pytest

from pipeline.src.indicators import sma, rsi, is_trending_up, volume_ratio


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
