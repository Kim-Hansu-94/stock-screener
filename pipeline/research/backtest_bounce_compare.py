"""
반등 확인 조건 비교: 현재("종가 > 전일 고가") vs 50% 룰 (『매매의 기술』)
====================================================================
screener.py의 다른 조건(장기추세·눌림구간·RSI·거래량감소·임팩트)은 고정하고,
CRITERION_BOUNCE 하나만 세 가지로 바꿔가며 같은 유니버스·같은 기간에 돌린다.
진입·청산·벤치마크·쿨다운은 backtest_pullback.py와 동일(20/60/120일, SPY<SMA200 제외).

세 변형:
  A. 현재 코드  : 종가 > 전일 고가
  B. 50% 룰     : 종가 >= L + 0.5*(H-L)  AND  거래량 > 20일 평균  AND  양봉(종가>시가)
                  H = 최근 20일 고가, L = 최근 20일 저가 (조정 시작점/저점의 근사)
  C. 필터 없음  : 반등 조건 자체를 안 건 기준선 (참고용)

실행법: python pipeline/research/backtest_bounce_compare.py  (프로젝트 루트에서)
"""
from __future__ import annotations

import sys
from datetime import timedelta
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
    COOLDOWN_DAYS,
    _rsi,
    download_spy,
    get_universe_tickers,
)

OUT_DIR = Path(__file__).parent
CACHE_DIR = OUT_DIR / "_cache"
RESULTS_CSV = OUT_DIR / "backtest_bounce_compare_results.csv"
SUMMARY_CSV = OUT_DIR / "backtest_bounce_compare_summary.csv"

BOUNCE_LOOKBACK = 20  # H/L을 재는 창 — sma20/sma10 눌림구간과 같은 스케일


def _cache_path(tickers: list[str], end: pd.Timestamp) -> Path:
    import hashlib
    key = hashlib.md5(("|".join(sorted(tickers))).encode()).hexdigest()[:8]
    return CACHE_DIR / f"ohlcv_o_{YEARS_BACK}y_{end.date()}_{len(tickers)}_{key}.pkl"


def download_ohlcv(tickers: list[str]) -> dict[str, pd.DataFrame]:
    import pickle

    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)

    cache = _cache_path(tickers, end)
    if cache.exists():
        print(f"\n캐시된 OHLCV 사용: {cache.name} (다운로드 건너뜀)")
        with open(cache, "rb") as fh:
            return pickle.load(fh)

    print(f"\nOHLCV 다운로드 ({start.date()} ~ {end.date()}) ...")
    print("  (약 10-20분 소요 예상, 이후 실행은 캐시 재사용)")

    batch_size = 100
    fields = ["Open", "High", "Low", "Close", "Volume"]
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
        o = field_df["Open"][t].reindex(idx).ffill() if t in field_df["Open"].columns else c
        h = field_df["High"][t].reindex(idx).ffill() if t in field_df["High"].columns else c
        low = field_df["Low"][t].reindex(idx).ffill() if t in field_df["Low"].columns else c
        v = field_df["Volume"][t].reindex(idx).fillna(0) if t in field_df["Volume"].columns else pd.Series(0.0, index=idx)
        ohlcv[t] = pd.DataFrame({"Open": o, "High": h, "Low": low, "Close": c, "Volume": v})

    print(f"  유효 종목: {len(ohlcv)}개 (데이터 부족 종목 제외)")

    CACHE_DIR.mkdir(exist_ok=True)
    with open(cache, "wb") as fh:
        pickle.dump(ohlcv, fh)
    print(f"  캐시 저장: {cache.name} (다음 실행부터 다운로드 생략)")
    return ohlcv


def base_signal(df: pd.DataFrame) -> pd.Series:
    """반등 조건을 뺀 나머지 눌림목 조건 (장기추세·눌림구간·RSI·거래량감소·임팩트)."""
    close, volume = df["Close"], df["Volume"]

    sma10 = close.rolling(10).mean()
    sma20 = close.rolling(20).mean()
    sma60 = close.rolling(60).mean()
    rsi14 = _rsi(close, 14)

    long_term_up = (sma60 > sma60.shift(5)) & (close > sma60)
    in_pullback = (sma20 <= close) & (close <= sma10)
    rsi_ok = (rsi14 >= 40) & (rsi14 <= 60)

    vol5 = volume.rolling(5).mean()
    vol_baseline = volume.shift(5).rolling(20).mean()
    vol_declining = vol5 < vol_baseline

    impulse_gain = close / close.shift(60) - 1
    impulse_ok = impulse_gain >= 0.15

    sig = long_term_up & in_pullback & rsi_ok & vol_declining & impulse_ok
    if len(sig) > MIN_BARS:
        sig.iloc[:MIN_BARS] = False
    else:
        sig[:] = False
    return sig.fillna(False)


def bounce_current(df: pd.DataFrame) -> pd.Series:
    """A. 현재 코드: 종가 > 전일 고가."""
    return (df["Close"] > df["High"].shift(1)).fillna(False)


