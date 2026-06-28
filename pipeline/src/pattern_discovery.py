"""Gold Standard 바닥 특성 기반 후보 종목 발굴 — 파이프라인 사전 계산 모듈 v2.

v2 개선 사항:
  - 하락률 기준: 5개월 고점 → 52주 최고가 (KIS 1년치 이력 직접 사용, lookback_days=380)
  - 가중치 재조정: 하락률 0.3 / 소진일수 0.4 / 거래량 0.3
  - VCP 보너스: ATR10 / ATR50 ≤ 0.6 이면 +0.10점 (변동성 압축)
  - 이평선 정배열 보너스: 현재가 > SMA5 > SMA10 > SMA20 이면 +0.10점
  - NumPy 벡터 연산으로 내부 지표 계산 최적화
  - MIN_SCORE 미달 종목 자동 드롭 후 상위 TOP_N 반환
"""
from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

# ── 튜닝 상수 (여기서 직접 조정) ────────────────────────────────────
TOP_N = 20
MIN_SCORE = 0.40

# 가격 범위
MIN_PRICE = 0.50
MAX_PRICE = 50.0

# 하드 필터 기준값
MIN_DRAWDOWN = 0.55          # 52주 최고가 대비 55% 이상 하락
MIN_DAYS_SINCE_LOW = 15      # 저점 갱신 중단 기간 ≥ 15 거래일 (매도 소진)
MIN_VOL_RATIO = 0.70         # 최근 20일 거래량 / 직전 40일 거래량 ≥ 0.70 (유지)
MIN_DOLLAR_VOL = 300_000     # 일평균 거래대금 $30만 이상 (최소 유동성)

# 복합 점수 가중치 (합산 = 1.0)
WEIGHT_DRAWDOWN = 0.3
WEIGHT_EXHAUSTION = 0.4
WEIGHT_VOLUME = 0.3

# 보너스 점수 (최종 점수는 1.0으로 상한)
VCP_ATR_SHORT = 10           # 단기 ATR 기간
VCP_ATR_LONG = 50            # 장기 ATR 기간
VCP_ATR_THRESHOLD = 0.6      # ATR_SHORT / ATR_LONG ≤ 이 값 → 변동성 수축
VCP_BONUS = 0.10

MA_SHORT1 = 5
MA_SHORT2 = 10
MA_SHORT3 = 20
MA_ALIGN_BONUS = 0.10        # 현재가 > SMA5 > SMA10 > SMA20

VOL_TRIGGER_MULTIPLIER = 2.0  # 오늘 거래량이 90일 평균 2배 이상 → 거래량 트리거


# ── 기술 지표 (NumPy 벡터 연산) ─────────────────────────────────────

