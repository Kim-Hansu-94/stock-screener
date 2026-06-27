"""Gold Standard 바닥 패턴 유사도 계산 — 파이프라인 사전 계산 모듈.

파이프라인 실행 시 Gold Standard 5종목(QBTS·RGTI·AEVA·JOBY·FCEL)의
역사적 바닥 패턴 벡터를 KIS API로 계산하고, KIS로 수집한 전 종목 가격
이력과 코사인 유사도를 비교해 상위 20종목을 반환한다.
프론트엔드는 Supabase에서 이 결과를 읽기만 한다.
"""
from __future__ import annotations

import requests as req
from datetime import date
from typing import Any

import pandas as pd

GOLD_STANDARDS = [
    {
        "ticker": "QBTS",
        "name": "D-Wave Quantum",
        "windows": [("2023-01-01", "2023-07-01"), ("2023-09-01", "2024-04-01")],
    },
    {
        "ticker": "RGTI",
        "name": "Rigetti Computing",
        "windows": [("2023-01-01", "2023-07-01"), ("2023-09-01", "2024-04-01")],
    },
    {
        "ticker": "AEVA",
        "name": "Aeva Technologies",
        "windows": [("2022-09-01", "2023-07-01"), ("2023-07-01", "2024-06-01")],
    },
    {
        "ticker": "JOBY",
        "name": "Joby Aviation",
        "windows": [("2022-09-01", "2023-07-01"), ("2023-07-01", "2024-06-01")],
    },
    {
        "ticker": "FCEL",
        "name": "FuelCell Energy",
        "windows": [("2024-01-01", "2024-12-31")],
    },
]

PATTERN_DAYS = 90
MIN_OVERLAP = 20
VOL_MA_WIN = 20
RETURN_W = 0.8
VOLUME_W = 0.2
TOP_N = 20


# ── 수학 유틸 ──────────────────────────────────────────────────────


def _z_score(arr: list[float]) -> list[float]:
    if not arr:
        return []
    mean = sum(arr) / len(arr)
    std = (sum((x - mean) ** 2 for x in arr) / len(arr)) ** 0.5
    if std < 0.001:
        return [0.0] * len(arr)
    return [(x - mean) / std for x in arr]


def _normalize_returns(prices: list[float]) -> list[float]:
    returns = [
        (prices[i] - prices[i - 1]) / prices[i - 1]
        for i in range(1, len(prices))
        if prices[i - 1] != 0
    ]
    return _z_score(returns)


def _normalize_volume(volumes: list[float]) -> list[float]:
    ratios = []
    for i in range(VOL_MA_WIN, len(volumes)):
        ma = sum(volumes[i - VOL_MA_WIN : i]) / VOL_MA_WIN
        ratios.append(volumes[i] / ma if ma > 0 else 1.0)
    return _z_score(ratios)


