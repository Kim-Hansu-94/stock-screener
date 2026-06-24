import numpy as np
import pandas as pd

from pipeline.src.market_regime import determine_market_regime


def test_bull_when_close_above_sma50_above_sma200():
    close = pd.Series(100 + np.linspace(0, 100, 250))
    assert determine_market_regime(close) == "bull"


def test_bear_when_downtrend():
    close = pd.Series(200 - np.linspace(0, 100, 250))
    assert determine_market_regime(close) == "bear"


def test_bear_when_not_enough_history_for_sma200():
    close = pd.Series(100 + np.linspace(0, 10, 100))
    assert determine_market_regime(close) == "bear"
