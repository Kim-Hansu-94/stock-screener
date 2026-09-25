"""490590 구성종목 수집 전용 엔트리포인트 (`python -m src.etf_holdings_main`).

본 파이프라인과 분리한 이유는 realestate·kr_market_extras와 같다 — 여기가 실패해도
주식 스크리닝이 죽으면 안 되고, 반대로 구성종목은 하루 한 번이면 충분해서 본
파이프라인의 실행 주기에 얹을 이유가 없다.

**하나도 못 받으면 exit 1.** 조용히 초록불로 끝나면 "매일 갱신되고 있다"고 믿게
되는데, 이 표가 존재하는 이유 자체가 그 믿음이 틀렸던 사고이기 때문이다
(market_indices_main.py와 같은 원칙).
"""

from __future__ import annotations

import sys
from datetime import date, timedelta, timezone

from dotenv import load_dotenv

from .db import ScreenerDB
from .etf_holdings import ETF_CODE, collect_etf_holdings, describe

_KST = timezone(timedelta(hours=9))


def main() -> None:
    load_dotenv()
    db = ScreenerDB.from_env()
    today = date.today()

    print(f"{ETF_CODE} 구성종목 수집 중...", flush=True)
    try:
        rows = collect_etf_holdings(db, today)
    except Exception as exc:  # noqa: BLE001
        print(f"::error::구성종목 수집 실패: {type(exc).__name__}: {exc}", flush=True)
        sys.exit(1)

    if not rows:
        print("::error::구성종목을 하나도 못 받았다", flush=True)
        sys.exit(1)

    print(describe(rows), flush=True)

    # 무엇이 바뀌었는지 로그에 남긴다 — 리밸런싱을 모르고 지나가는 것이 이 표를
    # 만든 이유라, "저장했다"만 찍으면 그 목적을 반만 달성한다.
    try:
        before = (
            db.client.table("etf_holdings")
            .select("ticker, name")
            .eq("etf_ticker", ETF_CODE)
            .execute()
        ).data or []
        old = {r["name"] for r in before}
        new = {r["name"] for r in rows}
        if before and old != new:
            added = sorted(new - old)
            removed = sorted(old - new)
            if added:
                print(f"  ⚠ 새로 들어온 종목: {', '.join(added)}", flush=True)
            if removed:
                print(f"  ⚠ 빠진 종목: {', '.join(removed)}", flush=True)
    except Exception as exc:  # noqa: BLE001
        # 비교는 부가 정보일 뿐이라 여기서 실패해도 저장은 계속한다.
        print(f"  (이전 구성과 비교 실패: {exc})", flush=True)

    db.save_etf_holdings(rows)


if __name__ == "__main__":
    main()
