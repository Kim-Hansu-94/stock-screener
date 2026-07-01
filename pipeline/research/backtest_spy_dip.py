"""
SPY 조정 매수 vs 정기 적립식 백테스트
========================================
전략 A: 매월 첫 거래일에 $1,000 정기 매수 (Regular DCA)
전략 B: 매월 체크 시 가격이 N일 고점 대비 X% 이상 하락했을 때만 매수 (Dip DCA)
         조건 미충족 시 현금 적립 → 다음 달 조건 충족 시 적립 현금 전량 투입

임계값: 5%, 10%, 15%, 20%, 25% (고점 대비 하락률)
기간  : 2010-01-01 ~ 현재 (약 15년)
고점기준: 최근 252 거래일 (약 1년)

실행법: python pipeline/research/backtest_spy_dip.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf

OUT_DIR = Path(__file__).parent
SUMMARY_CSV = OUT_DIR / "backtest_spy_dip_summary.csv"
MONTHLY_CSV = OUT_DIR / "backtest_spy_dip_monthly.csv"

START_DATE = "2010-01-01"
MONTHLY_CONTRIBUTION = 1_000.0   # USD
HIGH_LOOKBACK_DAYS = 252          # 고점 기준 (약 1년)
DIP_THRESHOLDS = [0.05, 0.10, 0.15, 0.20, 0.25]


# ── 데이터 ────────────────────────────────────────────────────────────

def download_spy() -> pd.Series:
    end = pd.Timestamp.today().normalize()
    raw = yf.download("SPY", start=START_DATE, end=end.strftime('%Y-%m-%d'), auto_adjust=True, progress=False)
    close = raw["Close"].squeeze()
    close.name = "SPY"
    return close.dropna()


def get_monthly_first_dates(close: pd.Series) -> pd.DatetimeIndex:
    """매월 첫 거래일 반환."""
    periods = close.index.to_period('M')
    mask = ~periods.duplicated(keep='first')
    return close.index[mask]


# ── 전략 A: 정기 적립식 ───────────────────────────────────────────────

def run_regular_dca(close: pd.Series, buy_dates: pd.DatetimeIndex) -> pd.DataFrame:
    shares = 0.0
    total_invested = 0.0
    records = []

    for d in buy_dates:
        price = float(close.loc[d])
        bought_shares = MONTHLY_CONTRIBUTION / price
        shares += bought_shares
        total_invested += MONTHLY_CONTRIBUTION

        records.append({
            "date": d,
            "price": price,
            "bought": MONTHLY_CONTRIBUTION,
            "cash_reserve": 0.0,
            "total_shares": shares,
            "total_invested": total_invested,
            "portfolio_value": shares * price,
            "total_value_incl_cash": shares * price,
        })

    return pd.DataFrame(records)


# ── 전략 B: 조정 매수 ─────────────────────────────────────────────────

def run_dip_dca(close: pd.Series, buy_dates: pd.DatetimeIndex, threshold: float) -> pd.DataFrame:
    rolling_high = close.rolling(HIGH_LOOKBACK_DAYS, min_periods=1).max()

    shares = 0.0
    total_invested = 0.0
    cash_reserve = 0.0
    records = []

    for d in buy_dates:
        cash_reserve += MONTHLY_CONTRIBUTION
        price = float(close.loc[d])
        high = float(rolling_high.loc[d])
        drawdown = (high - price) / high if high > 0 else 0.0

        if drawdown >= threshold:
            new_shares = cash_reserve / price
            shares += new_shares
            total_invested += cash_reserve
            bought = cash_reserve
            cash_reserve = 0.0
        else:
            bought = 0.0

        records.append({
            "date": d,
            "price": price,
            "rolling_high": round(high, 2),
            "drawdown_pct": round(drawdown * 100, 2),
            "threshold_pct": threshold * 100,
            "bought": bought,
            "cash_reserve": round(cash_reserve, 2),
            "total_shares": shares,
            "total_invested": total_invested,
            "portfolio_value": shares * price,
            "total_value_incl_cash": shares * price + cash_reserve,
        })

    return pd.DataFrame(records)


# ── 지표 계산 ─────────────────────────────────────────────────────────

def compute_metrics(df: pd.DataFrame, strategy: str) -> dict:
    start_date = df["date"].iloc[0]
    end_date = df["date"].iloc[-1]
    years = (end_date - start_date).days / 365.25

    total_invested_committed = df["date"].count() * MONTHLY_CONTRIBUTION
    total_invested_deployed = df["total_invested"].iloc[-1]
    cash_left = df["cash_reserve"].iloc[-1]
    final_value = df["total_value_incl_cash"].iloc[-1]

    total_return = (final_value / total_invested_committed - 1) * 100 if total_invested_committed > 0 else 0
    cagr = ((final_value / total_invested_committed) ** (1 / years) - 1) * 100 if years > 0 else 0

    # 최대 낙폭 (total_value_incl_cash 기준)
    val = df["total_value_incl_cash"]
    rolling_max = val.cummax()
    dd_series = (val - rolling_max) / rolling_max.replace(0, np.nan) * 100
    max_drawdown = dd_series.min()

    # Sharpe (월별 수익률 기준)
    monthly_ret = val.pct_change().dropna()
    sharpe = (monthly_ret.mean() / monthly_ret.std() * np.sqrt(12)) if monthly_ret.std() > 0 else 0.0

    buy_count = int((df["bought"] > 0).sum())
    total_months = len(df)

    return {
        "전략": strategy,
        "총_월수": total_months,
        "실제_매수_횟수": buy_count,
        "미매수_월수": total_months - buy_count,
        "총_납입금($)": round(total_invested_committed, 0),
        "실제_투자금($)": round(total_invested_deployed, 0),
        "잔여_현금($)": round(cash_left, 0),
        "최종가치(현금포함)($)": round(final_value, 0),
        "총수익률(%)": round(total_return, 1),
        "CAGR(%)": round(cagr, 1),
        "최대낙폭(%)": round(max_drawdown, 1),
        "Sharpe(월간)": round(sharpe, 2),
    }


# ── 출력 ──────────────────────────────────────────────────────────────

def print_results(summary: pd.DataFrame) -> None:
    print("\n" + "=" * 80)
    print(f"SPY 조정 매수 vs 정기 적립식  ({START_DATE} ~ 현재)")
    print(f"월 납입금: ${MONTHLY_CONTRIBUTION:,.0f}  |  고점 기준: {HIGH_LOOKBACK_DAYS}거래일(약 1년)")
    print("=" * 80)

    cols_order = [
        "전략", "총_월수", "실제_매수_횟수", "미매수_월수",
        "총_납입금($)", "잔여_현금($)", "최종가치(현금포함)($)",
        "총수익률(%)", "CAGR(%)", "최대낙폭(%)", "Sharpe(월간)",
    ]
    print(summary[cols_order].to_string(index=False))

    print("\n[해석]")
    reg_row = summary[summary["전략"] == "Regular DCA"].iloc[0]
    for _, row in summary[summary["전략"] != "Regular DCA"].iterrows():
        diff = round(row["CAGR(%)"] - reg_row["CAGR(%)"], 2)
        sign = "+" if diff >= 0 else ""
        print(
            f"  {row['전략']:22s} CAGR {sign}{diff:+.2f}%p  "
            f"매수횟수 {row['실제_매수_횟수']}/{row['총_월수']}  "
            f"잔여현금 ${row['잔여_현금($)']:,.0f}"
        )


# ── 진입점 ────────────────────────────────────────────────────────────

def main() -> None:
    print("SPY 데이터 다운로드 중...")
    close = download_spy()
    print(f"  {close.index[0].date()} ~ {close.index[-1].date()}  ({len(close):,}거래일)")

    buy_dates = get_monthly_first_dates(close)
    print(f"  월별 체크 포인트: {len(buy_dates)}회\n")

    results: list[dict] = []
    monthly_parts: list[pd.DataFrame] = []

    # 전략 A
    rec_a = run_regular_dca(close, buy_dates)
    results.append(compute_metrics(rec_a, "Regular DCA"))
    monthly_parts.append(rec_a.assign(strategy="Regular DCA"))

    # 전략 B
    for thr in DIP_THRESHOLDS:
        label = f"Dip DCA ({thr*100:.0f}%)"
        sys.stdout.write(f"\r  [{label}] 시뮬레이션 중...")
        sys.stdout.flush()
        rec_b = run_dip_dca(close, buy_dates, thr)
        results.append(compute_metrics(rec_b, label))
        monthly_parts.append(rec_b.assign(strategy=label))

    print()

    summary_df = pd.DataFrame(results)
    summary_df.to_csv(SUMMARY_CSV, index=False, encoding="utf-8-sig")

    all_monthly = pd.concat(monthly_parts, ignore_index=True)
    all_monthly.to_csv(MONTHLY_CSV, index=False, encoding="utf-8-sig")

    print_results(summary_df)
    print(f"\n요약 저장: {SUMMARY_CSV.name}")
    print(f"월별 저장: {MONTHLY_CSV.name}")


if __name__ == "__main__":
    main()
