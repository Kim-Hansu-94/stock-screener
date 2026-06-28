"""Gold Standard 바닥 특성 기반 후보 종목 발굴 — 파이프라인 사전 계산 모듈.

Russell3000 전 종목의 가격/거래량 데이터에서 Gold Standard 종목들이 큰 반등 직전에
공통으로 보였던 특성(심한 하락 후 바닥 다지기 + 거래량 유지)을 룰 기반으로 스코어링한다.

기존 코사인 유사도 방식의 문제점:
  - Z-scoring이 진폭 정보를 소거(±0.1% 종목과 ±30% 종목이 동일하게 보임)
  - _is_deep_bearish 필터가 Gold Standard 종목 자체를 배제하는 역설
  - KIS API로 Gold Standard 역사 데이터를 별도 다운로드해야 해 안정성 저하
"""
from __future__ import annotations

from typing import Any

import pandas as pd

TOP_N = 20

# 가격 필터
MIN_PRICE = 0.50    # $0.5 미만은 상장폐지 위험 종목
MAX_PRICE = 50.0    # $50 초과는 소형주 낙폭 과대 프로필과 거리 멈

# 핵심 룰 기준값
MIN_DRAWDOWN = 0.55          # 5개월 고점 대비 55% 이상 하락 (Gold Standard 최소 낙폭 기준)
MIN_DAYS_SINCE_LOW = 15      # 저점을 갱신하지 않은 기간 ≥ 15 거래일 (매도 소진 신호)
MIN_VOL_RATIO = 0.70         # 최근 20일 거래량 ÷ 직전 40일 거래량 ≥ 0.70 (거래량 유지, 붕괴 아님)

# 부가 기준값
VOL_TRIGGER_MULTIPLIER = 2.0  # 오늘 거래량이 90일 평균의 2배 이상 → 거래량 트리거
MIN_DOLLAR_VOL = 300_000      # 일평균 거래대금 $30만 이상 (최소 유동성)


def _is_volume_trigger_today(volumes: list[float]) -> bool:
    if len(volumes) < 2:
        return False
    n = min(90, len(volumes) - 1)
    baseline_avg = sum(volumes[-n - 1 : -1]) / n
    return baseline_avg > 0 and volumes[-1] >= baseline_avg * VOL_TRIGGER_MULTIPLIER


def _score_candidate(closes: list[float], volumes: list[float]) -> tuple[bool, dict]:
    """룰 기반 스코어 계산. 조건 미충족 시 (False, {}) 반환."""
    if len(closes) < 30 or len(volumes) < 30:
        return False, {}

    current = closes[-1]

    # 가격 범위 필터
    if not (MIN_PRICE <= current <= MAX_PRICE):
        return False, {}

    # 5개월(전 데이터) 고점 대비 하락률
    high = max(closes)
    drawdown = (high - current) / high if high > 0 else 0.0
    if drawdown < MIN_DRAWDOWN:
        return False, {}

    # 저점 갱신 중단일 수 — list(reversed(...)).index()는 가장 최근 저점을 찾음
    low_val = min(closes)
    reversed_idx = list(reversed(closes)).index(low_val)
    low_idx = len(closes) - 1 - reversed_idx
    days_since_low = len(closes) - 1 - low_idx
    if days_since_low < MIN_DAYS_SINCE_LOW:
        return False, {}

    # 거래량 유지 여부 (최근 20일 vs 직전 40일)
    if len(volumes) >= 61:
        recent_vol = sum(volumes[-20:]) / 20
        baseline_vol = sum(volumes[-60:-20]) / 40
    elif len(volumes) >= 41:
        recent_vol = sum(volumes[-20:]) / 20
        baseline_vol = sum(volumes[-40:-20]) / 20
    else:
        n = len(volumes) // 2
        recent_vol = sum(volumes[-n:]) / n if n > 0 else volumes[-1]
        baseline_vol = sum(volumes[:-n]) / max(len(volumes) - n, 1)
    vol_ratio = recent_vol / baseline_vol if baseline_vol > 0 else 1.0
    if vol_ratio < MIN_VOL_RATIO:
        return False, {}

    # 복합 스코어 (0 ~ 1)
    # drawdown: 0 at 55%, 1.0 at 90%+
    drawdown_score = min(1.0, (drawdown - MIN_DRAWDOWN) / 0.35)
    # exhaustion: 0 at 15일, 1.0 at 60일+
    exhaustion_score = min(1.0, (days_since_low - MIN_DAYS_SINCE_LOW) / 45.0)
    # vol_score: vol_ratio가 1.0 미만이면 0, 3.0이면 1.0
    vol_score = min(1.0, max(0.0, (vol_ratio - 1.0) / 2.0))

    score = 0.4 * drawdown_score + 0.4 * exhaustion_score + 0.2 * vol_score

    return True, {
        "score": score,
        "drawdown": drawdown,
        "days_since_low": days_since_low,
        "vol_ratio": vol_ratio,
    }


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
    universe_map: dict[str, dict] = {}
    for _, row in universe.iterrows():
        universe_map[row["ticker"]] = {
            "name": row.get("name", ""),
            "sector": row.get("sector") or None,
        }

    results: list[dict[str, Any]] = []
    total = len(all_histories)
    passed = 0

    for ticker, hist in all_histories.items():
        if hist.empty:
            continue

        closes = hist["Close"].tolist()
        volumes = hist["Volume"].tolist()

        # 최소 유동성 필터
        avg_dollar_vol = float((hist["Close"] * hist["Volume"]).mean())
        if avg_dollar_vol < MIN_DOLLAR_VOL:
            continue

        qualifies, stats = _score_candidate(closes, volumes)
        if not qualifies:
            continue

        drawdown_pct = stats["drawdown"] * 100
        days = stats["days_since_low"]
        vol_r = stats["vol_ratio"]
        vol_sign = "+" if vol_r >= 1.0 else "-"
        vol_pct = abs(vol_r - 1.0) * 100
        matched_bottom = f"하락률 {drawdown_pct:.0f}% · 저점 유지 {days}일 · 거래량 {vol_sign}{vol_pct:.0f}%"

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
                "volume_triggered": _is_volume_trigger_today(volumes),
                "close": closes[-1] if closes else None,
            }
        )
        passed += 1

    results.sort(key=lambda x: x["similarity"], reverse=True)
    top = results[:TOP_N]
    print(
        f"  [pattern_discovery] 완료: {total}개 스캔 → {passed}개 조건 충족 → 상위 {len(top)}개 저장",
        flush=True,
    )
    return top