def _cosine_sim(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n < MIN_OVERLAP:
        return 0.0
    dot = sum(a[i] * b[i] for i in range(n))
    mag_a = sum(x ** 2 for x in a[:n]) ** 0.5
    mag_b = sum(x ** 2 for x in b[:n]) ** 0.5
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return dot / (mag_a * mag_b)


def _weighted_sim(ref_r: list, ref_v: list, cand_r: list, cand_v: list) -> float:
    r_sim = _cosine_sim(ref_r, cand_r)
    v_sim = (
        _cosine_sim(ref_v, cand_v)
        if len(ref_v) >= MIN_OVERLAP and len(cand_v) >= MIN_OVERLAP
        else r_sim
    )
    return RETURN_W * r_sim + VOLUME_W * v_sim


# ── 필터 함수 ─────────────────────────────────────────────────────


def _is_deep_bearish(closes: list[float]) -> bool:
    if len(closes) < 200:
        return False
    sma50 = sum(closes[-50:]) / 50
    sma200 = sum(closes[-200:]) / 200
    return sma50 < sma200 * 0.9


def _has_volatility_contraction(closes: list[float]) -> bool:
    if len(closes) < 82:
        return False
    rets = [
        (closes[i] - closes[i - 1]) / closes[i - 1]
        for i in range(1, len(closes))
        if closes[i - 1] != 0
    ]
    if len(rets) < 80:
        return False
    def _std(arr: list[float]) -> float:
        mean = sum(arr) / len(arr)
        return (sum((x - mean) ** 2 for x in arr) / len(arr)) ** 0.5
    std20 = _std(rets[-20:])
    std60 = _std(rets[-80:-20])
    return std60 > 0 and std20 < std60 * 0.5


def _is_volume_trigger_today(volumes: list[float], multiplier: float = 3.0) -> bool:
    if len(volumes) < 91:
        return False
    baseline_avg = sum(volumes[-91:-1]) / 90
    return baseline_avg > 0 and volumes[-1] >= baseline_avg * multiplier


# ── Gold Standard 패턴 로드 ──────────────────────────────────────


def _load_gold_patterns() -> list[dict[str, Any]]:
    """KIS API로 Gold Standard 종목의 역사적 바닥 패턴 벡터를 계산."""
    from .prices_us import _fetch_single, _save_exch_cache

    patterns: list[dict[str, Any]] = []
    today = date.today()
    session = req.Session()

    for gs in GOLD_STANDARDS:
        earliest = min(w[0] for w in gs["windows"])
        # 윈도우 시작보다 300일 앞부터 수집 (충분한 컨텍스트 확보)
        start_dt = pd.Timestamp(earliest) - pd.Timedelta(days=300)
        lookback_days = (today - start_dt.date()).days + 30

        print(f"  [pattern_discovery] KIS 다운로드: {gs['ticker']} (약 {lookback_days}일)", flush=True)
        try:
            df = _fetch_single(gs["ticker"], today, lookback_days, session)
        except Exception as e:
            print(f"  [pattern_discovery] {gs['ticker']} 실패: {e}", flush=True)
            continue

        if df.empty or len(df) < 50:
            print(f"  [pattern_discovery] {gs['ticker']} 데이터 부족 ({len(df)}행) — 스킵", flush=True)
            continue

        for win_start, win_end in gs["windows"]:
            win_mask = (df.index >= win_start) & (df.index <= win_end)
            win_data = df[win_mask]
            if len(win_data) < PATTERN_DAYS // 2:
                continue

            win_prices = win_data["Close"].tolist()
            min_idx = win_prices.index(min(win_prices))
            bottom_ts = win_data.index[min_idx]

            idx_list = df.index.tolist()
            abs_idx = idx_list.index(bottom_ts)
            pat_start = max(0, abs_idx - PATTERN_DAYS)
            sliced = df.iloc[pat_start : abs_idx + 1]
            if len(sliced) < MIN_OVERLAP:
                continue

            prices = sliced["Close"].tolist()
            volumes = sliced["Volume"].tolist()
            return_norm = _normalize_returns(prices)
            volume_norm = _normalize_volume(volumes)
            if len(return_norm) < MIN_OVERLAP:
                continue

            patterns.append(
                {
                    "ticker": gs["ticker"],
                    "name": gs["name"],
                    "bottom": bottom_ts.strftime("%Y-%m-%d"),
                    "returnNorm": return_norm,
                    "volumeNorm": volume_norm,
                }
            )

    _save_exch_cache()
    return patterns


# ── 메인 ─────────────────────────────────────────────────────────


def compute_pattern_matches(
    all_histories: dict[str, pd.DataFrame],
    universe: pd.DataFrame,
) -> list[dict[str, Any]]:
    """Gold Standard 바닥 패턴과 현재 가장 유사한 종목 상위 TOP_N 계산.

    Parameters
    ----------
    all_histories : 파이프라인이 KIS로 수집한 전 종목 가격 이력 (ticker → DataFrame)
    universe      : US universe DataFrame (ticker, name, sector 컬럼 포함)
    """
    print("  [pattern_discovery] Gold Standard 패턴 다운로드 중 (KIS)...", flush=True)
    gold_patterns = _load_gold_patterns()
    if not gold_patterns:
        print("  [pattern_discovery] Gold Standard 패턴 로드 실패 — 스킵", flush=True)
        return []
    print(f"  [pattern_discovery] 패턴 {len(gold_patterns)}개 로드 완료", flush=True)

    max_pat_len = max(len(gp["returnNorm"]) for gp in gold_patterns)

    universe_map: dict[str, dict] = {}
    for _, row in universe.iterrows():
        universe_map[row["ticker"]] = {
            "name": row.get("name", ""),
            "sector": row.get("sector") or None,
        }

    gs_tickers = {gs["ticker"] for gs in GOLD_STANDARDS}

    # 거래대금 하위 20% 제외
    avg_turnover: dict[str, float] = {
        t: float((hist["Close"] * hist["Volume"]).mean())
        for t, hist in all_histories.items()
        if not hist.empty
    }
    if avg_turnover:
        vals = sorted(avg_turnover.values())
        bottom20 = vals[int(len(vals) * 0.2)]
    else:
        bottom20 = 0.0

    results: list[dict[str, Any]] = []
    total = len(all_histories)
    checked = 0

    for ticker, hist in all_histories.items():
        if ticker in gs_tickers or hist.empty:
            continue
        if avg_turnover.get(ticker, 0) <= bottom20:
            continue

        closes = hist["Close"].tolist()
        volumes = hist["Volume"].tolist()

        # 심한 역배열 제외 (데이터 200일 미만이면 항상 False → 제외 안 함)
        if _is_deep_bearish(closes):
            continue
        # 변동성 수축 조건
        if not _has_volatility_contraction(closes):
            continue

        cand_r_full = _normalize_returns(closes[-(max_pat_len + 1) :])
        cand_v_full = _normalize_volume(volumes[-(max_pat_len + VOL_MA_WIN + 1) :])

        best_sim = 0.0
        best_gp: dict | None = None
        for gp in gold_patterns:
            cand_r = cand_r_full[-len(gp["returnNorm"]) :]
            cand_v = cand_v_full[-len(gp["volumeNorm"]) :]
            sim = _weighted_sim(gp["returnNorm"], gp["volumeNorm"], cand_r, cand_v)
            if sim > best_sim:
                best_sim = sim
                best_gp = gp

        if best_sim <= 0 or best_gp is None:
            continue

        meta = universe_map.get(ticker, {})
        results.append(
            {
                "ticker": ticker,
                "name": meta.get("name") or ticker,
                "sector": meta.get("sector"),
                "similarity": best_sim,
                "matched_standard": best_gp["name"],
                "matched_standard_ticker": best_gp["ticker"],
                "matched_bottom": best_gp["bottom"],
                "volume_triggered": _is_volume_trigger_today(volumes),
                "close": closes[-1] if closes else None,
            }
        )
        checked += 1

    results.sort(key=lambda x: x["similarity"], reverse=True)
    top = results[:TOP_N]
    print(
        f"  [pattern_discovery] 완료: {checked}개 후보 → 상위 {len(top)}개 저장",
        flush=True,
    )
    return top
