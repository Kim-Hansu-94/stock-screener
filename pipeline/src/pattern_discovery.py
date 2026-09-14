"""Gold Standard 바닥 특성 기반 후보 종목 발굴 — 파이프라인 사전 계산 모듈 v2.

v2 개선 사항:
  - 하락률 기준: 5개월 고점 → 52주 최고가 (KIS 1년치 이력 직접 사용, lookback_days=380)
  - 가중치 재조정: 하락률 0.3 / 소진일수 0.4 / 거래량 0.3
  - VCP 보너스: ATR10 / ATR50 ≤ 0.6 이면 +0.10점 (변동성 압축)
  - 이평선 정배열 보너스: 현재가 > SMA5 > SMA10 > SMA20 이면 +0.10점
  - NumPy 벡터 연산으로 내부 지표 계산 최적화
  - MIN_SCORE 미달 종목 자동 드롭 후 상위 TOP_N 반환

v3 (2026-09-14, 『매매의 기술』 근거):
  - 거래량 트리거에 **봉 방향 조건** 추가 — 대량거래 + (양봉 또는 십자형)일 때만
    `volume_triggered`. 예전에는 거래량 2배만 보고 투매(대량거래 장대음봉)에도
    ⚡ 배지가 붙었다 (`_is_volume_trigger_today` 주석 참고)
  - 추천 결과에 집계용 원본 수치(`drawdown_pct`·`days_since_low`·`vol_ratio`·
    `vcp`·`ma_align`)를 함께 실어 `recommendation_history`에 남긴다 — 나중에
    "어떤 특성의 후보가 잘 맞았나"로 성적을 쪼개려면 추천 시점 수치가 필요하다
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
DOJI_BODY_RATIO = 0.1         # 몸통 ÷ (고가-저가) 이 값 이하면 십자형(도지)로 본다


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


def _is_volume_trigger_today(
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    vol: np.ndarray,
) -> bool:
    """오늘 터진 대량거래가 '매수' 쪽 신호인지 판정.

    거래량만으로는 방향을 알 수 없다 — 『매매의 기술』(2장 거래량):
    **"거래량은 타이밍만 제공한다. 방향은 봉의 모양이 결정한다."**
    같은 책의 매수 제3원칙(20일선 아래 급락 중)은 "거래량 증가 + **양봉 또는
    십자형**이 나올 때" 매수하라고 하고, 거래량 8원칙 2번은 "거래량 증가 +
    장대음봉 = **매물**"이라고 정반대로 못 박는다.

    예전에는 거래량 2배 조건만 보고 True를 돌려줬다. 그래서 악재로 투매가 터진 날
    (대량거래 장대음봉)도 반등 신호와 똑같이 ⚡ 배지가 붙어, 화면에서 정반대 신호가
    구분되지 않았다. 지금은 대량거래 **+ (양봉 또는 십자형)** 일 때만 True다.
    """
    if len(vol) < 2:
        return False
    n = min(90, len(vol) - 1)
    baseline = vol[-n - 1 : -1].mean()
    if not (baseline > 0 and vol[-1] >= baseline * VOL_TRIGGER_MULTIPLIER):
        return False

    o, h, l, c = float(open_[-1]), float(high[-1]), float(low[-1]), float(close[-1])
    if c > o:
        return True  # 양봉

    # 십자형(도지) = 대량거래인데 몸통이 거의 없다 → 황소와 곰이 치열하게 싸워
    # 우열이 안 갈린 상태. 책은 "큰 폭 하락 후 십자형"을 매수 신호로 본다.
    # 고가=저가(가격이 하루 내내 안 움직인 봉)는 싸움 자체가 없었다는 뜻이라 제외한다.
    bar_range = h - l
    if bar_range <= 0:
        return False
    return bool(abs(c - o) / bar_range <= DOJI_BODY_RATIO)


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
        # 시가는 거래량 트리거의 봉 방향(양봉/십자형) 판정에만 쓴다.
        # **시가가 없는 소스를 종가로 메우면 조용히 틀린다** — 그러면 몸통이 0이라
        # 모든 대량거래일이 십자형(=매수 신호)으로 잡혀, 고치려던 "방향을 안 본다"는
        # 문제가 그대로 남는다. prices_us._rows_to_df가 KIS 응답에 시가 칸이 없으면
        # 종가로 채우므로(`_first(r, _OPEN_KEYS) or c`) 실제로 생길 수 있는 상황이다.
        # 전 구간 시가=종가면 진짜 봉이 아니라 메운 값이므로 트리거를 끈다.
        open_ = hist["Open"].to_numpy(dtype=float) if "Open" in hist.columns else close.copy()
        has_open = "Open" in hist.columns and not np.array_equal(open_, close)

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
                "volume_triggered": (
                    has_open and _is_volume_trigger_today(open_, high, low, close, vol)
                ),
                "close": float(close[-1]),
                # 추천 성적을 나중에 "어떤 특성의 후보가 잘 맞았나"로 쪼개려면
                # 추천 시점의 원본 수치가 남아 있어야 한다. matched_bottom은 사람이
                # 읽는 문자열이라 집계에 못 쓴다 → db.save_recommendation_history가
                # 이 값들을 recommendation_history에 같이 저장한다.
                "drawdown_pct": round(stats["drawdown"] * 100, 2),
                "days_since_low": stats["days_since_low"],
                "vol_ratio": round(stats["vol_ratio"], 4),
                "vcp": stats["vcp"],
                "ma_align": stats["ma_align"],
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
