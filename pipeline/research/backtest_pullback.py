"""
눌림목 매수 스크리너 백테스트
================================
신호 조건 (screener.py passes_pullback_filter 동일):
  - 장기 상승 추세: SMA60 상향 + 종가 > SMA60
  - 눌림목 구간: SMA20 <= 종가 <= SMA10
  - RSI 40-60
  - 거래량 감소: 5일 평균 < 직전 20일 평균

진입 : 신호 당일 종가
청산 : 20 / 60 / 120 캘린더일 후 첫 거래일 종가
벤치 : SPY 동일 기간 수익률
쿨다운: 종목별 30 캘린더일 (중복 매수 방지)
기간  : 최근 3년

실행법: python -m pipeline.research.backtest_pullback  (프로젝트 루트에서)
         python pipeline/research/backtest_pullback.py  (직접 실행)
"""

from __future__ import annotations

import sys
from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

# ── 설정 ─────────────────────────────────────────────────────────────
YEARS_BACK = 3
HOLDING_DAYS = [20, 60, 120]
COOLDOWN_DAYS = 30
MIN_BARS = 85           # screener.py MIN_HISTORY_DAYS
OUT_DIR = Path(__file__).parent
RESULTS_CSV = OUT_DIR / "backtest_pullback_results.csv"
SUMMARY_CSV = OUT_DIR / "backtest_pullback_summary.csv"


# ── 지표 계산 (벡터화 버전) ───────────────────────────────────────────

def _rsi(close: pd.Series, window: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(window).mean()
    loss = (-delta.clip(upper=0)).rolling(window).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))


def detect_signals(close: pd.Series, volume: pd.Series) -> pd.Series:
    """
    lookahead 없이 벡터화된 눌림목 신호 탐지.
    신호 당일까지의 데이터만 사용 (rolling 윈도우는 과거만 참조).
    """
    sma10 = close.rolling(10).mean()
    sma20 = close.rolling(20).mean()
    sma60 = close.rolling(60).mean()
    rsi14 = _rsi(close, 14)

    # 장기 상승 추세: SMA60[t] > SMA60[t-5] AND 종가 > SMA60
    long_term_up = (sma60 > sma60.shift(5)) & (close > sma60)

    # 눌림목 구간: SMA20 <= 종가 <= SMA10
    in_pullback = (sma20 <= close) & (close <= sma10)

    # RSI 40-60
    rsi_ok = (rsi14 >= 40) & (rsi14 <= 60)

    # 거래량 감소: 최근 5일 평균 < 직전 20일 평균 (offset 5일)
    vol5 = volume.rolling(5).mean()
    vol_baseline = volume.shift(5).rolling(20).mean()
    vol_declining = vol5 < vol_baseline

    sig = long_term_up & in_pullback & rsi_ok & vol_declining
    # MIN_BARS 미만 구간 무효화 (lookback 부족)
    if len(sig) > MIN_BARS:
        sig.iloc[:MIN_BARS] = False
    else:
        sig[:] = False

    return sig.fillna(False)


# ── 유니버스 ──────────────────────────────────────────────────────────

def _try_ndx_tickers() -> list[str]:
    """Wikipedia NASDAQ-100 에서 티커 추출 (테이블 번호가 페이지마다 다를 수 있어 유연하게 처리)."""
    tables = pd.read_html("https://en.wikipedia.org/wiki/Nasdaq-100")
    for t in tables:
        cols = [c for c in t.columns if str(c).lower() in ("ticker", "symbol")]
        if cols:
            return t[cols[0]].dropna().tolist()
    return []


def get_universe_tickers() -> list[str]:
    """S&P 500 + NASDAQ 100 티커 (중복 제거)."""
    print("유니버스 수집 중...")
    tickers: set[str] = set()

    try:
        sp500 = pd.read_html("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies")[0]
        syms = sp500["Symbol"].str.replace(".", "-", regex=False).tolist()
        tickers.update(syms)
        print(f"  S&P 500: {len(syms)}개")
    except Exception as e:
        print(f"  S&P 500 실패: {e}")

    try:
        ndx = _try_ndx_tickers()
        tickers.update(ndx)
        print(f"  NASDAQ 100: {len(ndx)}개")
    except Exception as e:
        print(f"  NASDAQ 100 실패: {e}")

    tickers.discard("SPY")
    result = sorted(tickers)
    print(f"  총 유니버스: {len(result)}개")
    return result


