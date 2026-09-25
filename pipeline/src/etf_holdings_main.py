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

# 화면이 실제로 쓰는 구성종목 (frontend/lib/etfEntryCheck.ts의 FALLBACK_PROXY_HOLDINGS).
# **둘은 손으로 맞춰야 하는 동기화 지점이다** — TS를 파싱해서 읽을 수도 있지만, 그러면
# 파이프라인이 프론트 소스 구조에 묶여 리팩터링 한 번에 조용히 깨진다. 여기선 티커만
# 알면 되고(비중은 화면 쪽만 쓴다) 목록이 바뀌는 일 자체가 드물어서 상수로 둔다.
# 어긋나면 이 스크립트가 "바뀌었다"고 잘못 알릴 뿐이라 안전한 쪽으로 실패한다.
KNOWN_TICKERS = frozenset({
    "MRVL", "NVDA", "GOOGL", "INTC", "AMD", "MU", "META", "TSM",
    "VRT", "AVGO", "PLTR", "ANET", "ORCL", "AMZN", "MSFT",
})


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

    # 어제와 뭐가 달라졌는지 (부가 정보)
    try:
        before = (
            db.client.table("etf_holdings")
            .select("ticker, name")
            .eq("etf_ticker", ETF_CODE)
            .execute()
        ).data or []
        prev_names = {r["name"] for r in before}
        now_names = {r["name"] for r in rows}
        if before and prev_names != now_names:
            if added := sorted(now_names - prev_names):
                print(f"  어제 대비 새로 들어옴: {', '.join(added)}", flush=True)
            if removed := sorted(prev_names - now_names):
                print(f"  어제 대비 빠짐: {', '.join(removed)}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"  (이전 구성과 비교 실패: {exc})", flush=True)

    db.save_etf_holdings(rows)

    # ── 화면이 쓰는 목록과 어긋나면 **사람을 부른다** ──────────────────────
    # 화면의 비중은 사용자가 증권사 앱에서 확인해 코드(FALLBACK_PROXY_HOLDINGS)에
    # 적어 둔 실측값이다. 네이버 자동 수집은 그걸 대신하지 못한다(주식 수 순 상위
    # 10개라 비싼 종목이 빠져 64%만 덮는다) — **대신 바뀐 것을 알아채는 역할**을 한다.
    #
    # 여기서 `::error::` + exit 1을 내는 건 수집이 실패해서가 아니라, **화면이 지금
    # 낡은 바구니로 신호등을 계산하고 있어 사람 손이 필요한 상태**이기 때문이다.
    # 초록불로 끝내면 로그를 들여다보는 사람이 없어 또 모르고 지나간다 — 실제로
    # 10개 중 5개가 어긋난 채로 며칠을 갔다(2026-09-25). 워크플로가 빨간불이면
    # GitHub이 저장소 주인에게 메일을 보내므로, 새 시크릿 없이 알림이 닿는다.
    # 사이트에 들어오면 같은 내용이 팝업으로도 뜬다(`/api/alerts`의 holdingsChange).
    unknown = sorted(
        f"{r['name']} ({r['ticker']})" for r in rows
        if r["ticker"] and r["ticker"] not in KNOWN_TICKERS
    )
    if unknown:
        print(
            "::error::490590 구성종목이 바뀐 것 같습니다 — 화면이 쓰는 목록에 없는 종목: "
            f"{', '.join(unknown)} / 증권사 앱의 구성종목 화면을 캡처해 비중을 갱신해 주세요"
            " (frontend/lib/etfEntryCheck.ts의 FALLBACK_PROXY_HOLDINGS)",
            flush=True,
        )
        sys.exit(1)
    print("  화면이 쓰는 목록과 일치 — 갱신할 것 없음", flush=True)


if __name__ == "__main__":
    main()
