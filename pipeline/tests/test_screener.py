import numpy as np
import pandas as pd

from pipeline.src.screener import (
    CRITERION_BOUNCE,
    CRITERION_IMPULSE,
    CRITERION_PULLBACK_DEPTH,
    CRITERION_RSI_RISING,
    CRITERION_VOLATILITY,
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
    buf: float = 1.0,
) -> Bars:
    """Trough on day 2, then a genuine recovery into days 3-5.

    ``recovery_frac`` controls how much of ``total_drop`` the final close recovers —
    the 50% 룰 needs it >= 0.5 to confirm a bounce (see screener.BOUNCE_LOOKBACK).
    ``final_open_gap`` sets that day's open below its close (bullish) by default;
    pass a negative value to make it bearish for the "no bounce" tests.
    ``buf`` is the uniform high/low spread around each day's close (default ±1) —
    widening it raises ATR (CRITERION_VOLATILITY) without moving the close series,
    so it isolates the volatility condition from every other one (the 50% 룰 bounce
    threshold is buffer-invariant: it cancels out algebraically, see screener.py).
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
    high = close + buf
    low = close - buf
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


# ── 변동성 과다 (온투이노베이션 2026-08-26 사례로 발견) ──────────────────
#
# 눌림목 조건 8개(추세·눌림구간·RSI·거래량·임팩트·반등)는 전부 "가격이 어디 있는가"만
# 볼 뿐, 그 종목이 하루에 얼마나 흔들리는지는 보지 않았다. 실제로 이 조건을 전부
# 통과한 종목이 ATR이 지나치게 커서 손절이 진입가의 -24.9%까지 벌어진 채로 화면에
# 뜬 적이 있다. 아래는 buf(고가/저가 스프레드)만 넓혀 ATR14/종가 비율을 10% 위로
# 올린 것 — 종가는 그대로라 다른 조건에는 영향이 없다(50% 룰 반등 기준선은
# 버퍼가 상쇄되어 buf에 무관하다).

def test_fails_when_volatility_too_high():
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME, buf=10.0,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_evaluate_labels_volatility_failure_only():
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME, buf=10.0,
    )
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert ev.passed is False
    assert ev.failed == [CRITERION_VOLATILITY]


def test_passes_with_mild_volatility_under_threshold():
    # buf=5는 여전히 10% 문턱 아래라 정상 통과해야 한다 (과도한 필터링이 아님을 확인)
    close, volume, high, low, open_ = _uptrend_with_recovering_pullback(
        drop_pct=0.10, volume_pullback=BOUNCE_VOLUME, buf=5.0,
    )
    assert passes_pullback_filter(close, volume, high, low, open_) is True


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


def _spike_then_deep_pullback() -> Bars:
    """60일 구간 안에서 급등(130→280) 후 저점(154)까지 급락, 이후 부분 회복.

    최종 되돌림이 53.3%로 MAX_PULLBACK_RETRACEMENT(0.5)를 넘어 조정 과다에 걸린다.
    급락 자체가 RSI·임팩트도 함께 흔들어(RSI 하락/선행 상승 부족) 이 조건만 단독으로
    분리하긴 어렵다 — 세 조건이 같이 실패하는 걸 그대로 검증한다.
    """
    total_len, spike_start, spike_peak_pos = 100, 20, 50
    peak_val, trough_pos, trough_val = 280.0, 60, 154.0
    recov_end_val, final_close = 224.0, 212.8
    final_tail = [
        recov_end_val * 0.99, recov_end_val * 0.985, recov_end_val * 0.99,
        recov_end_val * 0.995, final_close,
    ]

    close = np.zeros(total_len)
    close[:spike_start] = np.linspace(100, 130, spike_start)
    close[spike_start:spike_peak_pos] = np.linspace(130, peak_val, spike_peak_pos - spike_start)
    close[spike_peak_pos:trough_pos] = np.linspace(peak_val, trough_val, trough_pos - spike_peak_pos)
    recov_len = total_len - trough_pos - len(final_tail)
    close[trough_pos:trough_pos + recov_len] = np.linspace(trough_val, recov_end_val, recov_len)
    close[trough_pos + recov_len:] = final_tail

    close = pd.Series(close)
    volume = pd.Series([1_000_000.0] * (total_len - 5) + [600_000, 550_000, 500_000, 480_000, 1_000_000.0])
    high = close + 1
    low = close - 1
    open_ = close.copy()
    open_.iloc[-1] = close.iloc[-1] - 0.5
    return close, volume, high, low, open_


def test_fails_when_pullback_retraces_more_than_half_of_impulse():
    close, volume, high, low, open_ = _spike_then_deep_pullback()
    assert passes_pullback_filter(close, volume, high, low, open_) is False


def test_evaluate_labels_pullback_depth_failure():
    close, volume, high, low, open_ = _spike_then_deep_pullback()
    ev = evaluate_pullback(close, volume, high, low, open_)
    assert ev is not None
    assert ev.passed is False
    assert CRITERION_PULLBACK_DEPTH in ev.failed
