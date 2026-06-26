"""
SPAC Death Valley Pattern — Grid Search for Optimal W_R / W_V Weights

Method:
  - Gold standard = 6 known SPAC stocks with human-curated buy windows
  - For each window, auto-detect the local price bottom
  - Extract 90 trading days before each bottom as the pattern template
  - Grid search W_R in [0.00 … 1.00]: maximize mean pairwise cosine similarity
    across all cross-stock pattern pairs
  - Report optimal W_R and pairwise similarity matrix

Usage:
  cd pipeline
  pip install -r requirements.txt
  python research/grid_search.py
"""

from __future__ import annotations

import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

warnings.filterwarnings("ignore")

# ── Gold Standard 정의 ────────────────────────────────────────────────────────

GOLD_STANDARDS = [
    {
        "ticker": "QBTS",
        "name": "D-Wave Quantum",
        "windows": [
            ("2023-01-01", "2023-07-01"),   # 23년 3~5월 바닥
            ("2023-09-01", "2024-04-01"),   # 23년 말~24년 초 바닥
        ],
    },
    {
        "ticker": "RGTI",
        "name": "Rigetti Computing",
        "windows": [
            ("2023-01-01", "2023-07-01"),
            ("2023-09-01", "2024-04-01"),
        ],
    },
    {
        "ticker": "AEVA",
        "name": "Aeva Technologies",
        "windows": [
            ("2022-09-01", "2023-07-01"),   # 23년 초 바닥
            ("2023-07-01", "2024-06-01"),   # 24년 초 바닥
        ],
    },
    {
        "ticker": "JOBY",
        "name": "Joby Aviation",
        "windows": [
            ("2022-09-01", "2023-07-01"),
            ("2023-07-01", "2024-06-01"),
        ],
    },
    {
        "ticker": "FCEL",
        "name": "FuelCell Energy",
        "windows": [
            ("2024-01-01", "2024-12-31"),   # 24년 중순 이후
        ],
    },
]

PATTERN_DAYS = 90   # 바닥 직전 거래일 수 (Gold Standard 패턴 길이)
VOL_MA_WINDOW = 20  # 거래량 이동평균 기준


# ── 유틸 함수 ─────────────────────────────────────────────────────────────────

def download_history(ticker: str, earliest_start: str) -> pd.DataFrame:
    """yfinance로 충분한 기간 데이터 다운로드 (패턴 추출용 여유분 포함)."""
    start_dt = pd.Timestamp(earliest_start) - pd.DateOffset(days=300)
    df = yf.download(
        ticker,
        start=start_dt.strftime("%Y-%m-%d"),
        auto_adjust=True,
        progress=False,
        multi_level_index=False,
    )
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.droplevel(1)
    df = df[["Close", "Volume"]].dropna()
    df.index = pd.DatetimeIndex(df.index).tz_localize(None)
    return df


def find_bottom(df: pd.DataFrame, start: str, end: str) -> pd.Timestamp:
    """지정 구간 내 종가 최저점 날짜 반환."""
    mask = (df.index >= start) & (df.index <= end)
    sub = df.loc[mask, "Close"]
    if sub.empty:
        raise ValueError(f"구간 {start}~{end} 에 데이터 없음")
    return sub.idxmin()


def daily_returns(prices: np.ndarray) -> np.ndarray:
    return np.diff(prices) / prices[:-1]


def z_score(arr: np.ndarray) -> np.ndarray:
    std = float(arr.std())
    if std < 1e-9:
        return np.zeros_like(arr)
    return (arr - arr.mean()) / std


def norm_returns(prices: np.ndarray) -> np.ndarray:
    return z_score(daily_returns(prices))


def norm_volume(volumes: np.ndarray) -> np.ndarray:
    """당일 거래량 / 20일 이동평균 비율 → Z-score."""
    if len(volumes) <= VOL_MA_WINDOW:
        return np.array([])
    ratios = np.array([
        volumes[i] / volumes[i - VOL_MA_WINDOW:i].mean()
        if volumes[i - VOL_MA_WINDOW:i].mean() > 0 else 1.0
        for i in range(VOL_MA_WINDOW, len(volumes))
    ])
    return z_score(ratios)


def cosine_sim(a: np.ndarray, b: np.ndarray, min_len: int = 20) -> float:
    n = min(len(a), len(b))
    if n < min_len:
        return 0.0
    a, b = a[-n:], b[-n:]
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denom) if denom > 1e-9 else 0.0


def weighted_sim(
    ret_a: np.ndarray, vol_a: np.ndarray,
    ret_b: np.ndarray, vol_b: np.ndarray,
    w_r: float,
) -> float:
    r_sim = cosine_sim(ret_a, ret_b)
    has_vol = (len(vol_a) >= 20 and len(vol_b) >= 20)
    v_sim = cosine_sim(vol_a, vol_b) if has_vol else r_sim
    return w_r * r_sim + (1.0 - w_r) * v_sim


