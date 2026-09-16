"""백테스트용 미국 일봉을 **DB에 넣지 않고** 파일로 떨어뜨린다.

왜 이게 따로 있나 — `frontend/research/backtestEtfStage.ts`가 `stock_price_history`를
읽는데, 거기엔 **S&P500 + NASDAQ100만** 들어 있다(`main.py`의 `US_OPP_INDEXES`).
Russell 3000은 본 파이프라인이 매 실행 yfinance로 받기는 하지만(`main.py:499~`)
패턴 유사도 계산에만 쓰고 저장하지 않는다. **저장을 안 하는 게 실수가 아니라 용량
제약이다** — Supabase 무료 플랜 500MB 중 이미 426MB를 쓰고 있었고 그중
`idx_sph_daily_bars` 하나가 146MB였다(`supabase/index_slimdown.sql`). 일봉 보관을
3년 → 600일로 줄인 것도 같은 이유다. Russell 2,400종목을 더 넣으면 한도를 넘는다.

그래서 백테스트는 **DB를 늘리는 대신 그때그때 받아서 파일로 쓴다.** 워크플로가 끝나면
파일도 같이 사라지므로 저장 용량에 영향이 없고, 표본은 S&P500+NASDAQ100(약 600종목)에서
유니버스 전체(수천 종목)로 넓어진다.

출력은 NDJSON이고 한 줄이 한 종목이다 — 통째로 하나의 JSON 배열로 쓰면 읽는 쪽이
전부 메모리에 올려야 하고, 중간에 실패하면 파일 전체가 못 쓰게 된다.

    {"ticker":"AAPL","bars":[["2026-01-02",1.0,2.0,0.5,1.5,1000], ...]}

열 순서는 date, open, high, low, close, volume. 키 이름을 매 행마다 반복하면
파일이 서너 배로 커져서 배열로 쓴다(읽는 쪽이 같은 순서를 알고 있다).

실행:
    python -m src.backtest_bars_dump              # 기본 out/backtest_bars.ndjson
    BARS_OUT=/tmp/x.ndjson LOOKBACK_DAYS=760 python -m src.backtest_bars_dump
"""

from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

from . import prices_us
from .db import ScreenerDB

# 600일(일봉 보관 기간)보다 넉넉히 받는다 — 백테스트가 판정에 66봉, 성과 관찰에 60봉을
# 더 쓰므로 창이 짧으면 종목당 표본이 몇 개 안 나온다. 휴장일을 감안해 달력 일수로 준다.
DEFAULT_LOOKBACK_DAYS = 760
# yfinance가 상장폐지·티커 변경 종목에 빈 프레임을 주는 건 정상이다. 다만 **전부** 비면
# 수집 자체가 깨진 것이므로 그때는 실패로 끝낸다(조용히 초록불로 끝나면 안 된다).
MIN_SUCCESS_RATIO = 0.3


def _universe_tickers(db: ScreenerDB) -> list[str]:
    """stock_universe의 US 종목 전부 — 지수·시총으로 좁히지 않는다.

    좁히는 순간 "일봉이 있는 종목"과 "훑는 종목"이 또 어긋난다. 백테스트가 바로 그
    어긋남 때문에 1,000개를 훑고 103종목만 건졌다(2026-09-16).
    """
    tickers: list[str] = []
    page = 1000
    start = 0
    while True:
        result = (
            db.client.table("stock_universe")
            .select("ticker")
            .eq("market", "US")
            .range(start, start + page - 1)
            .execute()
        )
        rows = result.data or []
        tickers.extend(r["ticker"] for r in rows)
        if len(rows) < page:
            break
        start += page
    # 중복 제거(같은 티커가 두 지수에 속할 수 있다)하되 순서는 유지한다.
    seen: set[str] = set()
    unique = [t for t in tickers if not (t in seen or seen.add(t))]
    return unique


def main() -> None:
    out_path = Path(os.environ.get("BARS_OUT", "out/backtest_bars.ndjson"))
    lookback = int(os.environ.get("LOOKBACK_DAYS", DEFAULT_LOOKBACK_DAYS))
    today = date.today()

    db = ScreenerDB.from_env()
    tickers = _universe_tickers(db)
    print(f"stock_universe US: {len(tickers)}종목", flush=True)
    if not tickers:
        raise SystemExit("stock_universe에 US 종목이 없습니다 — 본 파이프라인이 먼저 돌아야 합니다.")

    print(f"일봉 수집 중 ({lookback}일, yfinance 배치)...", flush=True)
    histories = prices_us.get_opportunity_histories(tickers, today, lookback_days=lookback)
    print(f"  → {len(histories)}/{len(tickers)}종목 수신", flush=True)

    ratio = len(histories) / len(tickers)
    if ratio < MIN_SUCCESS_RATIO:
        raise SystemExit(
            f"수신 비율이 {ratio:.0%}로 너무 낮습니다 — yfinance 쪽 문제일 수 있습니다. "
            "조용히 성공으로 끝내면 '표본이 원래 이만큼'으로 오해하게 되므로 실패로 끝냅니다."
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    written = 0
    rows_total = 0
    with out_path.open("w", encoding="utf-8") as f:
        for ticker, hist in histories.items():
            bars = []
            for idx, row in hist.iterrows():
                day = idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10]
                bars.append([
                    day,
                    float(row.get("Open", 0)),
                    float(row.get("High", 0)),
                    float(row.get("Low", 0)),
                    float(row.get("Close", 0)),
                    int(row.get("Volume", 0) or 0),
                ])
            if not bars:
                continue
            f.write(json.dumps({"ticker": ticker, "bars": bars}, separators=(",", ":")) + "\n")
            written += 1
            rows_total += len(bars)

    size_mb = out_path.stat().st_size / 1024 / 1024
    print(f"  → {out_path} 저장: {written}종목 / {rows_total}봉 / {size_mb:.1f}MB", flush=True)


if __name__ == "__main__":
    main()
