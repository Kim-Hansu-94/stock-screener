"""눌림목 조건을 과거 날짜마다 **실제 스크리너 함수로** 재평가해 NDJSON으로 떨어뜨린다.

왜 이걸 새로 만드나 — 기존 `backtest_pullback.py`로는 안 된다
----------------------------------------------------------------
`docs/backtest-guide.md`의 '알려진 한계 1번'이 이미 지적해 둔 것이다: 기존 백테스트는
자체 `detect_signals()`가 **8개 조건 중 4개만** 구현하고 있어(SMA200 게이트·선행 상승·
반등 확인·RSI 방향이 빠짐) **지금 화면에 뜨는 스크리너를 설명하지 못한다.** 그 가이드가
제시한 해법이 "날짜마다 `src.screener.evaluate_pullback()`을 직접 부르라"였고, 이 스크립트가
그걸 한다. 느리지만 화면과의 파리티가 보장된다.

왜 파이썬이 점수만 내고 성적은 TS가 재나
-----------------------------------------
조건 판정은 파이썬(`src.screener.evaluate_pullback`)에, 손절·목표·R 집계는 TS
(`lib/risk.ts`의 `computeStopTarget`, `lib/scorecard.ts`)에 있다. 어느 한쪽을 포팅하면
`opportunityScore.ts` ↔ `watchlist.py`처럼 **갈라질 동기화 지점**이 새로 생긴다. 그래서
기존 `backtest_bars_dump.py` + `research/backtestEtfStage.ts`와 같은 방식을 쓴다 —
**파이썬이 덤프, TS가 계산.** 양쪽 다 포팅본이 없다.

출력 (NDJSON, 한 줄이 한 (종목, 날짜))
  {"t":"000660","d":"2026-05-02","c":123000.0,"f":["RSI 범위 밖","거래량 미감소"]}

`f`는 **미달 조건 이름 목록**이다(빈 배열 = 전 조건 통과). 이름을 그대로 쓰는 이유는
TS 쪽에서 `scorecard.ts`의 `failedCriteria`에 그대로 넘겨야 하기 때문이다.

실행: MARKET=KR OUT=/tmp/kr.ndjson python -m research.dump_pullback_signals
작업 컨테이너에는 Supabase 자격증명이 없어 Actions에서만 돈다.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv

# 기존 research 스크립트와 같은 방식 — 저장소 루트를 넣고 `pipeline.src`로 가져온다.
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline.src.db import ScreenerDB  # noqa: E402
from pipeline.src.screener import evaluate_pullback  # noqa: E402

load_dotenv()

MARKET = os.environ.get("MARKET", "KR")
OUT = os.environ.get("OUT", "pullback_signals.ndjson")
# 평가에 필요한 최대 구간은 SMA200(200봉)이다. 여유를 둬 뒤쪽 260봉만 넘긴다 —
# 전 이력을 통째로 넘기면 같은 답을 내면서 수십 배 느려진다(pandas 호출 비용).
SLICE = int(os.environ.get("SLICE", "260"))
# 200봉이 모여야 SMA200이 나오므로 그 뒤부터 평가한다.
WARMUP = int(os.environ.get("WARMUP", "205"))
STEP = int(os.environ.get("STEP", "1"))
MAX_TICKERS = int(os.environ.get("MAX_TICKERS", "0")) or None
PAGE = 1000


def fetch_all(query_fn):
    """PostgREST는 한 번에 1000행까지만 주므로 끝까지 넘긴다."""
    out = []
    start = 0
    while True:
        rows = query_fn(start, start + PAGE - 1)
        out.extend(rows)
        if len(rows) < PAGE:
            return out
        start += PAGE


def tickers_with_bars(db: ScreenerDB) -> list[str]:
    """일봉이 실제로 들어 있는 종목 — 여러 시점의 하루치 합집합.

    PostgREST에 DISTINCT가 없어 전체를 훑을 수 없다(종목당 600봉이라 수십만 행).
    하루만 보면 그날 이후 수집이 끊긴 종목이 통째로 빠지므로 앵커를 여러 개 둔다
    (`backtestEtfStage.ts`의 `tickersWithBars`와 같은 방식).
    """
    client = db.client
    latest_rows = (
        client.table("stock_price_history")
        .select("date")
        .eq("market", MARKET)
        .order("date", desc=True)
        .limit(1)
        .execute()
        .data
    )
    if not latest_rows:
        return []
    latest = latest_rows[0]["date"]

    found: set[str] = set()
    for back in (0, 120, 240, 360, 480):
        day_rows = (
            client.table("stock_price_history")
            .select("date")
            .eq("market", MARKET)
            .lte("date", str(pd.Timestamp(latest) - pd.Timedelta(days=back))[:10])
            .order("date", desc=True)
            .limit(1)
            .execute()
            .data
        )
        if not day_rows:
            continue
        day = day_rows[0]["date"]
        rows = fetch_all(
            lambda a, b, _d=day: client.table("stock_price_history")
            .select("ticker")
            .eq("market", MARKET)
            .eq("date", _d)
            .range(a, b)
            .execute()
            .data
        )
        found.update(r["ticker"] for r in rows)
        print(f"  {day}: {len(rows)}종목 (누적 {len(found)})", flush=True)
    return sorted(found)


def main() -> None:
    db = ScreenerDB.from_env()
    print(f"시장 {MARKET} · 슬라이스 {SLICE}봉 · 워밍업 {WARMUP}봉 · 간격 {STEP}일", flush=True)
    print("일봉 보유 종목 조회 중...", flush=True)
    tickers = tickers_with_bars(db)
    if MAX_TICKERS:
        tickers = tickers[:MAX_TICKERS]
    print(f"  → {len(tickers)}종목", flush=True)

    started = time.time()
    written = 0
    passed_total = 0
    with open(OUT, "w", encoding="utf-8") as fh:
        for n, ticker in enumerate(tickers, 1):
            rows = fetch_all(
                lambda a, b, _t=ticker: db.client.table("stock_price_history")
                .select("date, open, high, low, close, volume")
                .eq("market", MARKET)
                .eq("ticker", _t)
                .order("date")
                .range(a, b)
                .execute()
                .data
            )
            if len(rows) < WARMUP + 1:
                continue
            df = pd.DataFrame(rows)
            for col in ("open", "high", "low", "close", "volume"):
                df[col] = pd.to_numeric(df[col], errors="coerce")
            if df[["open", "high", "low", "close", "volume"]].isna().any().any():
                df = df.dropna(subset=["open", "high", "low", "close", "volume"]).reset_index(drop=True)
            if len(df) < WARMUP + 1:
                continue

            for i in range(WARMUP, len(df), STEP):
                lo = max(0, i + 1 - SLICE)
                part = df.iloc[lo : i + 1]
                ev = evaluate_pullback(
                    part["close"], part["volume"], part["high"], part["low"], part["open"],
                    require_sma200=True,
                )
                if ev is None:
                    continue
                fh.write(
                    json.dumps(
                        {
                            "t": ticker,
                            "d": str(df["date"].iloc[i])[:10],
                            "c": float(df["close"].iloc[i]),
                            "f": ev.failed,
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
                written += 1
                if ev.passed:
                    passed_total += 1

            if n % 50 == 0:
                print(
                    f"  ...{n}/{len(tickers)}종목 · {written}행 · 전조건통과 {passed_total}건"
                    f" · {time.time() - started:.0f}초",
                    flush=True,
                )

    print(
        f"\n완료: {written}행 · 전 조건 통과 {passed_total}건 → {OUT}"
        f" ({time.time() - started:.0f}초)",
        flush=True,
    )
    if written == 0:
        print("::error::한 행도 안 나왔다 — 조회나 워밍업 조건을 볼 것", flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