def extract_pattern(
    df: pd.DataFrame, bottom_date: pd.Timestamp
) -> tuple[np.ndarray, np.ndarray] | tuple[None, None]:
    """바닥 날짜 기준 직전 PATTERN_DAYS 거래일 패턴 추출."""
    try:
        idx = df.index.get_loc(bottom_date)
    except KeyError:
        return None, None
    start = max(0, idx - PATTERN_DAYS)
    sub = df.iloc[start:idx]
    if len(sub) < 10:
        return None, None
    return norm_returns(sub["Close"].to_numpy(float)), norm_volume(sub["Volume"].to_numpy(float))


# ── 메인 ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 65)
    print("  SPAC Death Valley Pattern - W_R Grid Search")
    print("=" * 65)

    # 1. 골드 스탠다드 패턴 추출
    print("\n[1/3] 데이터 다운로드 및 패턴 추출\n")
    patterns: list[dict] = []

    for gs in GOLD_STANDARDS:
        ticker = gs["ticker"]
        print(f"  {ticker}  ({gs['name']})")
        earliest = min(w[0] for w in gs["windows"])

        try:
            df = download_history(ticker, earliest)
        except Exception as exc:
            print(f"    다운로드 실패: {exc}")
            continue

        if df.empty:
            print(f"    데이터 없음 — 티커 확인 필요")
            continue

        for start, end in gs["windows"]:
            try:
                bottom = find_bottom(df, start, end)
                ret_n, vol_n = extract_pattern(df, bottom)
                if ret_n is None:
                    print(f"    [{start}~{end}] 데이터 부족, 스킵")
                    continue
                patterns.append({
                    "ticker": ticker,
                    "name": gs["name"],
                    "window": f"{start}~{end}",
                    "bottom": bottom.strftime("%Y-%m-%d"),
                    "ret": ret_n,
                    "vol": vol_n,
                })
                print(f"    [{start}~{end}]  바닥={bottom.strftime('%Y-%m-%d')}  "
                      f"수익률 벡터={len(ret_n)}일  거래량 벡터={len(vol_n)}일")
            except Exception as exc:
                print(f"    [{start}~{end}] 오류: {exc}")

    if len(patterns) < 2:
        print("\n패턴 수 부족. 종료합니다.")
        sys.exit(1)

    # 2. 그리드 서치
    print(f"\n[2/3] W_R 그리드 서치  (0.00 → 1.00, 간격 0.05)\n")
    W_R_RANGE = [round(i * 0.05, 2) for i in range(21)]

    rows = []
    for w_r in W_R_RANGE:
        sims = []
        for i, a in enumerate(patterns):
            for j, b in enumerate(patterns):
                if j <= i:
                    continue
                if a["ticker"] == b["ticker"]:
                    continue  # 같은 종목의 다른 윈도우는 비교 제외
                sims.append(weighted_sim(a["ret"], a["vol"], b["ret"], b["vol"], w_r))
        mean_s = float(np.mean(sims)) if sims else 0.0
        min_s  = float(np.min(sims))  if sims else 0.0
        rows.append({"w_r": w_r, "w_v": round(1.0 - w_r, 2),
                     "mean_sim": mean_s, "min_sim": min_s, "n_pairs": len(sims)})

    df_grid = pd.DataFrame(rows)
    best_row = df_grid.loc[df_grid["mean_sim"].idxmax()]

    # 3. 결과 출력
    print("[3/3] 결과\n")
    print(f"  {'W_R':>5}  {'W_V':>5}  {'Mean Sim':>10}  {'Min Sim':>9}  {'Pairs':>6}")
    print("  " + "-" * 42)
    for _, r in df_grid.iterrows():
        mark = "  ← best" if r["w_r"] == best_row["w_r"] else ""
        print(f"  {r['w_r']:>5.2f}  {r['w_v']:>5.2f}  "
              f"{r['mean_sim']:>10.4f}  {r['min_sim']:>9.4f}  {int(r['n_pairs']):>6}{mark}")

    print(f"\n  최적 가중치: W_R = {best_row['w_r']:.2f}  /  W_V = {best_row['w_v']:.2f}")
    print(f"  평균 유사도:  {best_row['mean_sim']:.4f}")

    # 최적 W_R 기준 패턴 간 유사도 행렬
    w_r_best = float(best_row["w_r"])
    labels = [f"{p['ticker']}({p['bottom']})" for p in patterns]
    n = len(patterns)
    mat = np.ones((n, n))
    for i in range(n):
        for j in range(n):
            if i != j:
                mat[i, j] = weighted_sim(
                    patterns[i]["ret"], patterns[i]["vol"],
                    patterns[j]["ret"], patterns[j]["vol"],
                    w_r_best,
                )

    print(f"\n패턴 간 유사도 행렬  (W_R={w_r_best:.2f}):\n")
    col_w = max(len(lb) for lb in labels) + 2
    header = " " * col_w + "  ".join(f"{lb:>22}" for lb in labels)
    print(header)
    for i, lb in enumerate(labels):
        row_str = f"{lb:<{col_w}}" + "  ".join(f"{mat[i, j]:>22.4f}" for j in range(n))
        print(row_str)

    # CSV 저장
    out_path = Path(__file__).parent / "grid_search_results.csv"
    df_grid.to_csv(out_path, index=False)
    print(f"\n결과 저장: {out_path}")


if __name__ == "__main__":
    main()