# ── 가격 데이터 다운로드 ──────────────────────────────────────────────

def download_prices(tickers: list[str]) -> dict[str, pd.DataFrame]:
    """배치 다운로드. dict[ticker -> DataFrame(close, volume)] 반환."""
    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)
    print(f"\n가격 데이터 다운로드 ({start.date()} ~ {end.date()}) ...")
    print("  (약 10-20분 소요 예상)")

    batch_size = 100
    close_parts: list[pd.DataFrame] = []
    volume_parts: list[pd.DataFrame] = []
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
            if isinstance(raw.columns, pd.MultiIndex):
                c = raw["Close"]
                v = raw["Volume"]
            else:
                # 단일 티커
                c = raw[["Close"]].rename(columns={"Close": batch[0]})
                v = raw[["Volume"]].rename(columns={"Volume": batch[0]})
            close_parts.append(c)
            volume_parts.append(v)
        except Exception as e:
            print(f"\n  배치 {bn} 오류: {e}")

    print()
    if not close_parts:
        return {}

    close_df = pd.concat(close_parts, axis=1)
    volume_df = pd.concat(volume_parts, axis=1)
    # 중복 열 제거 (배치 경계에 같은 티커가 두 번 들어가는 경우)
    close_df = close_df.loc[:, ~close_df.columns.duplicated()]
    volume_df = volume_df.loc[:, ~volume_df.columns.duplicated()]

    min_rows = MIN_BARS + max(HOLDING_DAYS) // 4  # 신호 + 청산에 필요한 최소 행수
    prices: dict[str, pd.DataFrame] = {}
    for t in close_df.columns:
        c = close_df[t].dropna()
        if len(c) < min_rows:
            continue
        v = volume_df[t].reindex(c.index).fillna(0) if t in volume_df.columns else pd.Series(0.0, index=c.index)
        prices[t] = pd.DataFrame({"close": c, "volume": v})

    print(f"  유효 종목: {len(prices)}개 (데이터 부족 종목 제외)")
    return prices


def download_spy() -> pd.Series:
    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)
    raw = yf.download("SPY", start=start, end=end, auto_adjust=True, progress=False)
    return raw["Close"].dropna()


# ── 백테스트 ──────────────────────────────────────────────────────────

def run_backtest(prices: dict[str, pd.DataFrame], spy: pd.Series) -> pd.DataFrame:
    records: list[dict] = []
    total = len(prices)
    cooldown: dict[str, pd.Timestamp] = {}

    for idx, (ticker, df) in enumerate(prices.items()):
        sys.stdout.write(f"\r신호 스캔: {idx+1}/{total} ({ticker:>6})  ")
        sys.stdout.flush()

        close = df["close"]
        volume = df["volume"]

        try:
            sig = detect_signals(close, volume)
        except Exception:
            continue

        for sig_date in sig[sig].index:
            # 쿨다운: 같은 종목 30일 이내 중복 신호 제외
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

                # SPY 벤치마크 (동일 기간)
                spy_at_entry_s = spy[spy.index >= sig_date]
                spy_at_exit_s = spy[spy.index >= exit_date]
                bench_ret: float | None = None
                excess_ret: float | None = None
                if not spy_at_entry_s.empty and not spy_at_exit_s.empty:
                    bench_ret = float(spy_at_exit_s.iloc[0]) / float(spy_at_entry_s.iloc[0]) - 1
                    excess_ret = stock_ret - bench_ret

                records.append({
                    "ticker": ticker,
                    "signal_date": sig_date.date(),
                    "exit_date": exit_date.date(),
                    "holding_days_target": hd,
                    "entry_price": round(entry_price, 4),
                    "exit_price": round(exit_price, 4),
                    "stock_return_pct": round(stock_ret * 100, 3),
                    "bench_return_pct": round(bench_ret * 100, 3) if bench_ret is not None else None,
                    "excess_return_pct": round(excess_ret * 100, 3) if excess_ret is not None else None,
                })

    print()
    return pd.DataFrame(records)


