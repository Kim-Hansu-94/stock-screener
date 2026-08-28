"""backtest_kr_supply.py의 순수 계산 검증.

네트워크(KRX)가 필요한 수집 함수는 여기서 다루지 않는다 — 여기서 지키려는 건
"미래 데이터가 새지 않는가"와 "수급 비율 계산이 맞는가" 두 가지다.
"""

import numpy as np
import pandas as pd
import pytest

from pipeline.research.backtest_kr_supply import (
    TRAILING_BARS,
    classify_supply,
    supply_ratio,
    trailing_window,
)
from pipeline.src.screener import evaluate_pullback


def _synthetic_ohlcv(n: int = 600, seed: int = 7) -> pd.DataFrame:
    """상승 추세 + 잔물결이 섞인 합성 일봉. 신호가 걸리든 안 걸리든
    '전체 이력'과 '트레일링 윈도우'의 판정이 같은지만 보면 되므로 모양은 자유롭다."""
    rng = np.random.default_rng(seed)
    drift = np.linspace(100, 260, n)
    noise = rng.normal(0, 3, n).cumsum() * 0.3
    close = pd.Series(drift + noise).clip(lower=1.0)
    high = close * (1 + rng.uniform(0.001, 0.02, n))
    low = close * (1 - rng.uniform(0.001, 0.02, n))
    volume = pd.Series(rng.uniform(5e5, 2e6, n))
    idx = pd.date_range("2023-01-02", periods=n, freq="B")
    return pd.DataFrame(
        {"close": close.values, "high": high.values, "low": low.values, "volume": volume.values},
        index=idx,
    )


class TestTrailingWindow:
    def test_never_includes_future_bars(self):
        df = _synthetic_ohlcv(TRAILING_BARS + 200)
        for end_idx in (50, TRAILING_BARS, len(df) - 1):
            w = trailing_window(df, end_idx)
            assert w.index[-1] == df.index[end_idx]
            assert len(w) <= TRAILING_BARS

    def test_short_history_is_not_padded(self):
        df = _synthetic_ohlcv(50)
        w = trailing_window(df, 10)
        assert len(w) == 11  # 0..10, 앞을 지어내지 않는다

    def test_matches_full_history_verdict(self):
        """핵심 테스트 — 속도를 위해 이력을 잘랐는데 판정이 달라지면 백테스트가 통째로 거짓말이 된다.

        SMA200·임팩트(61봉) 참조를 다 덮는 길이로 자르므로 통과 여부와 미달 조건
        목록이 전체 이력을 넘겼을 때와 완전히 같아야 한다."""
        df = _synthetic_ohlcv(600)
        checked = 0
        for end_idx in range(TRAILING_BARS + 5, len(df), 17):
            full = df.iloc[: end_idx + 1]
            win = trailing_window(df, end_idx)

            ev_full = evaluate_pullback(
                full["close"], full["volume"], full["high"], require_sma200=True
            )
            ev_win = evaluate_pullback(
                win["close"], win["volume"], win["high"], require_sma200=True
            )

            assert (ev_full is None) == (ev_win is None)
            if ev_full is not None:
                assert ev_full.passed == ev_win.passed
                assert sorted(ev_full.failed) == sorted(ev_win.failed)
                assert ev_full.impulse_gain == pytest.approx(ev_win.impulse_gain)
            checked += 1
        assert checked > 10, "표본이 너무 적어 파리티를 확인했다고 볼 수 없다"


class TestSupplyRatio:
    def _series(self, inst, foreign, value):
        return pd.Series(inst, dtype=float), pd.Series(foreign, dtype=float), pd.Series(value, dtype=float)

    def test_sums_both_investor_types_over_window(self):
        inst, foreign, value = self._series([10, 10, 10, 10], [5, 5, 5, 5], [100, 100, 100, 100])
        # 마지막 2일: (10+10)+(5+5)=30, 거래대금 200 → 0.15
        assert supply_ratio(inst, foreign, value, end_idx=3, window=2) == pytest.approx(0.15)

    def test_net_selling_gives_negative_ratio(self):
        inst, foreign, value = self._series([-30, -30], [-10, -10], [200, 200])
        assert supply_ratio(inst, foreign, value, end_idx=1, window=2) == pytest.approx(-0.2)

    def test_excludes_bars_after_end_idx(self):
        """신호일 이후 수급이 섞이면 미래를 보는 셈이 된다."""
        inst, foreign, value = self._series([10, 10, 999], [0, 0, 999], [100, 100, 100])
        assert supply_ratio(inst, foreign, value, end_idx=1, window=2) == pytest.approx(0.1)

    def test_none_when_window_exceeds_history(self):
        inst, foreign, value = self._series([10, 10], [0, 0], [100, 100])
        assert supply_ratio(inst, foreign, value, end_idx=1, window=20) is None

    def test_none_when_no_trading_value(self):
        """거래정지 등으로 거래대금이 0이면 0으로 나누는 대신 '모름'."""
        inst, foreign, value = self._series([0, 0], [0, 0], [0, 0])
        assert supply_ratio(inst, foreign, value, end_idx=1, window=2) is None


class TestClassifySupply:
    def test_buckets(self):
        assert classify_supply(0.05, threshold=0.0) == "양호"
        assert classify_supply(-0.05, threshold=0.0) == "불량"
        assert classify_supply(0.0, threshold=0.0) == "양호"  # 경계는 양호 쪽

    def test_unknown_is_its_own_bucket(self):
        """모르는 걸 '불량'으로 밀면 불량 버킷 성적이 오염된다."""
        assert classify_supply(None) == "정보없음"