def _true_range(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    prev_close = np.empty_like(close)
    prev_close[0] = close[0]
    prev_close[1:] = close[:-1]
    return np.maximum(
        high - low,
        np.maximum(np.abs(high - prev_close), np.abs(low - prev_close)),
    )


def _vcp_bonus_val(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> float:
    if len(close) < VCP_ATR_LONG + 1:
        return 0.0
    tr = _true_range(high, low, close)
    atr_short = tr[-VCP_ATR_SHORT:].mean()
    atr_long = tr[-VCP_ATR_LONG:].mean()
    return VCP_BONUS if (atr_long > 0 and atr_short / atr_long <= VCP_ATR_THRESHOLD) else 0.0


def _ma_align_bonus_val(close: np.ndarray) -> float:
    if len(close) < MA_SHORT3:
        return 0.0
    sma5 = close[-MA_SHORT1:].mean()
    sma10 = close[-MA_SHORT2:].mean()
    sma20 = close[-MA_SHORT3:].mean()
    return MA_ALIGN_BONUS if (close[-1] > sma5 > sma10 > sma20) else 0.0


def _is_volume_trigger_today(vol: np.ndarray) -> bool:
    if len(vol) < 2:
        return False
    n = min(90, len(vol) - 1)
    baseline = vol[-n - 1 : -1].mean()
    return bool(baseline > 0 and vol[-1] >= baseline * VOL_TRIGGER_MULTIPLIER)


# ── 핵심 스코어링 ───────────────────────────────────────────────────

def _score_candidate(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    vol: np.ndarray,
    high_52w: float,
) -> tuple[bool, dict]:
    """룰 기반 복합 스코어. 하드 필터 미충족 시 (False, {}) 반환."""
    if len(close) < 30:
        return False, {}

    current = float(close[-1])

    # 가격 범위
    if not (MIN_PRICE <= current <= MAX_PRICE):
        return False, {}

    # KIS 1년치 이력에서 계산된 52주 최고가 기준 하락률
    ref_high = high_52w if high_52w > 0 else float(high.max())
    drawdown = (ref_high - current) / ref_high if ref_high > 0 else 0.0
    if drawdown < MIN_DRAWDOWN:
        return False, {}

    # 저점 갱신 중단일 수 — reversed 배열에서 최소값 첫 인덱스 = 가장 최근 저점
    low_val = float(close.min())
    rev_indices = np.where(close[::-1] == low_val)[0]
    if len(rev_indices) == 0:
        return False, {}
    days_since_low = int(rev_indices[0])
    if days_since_low < MIN_DAYS_SINCE_LOW:
        return False, {}

    # 거래량 유지 비율
    n = len(vol)
    if n >= 61:
        recent_vol = vol[-20:].mean()
        baseline_vol = vol[-60:-20].mean()
    elif n >= 41:
        recent_vol = vol[-20:].mean()
        baseline_vol = vol[-40:-20].mean()
    else:
        half = max(n // 2, 1)
        recent_vol = vol[-half:].mean()
        baseline_vol = vol[:-half].mean() if n - half > 0 else vol[-1]
    vol_ratio = float(recent_vol / baseline_vol) if baseline_vol > 0 else 1.0
    if vol_ratio < MIN_VOL_RATIO:
        return False, {}

    # 복합 스코어
    drawdown_score = min(1.0, (drawdown - MIN_DRAWDOWN) / 0.35)
    exhaustion_score = min(1.0, (days_since_low - MIN_DAYS_SINCE_LOW) / 45.0)
    vol_score = min(1.0, max(0.0, (vol_ratio - 1.0) / 2.0))

    base = (
        WEIGHT_DRAWDOWN * drawdown_score
        + WEIGHT_EXHAUSTION * exhaustion_score
        + WEIGHT_VOLUME * vol_score
    )

    vcp_b = _vcp_bonus_val(high, low, close)
    ma_b = _ma_align_bonus_val(close)
    score = min(1.0, base + vcp_b + ma_b)

    return True, {
        "score": score,
        "drawdown": drawdown,
        "days_since_low": days_since_low,
        "vol_ratio": vol_ratio,
        "vcp": vcp_b > 0,
        "ma_align": ma_b > 0,
    }


# ── 메인 ─────────────────────────────────────────────────────────

def compute_pattern_matches(
    all_histories: dict[str, pd.DataFrame],
    universe: pd.DataFrame,
) -> list[dict[str, Any]]:
    """Gold Standard 바닥 특성에 부합하는 종목 상위 TOP_N 계산.

    Parameters
    ----------
    all_histories : 파이프라인이 수집한 전 종목 가격 이력 (ticker → DataFrame)
    universe      : US universe DataFrame (ticker, name, sector 컬럼 포함)
    """
    # universe lookup — iterrows() 없이 벡터 변환
    uni = universe[["ticker", "name", "sector"]].copy() if "name" in universe.columns else universe[["ticker", "sector"]].copy()
    if "name" not in uni.columns:
        uni["name"] = ""
    universe_map: dict[str, dict] = {
        t: {"name": (n or ""), "sector": (s if s and str(s) != "nan" else None)}
        for t, n, s in zip(uni["ticker"], uni["name"], uni["sector"])
    }

    results: list[dict[str, Any]] = []
    total = len(all_histories)
    passed = 0

    for ticker, hist in all_histories.items():
        if hist.empty:
            continue

        # DataFrame → NumPy 배열 (이후 모든 계산 벡터화)
        close = hist["Close"].to_numpy(dtype=float)
        vol = hist["Volume"].to_numpy(dtype=float)
        high = hist["High"].to_numpy(dtype=float) if "High" in hist.columns else close.copy()
        low = hist["Low"].to_numpy(dtype=float) if "Low" in hist.columns else close.copy()

        # 최소 유동성 (벡터 연산)
        if (close * vol).mean() < MIN_DOLLAR_VOL:
            continue

        # KIS 1년치 이력(lookback_days=380)에서 52주 최고가 직접 계산
        high_52w = float(high.max())
        qualifies, stats = _score_candidate(high, low, close, vol, high_52w)
        if not qualifies or stats["score"] < MIN_SCORE:
            continue

        # matched_bottom 설명 문자열 생성
        drawdown_pct = stats["drawdown"] * 100
        days = stats["days_since_low"]
        vr = stats["vol_ratio"]
        vcp_tag = "VCP ✓" if stats["vcp"] else "VCP ✗"
        ma_tag = "이평 ✓" if stats["ma_align"] else "이평 ✗"

        matched_bottom = (
            f"하락률 {drawdown_pct:.0f}% · 저점 유지 {days}일 · "
            f"거래량 {vr:.2f}배 · {vcp_tag} · {ma_tag}"
        )

        meta = universe_map.get(ticker, {})
        results.append(
            {
                "ticker": ticker,
                "name": meta.get("name") or ticker,
                "sector": meta.get("sector"),
                "similarity": round(stats["score"], 4),
                "matched_standard": "Gold Standard 바닥 특성",
                "matched_standard_ticker": None,
                "matched_bottom": matched_bottom,
                "volume_triggered": _is_volume_trigger_today(vol),
                "close": float(close[-1]),
            }
        )
        passed += 1

    results.sort(key=lambda x: x["similarity"], reverse=True)
    top = results[:TOP_N]
    print(
        f"  [pattern_discovery] 완료: {total}개 스캔 → {passed}개 조건 충족 → "
        f"상위 {len(top)}개 저장 (MIN_SCORE={MIN_SCORE:.0%})",
        flush=True,
    )
    return top