# ── 요약 통계 ─────────────────────────────────────────────────────────

def summarize(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for hd in HOLDING_DAYS:
        sub = df[df["holding_days_target"] == hd]
        if sub.empty:
            continue
        sr = sub["stock_return_pct"]
        er = sub["excess_return_pct"].dropna()
        br = sub["bench_return_pct"].dropna()

        # Sharpe (연환산): 일별 수익률 근사로 간단 계산
        trading_days_per_year = 252
        annual_factor = trading_days_per_year / (hd * 252 / 365)
        sharpe = (sr.mean() / sr.std() * np.sqrt(annual_factor)) if sr.std() > 0 else 0.0

        rows.append({
            "보유기간": f"{hd}일",
            "총신호수": len(sub),
            "유니크종목수": sub["ticker"].nunique(),
            "승률(%)": round((sr > 0).mean() * 100, 1),
            "평균수익률(%)": round(sr.mean(), 2),
            "중앙수익률(%)": round(sr.median(), 2),
            "최대수익(%)": round(sr.max(), 2),
            "최대손실(%)": round(sr.min(), 2),
            "SPY평균(%)": round(br.mean(), 2) if len(br) else "N/A",
            "초과수익평균(%)": round(er.mean(), 2) if len(er) else "N/A",
            "초과수익승률(%)": round((er > 0).mean() * 100, 1) if len(er) else "N/A",
            "Sharpe(간이)": round(sharpe, 2),
        })
    return pd.DataFrame(rows)


def print_summary(summary: pd.DataFrame) -> None:
    print("\n" + "=" * 70)
    print("눌림목 스크리너 백테스트 결과 요약")
    print("=" * 70)
    for _, row in summary.iterrows():
        print(f"\n[보유기간 {row['보유기간']}]")
        print(f"  신호 수     : {row['총신호수']} (종목 {row['유니크종목수']}개)")
        print(f"  승률        : {row['승률(%)']}%")
        print(f"  평균 수익률 : {row['평균수익률(%)']}%")
        print(f"  중앙 수익률 : {row['중앙수익률(%)']}%")
        print(f"  최대 수익   : {row['최대수익(%)']}%")
        print(f"  최대 손실   : {row['최대손실(%)']}%")
        print(f"  SPY 평균    : {row['SPY평균(%)']}%")
        print(f"  초과 수익   : {row['초과수익평균(%)']}%  (초과 승률 {row['초과수익승률(%)']}%)")
        print(f"  Sharpe(간이): {row['Sharpe(간이)']}")
    print()


# ── 진입점 ────────────────────────────────────────────────────────────

def main() -> None:
    print("=" * 70)
    print("눌림목 매수 스크리너 백테스트  (최근 3년, S&P500 + NASDAQ100)")
    print("=" * 70)

    tickers = get_universe_tickers()
    if not tickers:
        sys.exit("유니버스 수집 실패.")

    prices = download_prices(tickers)
    if not prices:
        sys.exit("가격 데이터 없음.")

    print("\nSPY 다운로드 중...")
    spy = download_spy()

    print("\n백테스트 실행 중...")
    results = run_backtest(prices, spy)

    if results.empty:
        print("생성된 신호가 없습니다.")
        return

    results.to_csv(RESULTS_CSV, index=False, encoding="utf-8-sig")
    print(f"개별 결과 저장: {RESULTS_CSV.name}  ({len(results):,}행)")

    summary = summarize(results)
    summary.to_csv(SUMMARY_CSV, index=False, encoding="utf-8-sig")
    print(f"요약 저장      : {SUMMARY_CSV.name}")

    print_summary(summary)


if __name__ == "__main__":
    main()
