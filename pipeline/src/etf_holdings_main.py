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
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import ScreenerDB
from .etf_holdings import (
    ETF_CODE,
    KNOWN_TICKERS,
    collect_etf_holdings,
    describe,
    diff_holdings,
    dropped_rows,
)

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

    # 어제 수집 결과와 비교해 "안 보이게 된 종목"을 찾는다. 표는 매 실행 통째로
    # 갈아끼우므로 **저장하기 전에** 읽어야 한다.
    previous: list[dict] = []
    try:
        previous = (
            db.client.table("etf_holdings")
            .select("ticker, name")
            .eq("etf_ticker", ETF_CODE)
            .execute()
        ).data or []
    except Exception as exc:  # noqa: BLE001
        # 못 읽으면 '안 보임' 판정만 건너뛴다 — 비교 대상이 없는 것을 사라진 것으로
        # 읽으면 거짓 경보가 난다. '새로 보임'은 비교가 필요 없어 그대로 동작한다.
        print(f"  (이전 구성과 비교 실패: {exc})", flush=True)

    unknown, dropped = diff_holdings(previous, rows, KNOWN_TICKERS)

    # `status` 열이 실제로 있는지 **매 실행 한 줄로 남긴다.**
    # 없으면 '빠짐' 팝업이 조용히 안 뜨는데(supabase/etf_holdings_status.sql),
    # 저장 경로로는 확인이 안 된다 — 빠진 종목이 없는 날은 status가 붙은 행을 아예
    # 안 만들어서 열이 있든 없든 저장이 성공하기 때문이다. 그래서 따로 물어본다.
    try:
        db.client.table("etf_holdings").select("status").limit(1).execute()
        print("  status 열 확인됨 — '빠짐' 팝업 경로 살아 있음", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(
            f"  ::warning::status 열이 없다({exc}) — supabase/etf_holdings_status.sql을 "
            "실행할 것. 메일 알림은 정상이고 '빠짐' 팝업만 안 뜬다",
            flush=True,
        )

    now = datetime.now(_KST).isoformat(timespec="seconds")
    db.save_etf_holdings(rows + dropped_rows(dropped, ETF_CODE, rows[0]["as_of"], now))

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
    problems: list[str] = []
    if unknown:
        problems.append(f"목록에 없는 종목이 보입니다: {', '.join(unknown)}")
    if dropped:
        # **"빠졌다"고 단정하지 않는다** — 네이버는 주식 수 순 상위 10개만 주므로,
        # 그대로 담고 있어도 11위로 밀리면 똑같이 사라진다. 어느 쪽인지는 사람이
        # 증권사 앱에서 봐야 알 수 있고, 확인이 필요한 건 어느 쪽이든 같다.
        problems.append(
            f"어제까지 보이던 종목이 안 보입니다(빠졌거나 순위가 밀렸습니다): {', '.join(dropped)}"
        )
    if problems:
        print(
            "::error::490590 구성종목이 바뀐 것 같습니다 — "
            + " / ".join(problems)
            + " / 증권사 앱의 구성종목 화면을 캡처해 비중을 갱신해 주세요"
            " (frontend/lib/etfEntryCheck.ts의 FALLBACK_PROXY_HOLDINGS)",
            flush=True,
        )
        sys.exit(1)
    print("  화면이 쓰는 목록과 일치 — 갱신할 것 없음", flush=True)


if __name__ == "__main__":
    main()
