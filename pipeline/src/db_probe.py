"""날짜로 묶인 테이블들의 실제 상태를 찍어 보는 진단 — `python -m src.db_probe`.

작업용 컨테이너에는 Supabase 자격증명도, 배포된 사이트 접속도 없다. 그래서
"파이프라인은 저장했다는데 화면엔 안 뜬다" 같은 문제를 여기서 확인할 수 없다.
Actions에서 이걸 돌리면 어느 테이블이 어느 날짜로 몇 행 들어가 있는지 한눈에 보인다
(.github/workflows/db_probe.yml, universe_probe.yml과 같은 방식).

`recommendation_history`의 특성 컬럼도 같이 본다 — 이건 **SQL을 실행했는지**를
확인할 수 있는 유일한 곳이다(아래 `_probe_recommendation_features` 주석 참고).

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


# `supabase/recommendation_history_features.sql`이 더하는 컬럼들.
_FEATURE_COLUMNS = (
    "score", "drawdown_pct", "days_since_low", "vol_ratio",
    "vcp", "ma_align", "volume_triggered", "higher_low",
)


def _probe_recommendation_features(db: ScreenerDB) -> None:
    """특성 컬럼이 실제로 테이블에 있는지, 값이 쌓이고 있는지 확인한다.

    **SQL을 실행했는지 알 수 있는 유일한 방법이다.** 안 돌렸어도 파이프라인은 안 죽는다 —
    `save_recommendation_history`가 실패를 감지해 기본 컬럼만으로 다시 저장하므로 실행
    로그는 초록불이고, 성적 화면은 특성별 표만 조용히 빈다. 즉 **아무 데서도 티가 안 나는
    상태**라 여기서 직접 물어보는 수밖에 없다.

    컬럼이 있는 것과 값이 차 있는 것은 다르다. 과거 행은 소급할 수 없어(추천 시점 근거가
    `pattern_match_results`와 함께 매 실행 삭제된다) **SQL을 실행한 날 이후 추천부터만**
    값이 들어간다 — 그래서 날짜별로 몇 행이 값을 갖고 있는지까지 찍는다.
    """
    print("\n=== recommendation_history 특성 컬럼 ===", flush=True)

    missing: list[str] = []
    for col in _FEATURE_COLUMNS:
        try:
            db.client.table("recommendation_history").select(col).limit(1).execute()
        except Exception as exc:  # 컬럼이 없으면 PostgREST가 42703으로 거절한다
            missing.append(col)
            print(f"  ✗ {col} — 없음 ({type(exc).__name__}: {exc})", flush=True)
        else:
            print(f"  ✓ {col}", flush=True)

    if missing:
        print(
            f"  → {len(missing)}개 누락 ({', '.join(missing)}).\n"
            "     supabase/recommendation_history_features.sql을 아직 실행하지 않았다.\n"
            "     파이프라인은 기본 컬럼으로 저장하므로 죽지는 않지만, 그동안 쌓이는 추천은\n"
            "     근거가 비고 **나중에 소급할 수 없다**.",
            flush=True,
        )
        return

    print("  → 컬럼은 전부 있다. 이제 값이 쌓이는지 본다:", flush=True)

    resp = (
        db.client.table("recommendation_history")
        .select("recommended_date, days_since_low, higher_low")
        .order("recommended_date", desc=True)
        .limit(1000)
        .execute()
    )
    rows = resp.data or []
    if not rows:
        print("     (추천 기록 자체가 없다 — 파이프라인이 아직 안 돌았다)", flush=True)
        return

    per_date: dict[str, list[int]] = {}
    for row in rows:
        total, filled = per_date.setdefault(row["recommended_date"], [0, 0])
        per_date[row["recommended_date"]] = [
            total + 1,
            filled + (1 if row.get("days_since_low") is not None else 0),
        ]

    for date in sorted(per_date, reverse=True)[:_RECENT_DATES]:
        total, filled = per_date[date]
        mark = "✓" if filled == total else ("—" if filled == 0 else "△")
        print(f"     {mark} {date}: {filled}/{total}행에 특성 있음", flush=True)

    newest = sorted(per_date, reverse=True)[0]
    if per_date[newest][1] == 0:
        print(
            "     → 가장 최근 추천에도 값이 없다. 컬럼을 더한 **뒤에** 파이프라인이 아직\n"
            "        한 번도 안 돌았다는 뜻이다(다음 실행부터 채워진다).",
            flush=True,
        )


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

        # 화면이 실제로 하는 조회를 그대로 재현한다 — 화면은 **종목 쪽 최신 날짜**로
        # 찾는다(getLatestScreenedDate). 장세 날짜로 찾던 옛 방식이 눌림목 탭을
        # 통째로 비웠기 때문이다(2026-09-09).
        stock_dates = _date_counts(db, "screened_stocks", market)
        if stock_dates:
            latest_date, _ = stock_dates[0]
            resp = (
                db.client.table("screened_stocks")
                .select("ticker")
                .eq("market", market)
                .eq("date", latest_date)
                .execute()
            )
            n = len(resp.data or [])
            verdict = "정상" if n else "⚠️ 화면에 '표시할 후보가 없습니다'가 뜨는 상태"
            print(f"  → 화면이 {latest_date}로 조회하면: {n}개 — {verdict}", flush=True)

            # 장세와 종목 날짜가 다른 건 이상이 아니다 — 미장은 지수가 현지 날짜,
            # 종목이 한국 날짜(KIS) 기준이라 구조적으로 하루 어긋난다. 참고로만 남긴다.
            regime_date = regime.split(" ")[0] if regime else None
            if regime_date and regime_date != latest_date:
                print(
                    f"     (장세 {regime_date} ≠ 종목 {latest_date} — 소스가 달라 생기는 차이로,"
                    " 화면은 종목 날짜를 따르므로 문제되지 않는다)",
                    flush=True,
                )

    _probe_recommendation_features(db)


if __name__ == "__main__":
    main()
