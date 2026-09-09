"""날짜로 묶인 테이블들의 실제 상태를 찍어 보는 진단 — `python -m src.db_probe`.

작업용 컨테이너에는 Supabase 자격증명도, 배포된 사이트 접속도 없다. 그래서
"파이프라인은 저장했다는데 화면엔 안 뜬다" 같은 문제를 여기서 확인할 수 없다.
Actions에서 이걸 돌리면 어느 테이블이 어느 날짜로 몇 행 들어가 있는지 한눈에 보인다
(.github/workflows/db_probe.yml, universe_probe.yml과 같은 방식).

특히 중요한 건 **market_regime의 최신 날짜와 screened_stocks의 날짜가 같은가**다.
화면(app/pullback/page.tsx)이 "최신 장세 행의 날짜"로 종목을 찾기 때문에, 둘이
어긋나면 종목이 저장돼 있어도 "표시할 후보가 없습니다"가 뜬다.
"""
from __future__ import annotations

from collections import Counter

from dotenv import load_dotenv

from .db import ScreenerDB

_MARKETS = ("KR", "US")
# 최근 며칠만 본다 — 전 기간을 끌어오면 응답만 커지고 진단에는 도움이 안 된다.
_RECENT_DATES = 5


def _latest_regime(db: ScreenerDB, market: str) -> str | None:
    resp = (
        db.client.table("market_regime")
        .select("date, regime")
        .eq("market", market)
        .order("date", desc=True)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return f"{rows[0]['date']} ({rows[0]['regime']})" if rows else None


def _date_counts(db: ScreenerDB, table: str, market: str) -> list[tuple[str, int]]:
    resp = (
        db.client.table(table)
        .select("date")
        .eq("market", market)
        .order("date", desc=True)
        .limit(2000)
        .execute()
    )
    counter = Counter(row["date"] for row in (resp.data or []))
    return sorted(counter.items(), reverse=True)[:_RECENT_DATES]


def main() -> None:
    load_dotenv()
    db = ScreenerDB.from_env()

    for market in _MARKETS:
        print(f"\n=== {market} ===", flush=True)
        regime = _latest_regime(db, market)
        print(f"  market_regime 최신: {regime or '(없음)'}", flush=True)
        for table in ("screened_stocks", "leading_sectors"):
            counts = _date_counts(db, table, market)
            shown = ", ".join(f"{d}:{n}행" for d, n in counts) or "(없음)"
            print(f"  {table}: {shown}", flush=True)

        # 화면이 실제로 하는 조회를 그대로 재현한다.
        if regime:
            regime_date = regime.split(" ")[0]
            resp = (
                db.client.table("screened_stocks")
                .select("ticker")
                .eq("market", market)
                .eq("date", regime_date)
                .execute()
            )
            n = len(resp.data or [])
            verdict = "정상" if n else "⚠️ 화면에 '표시할 후보가 없습니다'가 뜨는 상태"
            print(f"  → 화면이 {regime_date}로 조회하면: {n}개 — {verdict}", flush=True)


if __name__ == "__main__":
    main()