def bounce_50pct(df: pd.DataFrame) -> pd.Series:
    """B. 50% 룰: 종가 >= L + 0.5*(H-L) AND 거래량 > 20일 평균 AND 양봉.

    H/L은 조정 시작점/저점의 근사로, 당일을 뺀 최근 BOUNCE_LOOKBACK일의 고가/저가를 쓴다.
    """
    high_h = df["High"].shift(1).rolling(BOUNCE_LOOKBACK).max()
    low_l = df["Low"].shift(1).rolling(BOUNCE_LOOKBACK).min()
    recovered = df["Close"] >= (low_l + 0.5 * (high_h - low_l))

    vol_avg20 = df["Volume"].shift(1).rolling(20).mean()
    vol_up = df["Volume"] > vol_avg20

    bullish = df["Close"] > df["Open"]

    return (recovered & vol_up & bullish).fillna(False)


VARIANTS = {
    "A_현재(종가>전일고가)": bounce_current,
    "B_50%룰": bounce_50pct,
    "C_필터없음": lambda df: pd.Series(True, index=df.index),
}


def run_variant(ohlcv: dict[str, pd.DataFrame], spy: pd.Series, bounce_fn) -> pd.DataFrame:
    records: list[dict] = []
    spy_sma200 = spy.rolling(200, min_periods=200).mean()
    cooldown: dict[str, pd.Timestamp] = {}

    for ticker, df in ohlcv.items():
        try:
            sig = base_signal(df) & bounce_fn(df)
        except Exception:
            continue

        close = df["Close"]
        for sig_date in sig[sig].index:
            spy_val = spy.get(sig_date)
            sma_val = spy_sma200.get(sig_date)
            if (spy_val is None or pd.isna(spy_val)
                    or sma_val is None or pd.isna(sma_val)
                    or float(spy_val) < float(sma_val)):
                continue

            last = cooldown.get(ticker)
            if last is not None and (sig_date - last).days < COOLDOWN_DAYS:
                continue
            cooldown[ticker] = sig_date

            entry_price = float(close.loc[sig_date])

            for hd in HOLDING_DAYS:
                exit_target = sig_date + timedelta(days=hd)
                future = close[close.index > exit_target]
                if future.empty:
                    continue
                exit_date = future.index[0]
                exit_price = float(future.iloc[0])
                stock_ret = exit_price / entry_price - 1

                spy_at_entry_s = spy[spy.index >= sig_date]
                spy_at_exit_s = spy[spy.index >= exit_date]
                bench_ret = excess_ret = None
                if not spy_at_entry_s.empty and not spy_at_exit_s.empty:
                    bench_ret = float(spy_at_exit_s.iloc[0]) / float(spy_at_entry_s.iloc[0]) - 1
                    excess_ret = stock_ret - bench_ret

                records.append({
                    "ticker": ticker,
                    "signal_date": sig_date.date(),
                    "holding_days_target": hd,
                    "stock_return_pct": round(stock_ret * 100, 3),
                    "bench_return_pct": round(bench_ret * 100, 3) if bench_ret is not None else None,
                    "excess_return_pct": round(excess_ret * 100, 3) if excess_ret is not None else None,
                })

    return pd.DataFrame(records)


def summarize_variant(df: pd.DataFrame, variant: str) -> pd.DataFrame:
    rows = []
    for hd in HOLDING_DAYS:
        sub = df[df["holding_days_target"] == hd]
        if sub.empty:
            rows.append({"변형": variant, "보유기간": f"{hd}일", "신호수": 0})
            continue
        sr = sub["stock_return_pct"]
        er = sub["excess_return_pct"].dropna()
        rows.append({
            "변형": variant,
            "보유기간": f"{hd}일",
            "신호수": len(sub),
            "유니크종목수": sub["ticker"].nunique(),
            "승률(%)": round((sr > 0).mean() * 100, 1),
            "평균수익률(%)": round(sr.mean(), 2),
            "중앙수익률(%)": round(sr.median(), 2),
            "초과수익평균(%)": round(er.mean(), 2) if len(er) else "N/A",
            "초과수익승률(%)": round((er > 0).mean() * 100, 1) if len(er) else "N/A",
        })
    return pd.DataFrame(rows)


def main() -> None:
    print("=" * 70)
    print("반등 확인 조건 비교: 현재 vs 50% 룰 vs 필터없음")
    print("=" * 70)

    tickers = get_universe_tickers()
    if not tickers:
        sys.exit("유니버스 수집 실패.")

    ohlcv = download_ohlcv(tickers)
    if not ohlcv:
        sys.exit("가격 데이터 없음.")

    print("\nSPY 다운로드 중...")
    spy = download_spy()

    all_results = []
    all_summaries = []
    for name, fn in VARIANTS.items():
        print(f"\n[{name}] 백테스트 실행 중...")
        res = run_variant(ohlcv, spy, fn)
        if res.empty:
            print("  신호 없음.")
            continue
        res["variant"] = name
        all_results.append(res)
        summ = summarize_variant(res, name)
        all_summaries.append(summ)
        print(summ.to_string(index=False))

    if all_results:
        pd.concat(all_results, ignore_index=True).to_csv(RESULTS_CSV, index=False, encoding="utf-8-sig")
        print(f"\n개별 결과 저장: {RESULTS_CSV.name}")
    if all_summaries:
        combined = pd.concat(all_summaries, ignore_index=True)
        combined.to_csv(SUMMARY_CSV, index=False, encoding="utf-8-sig")
        print(f"요약 저장: {SUMMARY_CSV.name}")
        print("\n" + "=" * 70)
        print("종합 비교")
        print("=" * 70)
        print(combined.to_string(index=False))


if __name__ == "__main__":
    main()
