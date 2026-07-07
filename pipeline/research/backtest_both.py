"""
눌림목 + 골드스탠다드(오늘의 추천) 통합 백테스트
==================================================
두 전략이 동일한 가격 데이터를 쓰므로 OHLCV를 **한 번만** 다운로드하고
두 백테스트를 모두 돌린다.

1) 눌림목: backtest_pullback.py 의 검증된 로직(run_backtest/summarize)을 그대로 재사용.
           진입=신호일 종가, 청산=20/60/120일 후, SPY<SMA200 구간 신호 제외.

2) 골드스탠다드: 실제 파이프라인 채점 함수 pattern_discovery._score_candidate 를
           그대로 import 해서 매일(walk-forward) 재생.
           - 각 거래일 t 에서 직전 LOOKBACK_ROWS(≈1년) 창을 채점 (lookahead 없음)
           - 유동성 필터(일평균 거래대금 ≥ MIN_DOLLAR_VOL)도 프로덕션과 동일하게 선적용
           - 점수 임계값 100% / 95% / 90% 세 구간을 각각 집계 (구간별 독립 쿨다운)
           - 매수: 임계값 도달일 종가 / 보유: 무기한(손절 없음) / 매도: +300% 도달 시
           - +300% 미도달이면 마지막 종가로 평가(미청산)

실행법: python pipeline/research/backtest_both.py   (프로젝트 루트에서)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.research.backtest_pullback import (  # noqa: E402
    HOLDING_DAYS,
    MIN_BARS,
    YEARS_BACK,
    download_spy,
    get_universe_tickers,
    print_summary,
    run_backtest,
    summarize,
)
from pipeline.src.pattern_discovery import (  # noqa: E402
    MIN_DOLLAR_VOL,
    _score_candidate,
)

# ── 골드스탠다드 백테스트 설정 ────────────────────────────────────────
LOOKBACK_ROWS = 260          # 채점 시 매일 참조하는 직전 거래일 수(≈1년, 프로덕션 lookback_days=380 대응)
GS_MIN_START = 60            # 최소 이 정도 봉이 쌓인 뒤부터 스캔 시작
SELL_TARGET = 3.0            # +300% (진입가의 4배)에서 익절
GS_COOLDOWN_DAYS = 30        # 같은 종목 재진입 최소 간격(캘린더일), 임계값별 독립
GS_THRESHOLDS = [1.00, 0.95, 0.90]

OUT_DIR = Path(__file__).parent
GS_TRADES_CSV = OUT_DIR / "backtest_golden_trades.csv"
GS_SUMMARY_CSV = OUT_DIR / "backtest_golden_summary.csv"


# ── OHLCV 다운로드 (High/Low/Close/Volume 전부 보존) ──────────────────

def download_ohlcv(tickers: list[str]) -> dict[str, pd.DataFrame]:
    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)
    print(f"\nOHLCV 다운로드 ({start.date()} ~ {end.date()}) ...")
    print("  (약 10-20분 소요 예상)")

    batch_size = 100
    fields = ["High", "Low", "Close", "Volume"]
    parts: dict[str, list[pd.DataFrame]] = {f: [] for f in fields}
    n_batches = (len(tickers) + batch_size - 1) // batch_size

    for i in range(0, len(tickers), batch_size):
        batch = tickers[i : i + batch_size]
        bn = i // batch_size + 1
        sys.stdout.write(f"\r  배치 {bn}/{n_batches} 다운로드 중...")
        sys.stdout.flush()
        try:
            raw = yf.download(batch, start=start, end=end, auto_adjust=True, progress=False)
            if raw.empty:
                continue
            for f in fields:
                if isinstance(raw.columns, pd.MultiIndex):
                    parts[f].append(raw[f])
                else:
                    parts[f].append(raw[[f]].rename(columns={f: batch[0]}))
        except Exception as e:
            print(f"\n  배치 {bn} 오류: {e}")

    print()
    if not parts["Close"]:
        return {}

    field_df: dict[str, pd.DataFrame] = {}
    for f in fields:
        df = pd.concat(parts[f], axis=1)
        field_df[f] = df.loc[:, ~df.columns.duplicated()]

    min_rows = MIN_BARS + max(HOLDING_DAYS) // 4
    ohlcv: dict[str, pd.DataFrame] = {}
    for t in field_df["Close"].columns:
        c = field_df["Close"][t].dropna()
        if len(c) < min_rows:
            continue
        idx = c.index
        h = field_df["High"][t].reindex(idx).ffill() if t in field_df["High"].columns else c
        low = field_df["Low"][t].reindex(idx).ffill() if t in field_df["Low"].columns else c
        v = field_df["Volume"][t].reindex(idx).fillna(0) if t in field_df["Volume"].columns else pd.Series(0.0, index=idx)
        ohlcv[t] = pd.DataFrame({"High": h, "Low": low, "Close": c, "Volume": v})

    print(f"  유효 종목: {len(ohlcv)}개 (데이터 부족 종목 제외)")
    return ohlcv


# ── 골드스탠다드 walk-forward 백테스트 ────────────────────────────────

def run_golden(ohlcv: dict[str, pd.DataFrame]) -> dict[float, list[dict]]:
    """임계값별 트레이드 리스트 반환."""
    trades: dict[float, list[dict]] = {thr: [] for thr in GS_THRESHOLDS}
    total = len(ohlcv)

    for idx_i, (ticker, df) in enumerate(ohlcv.items()):
        if idx_i % 200 == 0:
            sys.stdout.write(f"\r  골드스탠다드 스캔: {idx_i}/{total}  ")
            sys.stdout.flush()

        index = df.index
        high = df["High"].to_numpy(dtype=float)
        low = df["Low"].to_numpy(dtype=float)
        close = df["Close"].to_numpy(dtype=float)
        vol = df["Volume"].to_numpy(dtype=float)
        n = len(close)
        if n < GS_MIN_START:
            continue

        last_entry: dict[float, pd.Timestamp | None] = {thr: None for thr in GS_THRESHOLDS}

        for i in range(GS_MIN_START, n):
            lo = max(0, i - LOOKBACK_ROWS + 1)
            w_high = high[lo : i + 1]
            w_low = low[lo : i + 1]
            w_close = close[lo : i + 1]
            w_vol = vol[lo : i + 1]

            # 유동성 필터 (compute_pattern_matches 와 동일)
            if (w_close * w_vol).mean() < MIN_DOLLAR_VOL:
                continue

            high_52w = float(w_high.max())
            ok, stats = _score_candidate(w_high, w_low, w_close, w_vol, high_52w)
            if not ok:
                continue
            score = float(stats["score"])
            if score < GS_THRESHOLDS[-1]:  # 최저 임계값(0.90) 미만이면 어디에도 안 들어감
                continue

            entry_date = index[i]
            entry_price = float(close[i])
            target_price = entry_price * (1.0 + SELL_TARGET)

            # 진입 이후 +300% 최초 도달 시점 (벡터화)
            fut_high = high[i + 1 :]
            hits = np.nonzero(fut_high >= target_price)[0]
            if hits.size:
                exit_i = i + 1 + int(hits[0])
                exit_date = index[exit_i]
                exit_price = target_price
                ret = SELL_TARGET
                hold = exit_i - i
                target_hit = True
            else:
                exit_i = n - 1
                exit_date = index[-1]
                exit_price = float(close[-1])
                ret = exit_price / entry_price - 1.0
                hold = (n - 1) - i
                target_hit = False

            for thr in GS_THRESHOLDS:
                if score < thr:
                    continue
                le = last_entry[thr]
                if le is not None and (entry_date - le).days < GS_COOLDOWN_DAYS:
                    continue
                last_entry[thr] = entry_date
                trades[thr].append(
                    {
                        "ticker": ticker,
                        "entry_date": entry_date.date(),
                        "exit_date": exit_date.date(),
                        "score": round(score, 4),
                        "threshold": thr,
                        "entry_price": round(entry_price, 4),
                        "exit_price": round(exit_price, 4),
                        "return_pct": round(ret * 100, 2),
                        "target_hit": target_hit,
                        "holding_days": hold,
                    }
                )

    print()
    return trades


def summarize_golden(trades: dict[float, list[dict]], spy_ret_3y: float | None) -> pd.DataFrame:
    rows = []
    for thr in GS_THRESHOLDS:
        tl = trades[thr]
        if not tl:
            rows.append({"임계값": f"{thr*100:.0f}%", "트레이드수": 0})
            continue
        df = pd.DataFrame(tl)
        n = len(df)
        hits = df["target_hit"].sum()
        open_n = n - hits
        ret = df["return_pct"]
        hit_hold = df[df["target_hit"]]["holding_days"]
        rows.append(
            {
                "임계값": f"{thr*100:.0f}%",
                "트레이드수": n,
                "유니크종목": df["ticker"].nunique(),
                "+300%도달수": int(hits),
                "+300%도달률(%)": round(hits / n * 100, 1),
                "미청산수": int(open_n),
                "평균수익률(%)": round(ret.mean(), 1),
                "중앙수익률(%)": round(ret.median(), 1),
                "최대수익(%)": round(ret.max(), 1),
                "최대손실(%)": round(ret.min(), 1),
                "도달까지평균보유일": round(hit_hold.mean(), 0) if len(hit_hold) else "N/A",
                "SPY_3년(%)": round(spy_ret_3y * 100, 1) if spy_ret_3y is not None else "N/A",
            }
        )
    return pd.DataFrame(rows)


def print_golden(summary: pd.DataFrame) -> None:
    print("\n" + "=" * 70)
    print("골드스탠다드(오늘의 추천) 백테스트 결과")
    print("규칙: 매수=점수 임계값 도달일 종가 / 보유=무기한(손절 없음) / 매도=+300%")
    print("=" * 70)
    for _, r in summary.iterrows():
        print(f"\n[점수 {r['임계값']} 이상]")
        if r.get("트레이드수", 0) == 0:
            print("  해당 구간 트레이드 없음")
            continue
        print(f"  트레이드 수     : {r['트레이드수']} (종목 {r['유니크종목']}개)")
        print(f"  +300% 도달      : {r['+300%도달수']}건 ({r['+300%도달률(%)']}%)")
        print(f"  미청산(보유중)  : {r['미청산수']}건")
        print(f"  평균 수익률     : {r['평균수익률(%)']}%  (중앙 {r['중앙수익률(%)']}%)")
        print(f"  최대 수익/손실  : +{r['최대수익(%)']}% / {r['최대손실(%)']}%")
        print(f"  +300% 평균 소요 : {r['도달까지평균보유일']} 거래일")
        print(f"  (참고) SPY 3년  : {r['SPY_3년(%)']}%")
    print()


# ── 진입점 ────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 70)
    print("통합 백테스트: 눌림목 + 골드스탠다드  (최근 3년)")
    print("=" * 70)

    tickers = get_universe_tickers()
    if not tickers:
        sys.exit("유니버스 수집 실패.")

    ohlcv = download_ohlcv(tickers)
    if not ohlcv:
        sys.exit("가격 데이터 없음.")

    print("\nSPY 다운로드 중...")
    spy = download_spy()
    spy_ret_3y = float(spy.iloc[-1]) / float(spy.iloc[0]) - 1.0 if len(spy) > 1 else None

    # ── 1) 눌림목 (검증된 로직 재사용; close/volume 만 필요) ──
    prices_pb = {
        t: df[["Close", "Volume"]].rename(columns={"Close": "close", "Volume": "volume"})
        for t, df in ohlcv.items()
    }
    print("\n[1/2] 눌림목 백테스트 실행 중...")
    pb_results = run_backtest(prices_pb, spy)
    if not pb_results.empty:
        pb_results.to_csv(OUT_DIR / "backtest_pullback_results.csv", index=False, encoding="utf-8-sig")
        pb_summary = summarize(pb_results)
        pb_summary.to_csv(OUT_DIR / "backtest_pullback_summary.csv", index=False, encoding="utf-8-sig")
        print_summary(pb_summary)
    else:
        print("  눌림목 신호 없음.")

    # ── 2) 골드스탠다드 walk-forward ──
    print("\n[2/2] 골드스탠다드 백테스트 실행 중...")
    gs_trades = run_golden(ohlcv)
    all_trades = [t for tl in gs_trades.values() for t in tl]
    if all_trades:
        pd.DataFrame(all_trades).to_csv(GS_TRADES_CSV, index=False, encoding="utf-8-sig")
        print(f"  골드스탠다드 트레이드 저장: {GS_TRADES_CSV.name}")
    gs_summary = summarize_golden(gs_trades, spy_ret_3y)
    gs_summary.to_csv(GS_SUMMARY_CSV, index=False, encoding="utf-8-sig")
    print_golden(gs_summary)

    print("완료.")


if __name__ == "__main__":
    main()
