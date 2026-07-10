"""
S&P 500 단계별 분할 매수 백테스트
==================================
매월 첫 거래일 $1,000 적립을 공통 전제로 세 전략 비교:
  A) 즉시 매수 (정기 DCA)
  B) 단계별 분할 — 조정 단계 진입 시 (사이클 투입액+현금)의 누적 목표
     비율(20/50/80/100%)까지 투입, 신고가 회복 시 사이클 리셋
  C) 단일 임계값 — 사이클당 -10% 첫 진입 시 현금 전량 투입
기간: 2000-01-01~현재, 2010-01-01~현재 두 구간
실행: python pipeline/research/backtest_sp500_stages.py
"""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import yfinance as yf

OUT_CSV = Path(__file__).parent / "backtest_sp500_stages_summary.csv"
MONTHLY = 1_000.0
HIGH_LOOKBACK = 252
CUM_TARGET = {1: 0.20, 2: 0.50, 3: 0.80, 4: 1.00}
THRESHOLDS = [(4, -30.0), (3, -20.0), (2, -10.0), (1, -5.0)]


def stage_for(dd: float) -> int:
    for stage, th in THRESHOLDS:
        if dd <= th + 1e-9:
            return stage
    return 0


def load_daily(start: str) -> pd.DataFrame:
    raw = yf.download("^GSPC", start=start, auto_adjust=True, progress=False)
    close = raw["Close"]
    if isinstance(close, pd.DataFrame):
        close = close["^GSPC"]
    close = close.dropna()
    high = close.rolling(HIGH_LOOKBACK, min_periods=1).max()
    dd = (close / high - 1.0) * 100.0
    stages = dd.map(stage_for)
    cycle_ids, cycle_id, dipped = [], 0, False
    for d, s in zip(dd, stages):
        if dipped and d >= -1e-9:
            cycle_id += 1
            dipped = False
        if s >= 1:
            dipped = True
        cycle_ids.append(cycle_id)
    df = pd.DataFrame({"close": close, "dd": dd, "stage": stages, "cycle": cycle_ids})
    periods = df.index.to_period("M")
    df["is_contrib_day"] = ~periods.duplicated(keep="first")
    return df


def run_regular(df: pd.DataFrame) -> dict:
    shares = invested = 0.0
    for row in df.itertuples():
        if row.is_contrib_day:
            shares += MONTHLY / row.close
            invested += MONTHLY
    return _summary("A. 정기 DCA", df, shares, 0.0, invested)


def run_staged(df: pd.DataFrame) -> dict:
    cash = shares = invested = cycle_spent = 0.0
    seen_cycle, max_stage = -1, 0
    for row in df.itertuples():
        if row.is_contrib_day:
            cash += MONTHLY
            invested += MONTHLY
        if row.cycle != seen_cycle:
            seen_cycle, max_stage, cycle_spent = row.cycle, 0, 0.0
        if row.stage > max_stage:
            target = CUM_TARGET[row.stage] * (cycle_spent + cash)
            buy = min(max(0.0, target - cycle_spent), cash)
            shares += buy / row.close
            cash -= buy
            cycle_spent += buy
            max_stage = row.stage
    return _summary("B. 단계별 분할 (20/50/80/100)", df, shares, cash, invested)


def run_single_threshold(df: pd.DataFrame, threshold: float = -10.0) -> dict:
    cash = shares = invested = 0.0
    seen_cycle, bought = -1, False
    for row in df.itertuples():
        if row.is_contrib_day:
            cash += MONTHLY
            invested += MONTHLY
        if row.cycle != seen_cycle:
            seen_cycle, bought = row.cycle, False
        if not bought and row.dd <= threshold + 1e-9 and cash > 0:
            shares += cash / row.close
            cash, bought = 0.0, True
    return _summary(f"C. 단일 임계값 ({threshold:.0f}%)", df, shares, cash, invested)


def _summary(name: str, df: pd.DataFrame, shares: float, cash: float, invested: float) -> dict:
    last = float(df["close"].iloc[-1])
    final = shares * last + cash
    return {
        "strategy": name,
        "invested": round(invested),
        "final_value": round(final),
        "multiple": round(final / invested, 3),
        "end_cash": round(cash),
    }


def main() -> None:
    all_rows = []
    for start in ["2000-01-01", "2010-01-01"]:
        df = load_daily(start)
        for res in [run_regular(df), run_staged(df), run_single_threshold(df)]:
            all_rows.append({"start": start, **res})
    out = pd.DataFrame(all_rows)
    out.to_csv(OUT_CSV, index=False)
    print(out.to_string(index=False))


if __name__ == "__main__":
    main()
