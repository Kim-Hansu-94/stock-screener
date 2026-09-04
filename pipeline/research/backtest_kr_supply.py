"""
국내 눌림목 + 수급(기관·외국인) 백테스트
==========================================
"눌림목 신호가 뜬 종목 중, 기관·외국인이 사고 있던 종목만 골랐다면 성적이 더 좋았나?"
이 하나를 확인하기 위한 독립 리서치 스크립트다. 사이트/DB는 건드리지 않는다.

기존 backtest_pullback.py(미국)와 다른 점 두 가지가 의도적이다:

1) **조건을 다시 구현하지 않고 프로덕션 함수를 그대로 쓴다.**
   backtest_pullback.py의 detect_signals()는 8개 조건 중 4개만 구현돼 있어
   지금 화면에 뜨는 스크리너와 결과가 다르다. 여기서는
   src.screener.evaluate_pullback()을 날짜마다 호출해 파리티를 보장한다.
   (느리지만, 틀린 숫자를 빨리 얻는 것보다 낫다.)

2) **진입가를 "신호 다음 거래일 시가"로 잡는다.**
   신호는 종가가 나온 뒤에야 계산되므로 신호일 종가로는 살 수 없다. 특히
   눌림목 조건에 '당일 종가 > 전일 고가'가 있어 통과 종목은 구조적으로 다음날
   갭상승 경향이 있다 — 종가 진입으로 재면 그 갭만큼 성적이 부풀려진다.

수급 정의
---------
신호일 기준 직전 SUPPLY_WINDOW 거래일의
    (기관 순매수 + 외국인 순매수) 누적금액 / 거래대금 누적
비율이 SUPPLY_THRESHOLD 이상이면 '양호', 아니면 '불량'으로 가른다.
거래대금으로 나누는 이유: 종목마다 규모가 달라 절대금액은 비교가 안 된다.

사전 준비
---------
pykrx 1.2.8+는 KRX 계정 로그인이 필수다(무료). krx.co.kr 가입 후:
    export KRX_ID=...      (Windows: set KRX_ID=...)
    export KRX_PW=...
    pip install pykrx

실행법: python pipeline/research/backtest_kr_supply.py   (프로젝트 루트에서)
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.src.screener import (  # noqa: E402
    IMPULSE_LOOKBACK_DAYS,
    SMA200_WINDOW,
    evaluate_pullback,
)

# ── 설정 ─────────────────────────────────────────────────────────────
YEARS_BACK = 3
HOLDING_DAYS = [20, 60, 120]      # 거래일 아닌 캘린더일 (기존 백테스트와 동일 기준)
COOLDOWN_DAYS = 30                 # 같은 종목 재진입 쿨다운
KR_MIN_MARKET_CAP = 300_000_000_000  # pipeline.py의 KR_MIN_MARKET_CAP과 동일 (3,000억)

# 수급 판정
SUPPLY_WINDOW = 20                 # 신호일 직전 몇 거래일을 볼지
SUPPLY_THRESHOLD = 0.0             # (기관+외국인)순매수/거래대금 이 값 이상이면 양호

# evaluate_pullback에 넘길 트레일링 윈도우 길이.
# SMA200(200봉) + 임팩트 참조(61봉) + RSI 워밍업 여유를 덮으면 되고, 그 이상은
# 결과가 같으므로 자른다 — 전체 이력을 매번 넘기면 호출당 비용이 계속 커진다.
TRAILING_BARS = max(SMA200_WINDOW, IMPULSE_LOOKBACK_DAYS + 1) + 100

KOSPI_INDEX = "1001"
OUT_DIR = Path(__file__).parent
TRADES_CSV = OUT_DIR / "backtest_kr_supply_trades.csv"
SUMMARY_CSV = OUT_DIR / "backtest_kr_supply_summary.csv"


# ── 순수 계산 (네트워크 불필요 — tests/test_backtest_kr_supply.py가 검증) ──

def trailing_window(df: pd.DataFrame, end_idx: int, bars: int = TRAILING_BARS) -> pd.DataFrame:
    """end_idx(포함)까지의 마지막 `bars`개 행. 미래 데이터가 절대 안 섞이게 하는 지점."""
    start = max(0, end_idx + 1 - bars)
    return df.iloc[start : end_idx + 1]


def supply_ratio(
    inst_net: pd.Series,
    foreign_net: pd.Series,
    trading_value: pd.Series,
    end_idx: int,
    window: int = SUPPLY_WINDOW,
) -> float | None:
    """직전 window 거래일의 (기관+외국인) 순매수 / 거래대금 비율.

    거래대금 합이 0이거나 표본이 모자라면 None — '수급 정보 없음'으로 두고
    양호/불량 어느 쪽으로도 세지 않는다(모르는 걸 한쪽으로 밀면 결과가 왜곡된다).
    """
    start = end_idx + 1 - window
    if start < 0:
        return None
    net = float(inst_net.iloc[start : end_idx + 1].sum()) + float(
        foreign_net.iloc[start : end_idx + 1].sum()
    )
    value = float(trading_value.iloc[start : end_idx + 1].sum())
    if value <= 0:
        return None
    return net / value


def classify_supply(ratio: float | None, threshold: float = SUPPLY_THRESHOLD) -> str:
    """'양호' / '불량' / '정보없음'."""
    if ratio is None:
        return "정보없음"
    return "양호" if ratio >= threshold else "불량"


# ── 데이터 수집 (pykrx) ───────────────────────────────────────────────

def _require_krx_login() -> None:
    if not (os.getenv("KRX_ID") and os.getenv("KRX_PW")):
        sys.exit(
            "KRX_ID / KRX_PW 환경변수가 필요합니다 (pykrx 1.2.8+).\n"
            "  krx.co.kr 무료 가입 후 설정하세요."
        )


def get_kr_universe(as_of: str) -> list[str]:
    """KOSPI 종목 중 시총 하한을 넘는 티커. 프로덕션 유니버스 기준과 맞춘다."""
    from pykrx import stock

    cap = stock.get_market_cap(as_of, market="KOSPI")
    if cap is None or cap.empty:
        sys.exit(f"시가총액 조회 실패 (as_of={as_of}). 날짜가 거래일인지 확인하세요.")
    keep = cap[cap["시가총액"] >= KR_MIN_MARKET_CAP]
    return keep.index.tolist()


def _need_columns(df: pd.DataFrame, cols: list[str], what: str, ticker: str) -> None:
    """pykrx 응답 스키마가 바뀌면 조용히 이상한 값을 내지 말고 여기서 멈춘다."""
    missing = [c for c in cols if c not in df.columns]
    if missing:
        sys.exit(
            f"{what}({ticker}) 응답에 필요한 컬럼이 없습니다: {missing}\n"
            f"  실제 컬럼: {list(df.columns)}\n"
            f"  pykrx 버전이 바뀌었을 수 있습니다 — 컬럼명을 확인해 스크립트를 고치세요."
        )


def fetch_ticker(ticker: str, start: str, end: str) -> pd.DataFrame | None:
    """한 종목의 OHLCV + 투자자별 순매수를 날짜 인덱스로 합친다."""
    from pykrx import stock

    ohlcv = stock.get_market_ohlcv(start, end, ticker)
    if ohlcv is None or ohlcv.empty:
        return None
    _need_columns(ohlcv, ["시가", "고가", "저가", "종가", "거래량", "거래대금"], "OHLCV", ticker)

    flow = stock.get_market_trading_value_by_date(start, end, ticker)
    if flow is None or flow.empty:
        return None
    _need_columns(flow, ["기관합계", "외국인합계"], "투자자별 거래대금", ticker)

    df = pd.DataFrame(
        {
            "open": ohlcv["시가"].astype(float),
            "high": ohlcv["고가"].astype(float),
            "low": ohlcv["저가"].astype(float),
            "close": ohlcv["종가"].astype(float),
            "volume": ohlcv["거래량"].astype(float),
            "trading_value": ohlcv["거래대금"].astype(float),
        }
    )
    df["inst_net"] = flow["기관합계"].reindex(df.index).fillna(0).astype(float)
    df["foreign_net"] = flow["외국인합계"].reindex(df.index).fillna(0).astype(float)
    return df.dropna()


def fetch_kospi(start: str, end: str) -> pd.Series:
    from pykrx import stock

    idx = stock.get_index_ohlcv(start, end, KOSPI_INDEX)
    if idx is None or idx.empty:
        sys.exit("KOSPI 지수 조회 실패.")
    return idx["종가"].astype(float)


# ── 백테스트 ──────────────────────────────────────────────────────────

def backtest_ticker(ticker: str, df: pd.DataFrame, kospi: pd.Series) -> list[dict]:
    """한 종목의 전 구간을 걸으며 신호를 찾고, 각 보유기간 성과를 낸다."""
    records: list[dict] = []
    last_entry: pd.Timestamp | None = None
    n = len(df)

    for i in range(n - 1):  # 마지막 봉은 다음날 시가가 없어 진입 불가
        window = trailing_window(df, i)
        ev = evaluate_pullback(
            window["close"], window["volume"], window["high"], require_sma200=True
        )
        if ev is None or not ev.passed:
            continue

        sig_date = df.index[i]
        if last_entry is not None and (sig_date - last_entry).days < COOLDOWN_DAYS:
            continue
        last_entry = sig_date

        # 진입: 다음 거래일 시가 (신호는 종가 후에야 나오므로 이게 실제 가능한 최초 가격)
        entry_idx = i + 1
        entry_date = df.index[entry_idx]
        entry_price = float(df["open"].iloc[entry_idx])
        if entry_price <= 0:
            continue

        ratio = supply_ratio(df["inst_net"], df["foreign_net"], df["trading_value"], i)
        bucket = classify_supply(ratio)

        for hd in HOLDING_DAYS:
            target = entry_date + pd.Timedelta(days=hd)
            future = df[df.index > target]
            if future.empty:
                continue
            exit_date = future.index[0]
            exit_price = float(future["close"].iloc[0])
            stock_ret = exit_price / entry_price - 1

            bench_ret = None
            k_in = kospi[kospi.index >= entry_date]
            k_out = kospi[kospi.index >= exit_date]
            if not k_in.empty and not k_out.empty:
                bench_ret = float(k_out.iloc[0]) / float(k_in.iloc[0]) - 1

            records.append(
                {
                    "ticker": ticker,
                    "signal_date": sig_date.date(),
                    "entry_date": entry_date.date(),
                    "exit_date": exit_date.date(),
                    "holding_days_target": hd,
                    "entry_price": round(entry_price, 2),
                    "exit_price": round(exit_price, 2),
                    "supply_ratio": round(ratio, 5) if ratio is not None else None,
                    "supply_bucket": bucket,
                    "stock_return_pct": round(stock_ret * 100, 3),
                    "bench_return_pct": round(bench_ret * 100, 3) if bench_ret is not None else None,
                    "excess_return_pct": (
                        round((stock_ret - bench_ret) * 100, 3) if bench_ret is not None else None
                    ),
                }
            )

    return records


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    """보유기간 × 수급버킷 교차 요약. '전체'도 같이 내서 비교 기준을 남긴다."""
    rows = []
    for hd in HOLDING_DAYS:
        base = df[df["holding_days_target"] == hd]
        if base.empty:
            continue
        for bucket in ["전체", "양호", "불량", "정보없음"]:
            sub = base if bucket == "전체" else base[base["supply_bucket"] == bucket]
            if sub.empty:
                continue
            sr = sub["stock_return_pct"]
            er = sub["excess_return_pct"].dropna()
            rows.append(
                {
                    "보유기간": f"{hd}일",
                    "수급": bucket,
                    "신호수": len(sub),
                    "종목수": sub["ticker"].nunique(),
                    "승률(%)": round((sr > 0).mean() * 100, 1),
                    "평균수익(%)": round(sr.mean(), 2),
                    "중앙수익(%)": round(sr.median(), 2),
                    "초과수익(%)": round(er.mean(), 2) if len(er) else None,
                    "초과승률(%)": round((er > 0).mean() * 100, 1) if len(er) else None,
                }
            )
    return pd.DataFrame(rows)


def print_summary(summary: pd.DataFrame) -> None:
    print("\n" + "=" * 78)
    print("국내 눌림목 × 수급(기관+외국인) 백테스트")
    print(f"  진입=신호 다음 거래일 시가 · 수급창={SUPPLY_WINDOW}일 · 기준={SUPPLY_THRESHOLD}")
    print("=" * 78)
    for hd in HOLDING_DAYS:
        sub = summary[summary["보유기간"] == f"{hd}일"]
        if sub.empty:
            continue
        print(f"\n[보유 {hd}일]")
        print(f"  {'수급':<8}{'신호수':>7}{'승률':>9}{'평균수익':>11}{'중앙':>9}{'초과수익':>11}")
        for _, r in sub.iterrows():
            excess = f"{r['초과수익(%)']:>10}%" if r["초과수익(%)"] is not None else f"{'N/A':>11}"
            print(
                f"  {r['수급']:<8}{r['신호수']:>7}{r['승률(%)']:>8}%"
                f"{r['평균수익(%)']:>10}%{r['중앙수익(%)']:>8}%{excess}"
            )
    print(
        "\n※ '양호'가 '전체'보다 뚜렷이 높아야 수급 조건에 값어치가 있습니다."
        "\n  표본이 30건 미만인 칸은 운으로 뒤집히는 범위라 신뢰하지 마세요.\n"
    )


# ── 진입점 ────────────────────────────────────────────────────────────

def main() -> None:
    _require_krx_login()

    end = pd.Timestamp.today().normalize()
    start = end - pd.DateOffset(years=YEARS_BACK)
    s, e = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")

    print(f"기간: {start.date()} ~ {end.date()}")
    print("유니버스 수집 중...")
    tickers = get_kr_universe(e)
    print(f"  KOSPI 시총 {KR_MIN_MARKET_CAP/1e8:,.0f}억 이상: {len(tickers)}종목")

    print("KOSPI 지수 수집 중...")
    kospi = fetch_kospi(s, e)

    print("\n종목별 시세·수급 수집 + 신호 스캔 (KRX 요청이 많아 시간이 걸립니다)...")
    all_records: list[dict] = []
    failed = 0
    for n, ticker in enumerate(tickers, 1):
        sys.stdout.write(f"\r  {n}/{len(tickers)} {ticker}  신호 {len(all_records):,}건  실패 {failed}")
        sys.stdout.flush()
        try:
            df = fetch_ticker(ticker, s, e)
            if df is None or len(df) < TRAILING_BARS // 2:
                failed += 1
                continue
            all_records.extend(backtest_ticker(ticker, df, kospi))
        except SystemExit:
            raise
        except Exception:
            failed += 1
        time.sleep(0.15)  # KRX 과다요청 차단 방지
    print()

    if not all_records:
        print("생성된 신호가 없습니다.")
        return

    trades = pd.DataFrame(all_records)
    trades.to_csv(TRADES_CSV, index=False, encoding="utf-8-sig")
    print(f"\n개별 트레이드 저장: {TRADES_CSV.name} ({len(trades):,}행)")

    summary = summarize(trades)
    summary.to_csv(SUMMARY_CSV, index=False, encoding="utf-8-sig")
    print(f"요약 저장          : {SUMMARY_CSV.name}")
    print_summary(summary)


if __name__ == "__main__":
    main()
