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


def test_bull_even_when_close_dips_below_sma50_during_shallow_pullback():
    # 장기 추세(SMA50 > SMA200)는 살아있는데 최근 며칠 조정으로 종가가
    # SMA50 아래로 잠깐 내려간 경우 — 눌림목 스크리너가 정작 필요한 국면이므로
    # 게이트가 꺼지면 안 된다.
    uptrend = 100 + np.linspace(0, 100, 250)
    close = pd.Series(uptrend)
    close.iloc[-3:] -= 20  # 최근 3거래일 급락으로 SMA50 아래로 이탈
    assert close.iloc[-1] < close.rolling(50).mean().iloc[-1]
    assert determine_market_regime(close) == "bull"
