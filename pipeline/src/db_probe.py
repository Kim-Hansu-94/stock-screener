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


import time
from collections import Counter

from dotenv import load_dotenv

from .db import ScreenerDB

_MARKETS = ("KR", "US")
# 최근 며칠만 본다 — 전 기간을 끌어오면 응답만 커지고 진단에는 도움이 안 된다.
_RECENT_DATES = 5


def _attempt(label: str, fn):
    """조회 하나가 죽어도 프로브 전체를 멈추지 않는다.

    **진단 도구가 첫 오류에서 죽으면 진단을 못 한다.** 2026-09-14에 실제로 그랬다 —
    `screened_stocks` 조회가 Supabase 504(Gateway Timeout)를 맞자 그 뒤에 있던
    `recommendation_history` 점검이 통째로 실행되지 않아서, 정작 확인하려던 것을
    확인하지 못한 채 빨간불만 났다.

    504는 대체로 일시적이라 한 번 더 시도해 보고, 그래도 안 되면 **사유를 찍고 넘어간다**.
    빈 결과와 "못 물어봤다"를 구분해야 하므로 조용히 삼키지 않는다.
    """
    for attempt in (1, 2):
        try:
            return fn()
        except Exception as exc:
            if attempt == 1:
                time.sleep(3)
                continue
            print(f"  ⚠️ {label} 조회 실패 — {type(exc).__name__}: {exc}", flush=True)
            return None


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

    rows = _attempt(
        "recommendation_history",
        lambda: (
            db.client.table("recommendation_history")
            .select("recommended_date, days_since_low, higher_low")
            .order("recommended_date", desc=True)
            .limit(1000)
            .execute()
        ).data
        or [],
    )
    if rows is None:
        return
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


def _probe_market_indices(db: ScreenerDB) -> None:
    """market_index_snapshot에 **저장된 원본 값**을 그대로 찍는다.

    화면이 단위를 잘못 해석해도 로그만으로는 안 드러난다 — 2026-09-15에 미국10년물을
    "수익률의 10배로 온다"고 가정해 10으로 나눴더니 5.02%가 0.50%로 떴다. 저장값을
    직접 봐야 어느 쪽이 틀렸는지 갈린다.
    """
    print("\n=== market_index_snapshot (저장된 원본 값) ===", flush=True)
    rows = _attempt(
        "market_index_snapshot",
        lambda: (db.client.table("market_index_snapshot").select("*").execute()).data or [],
    )
    if not rows:
        return
    for r in sorted(rows, key=lambda x: x["index_name"]):
        print(
            f"  {r['index_name']}: close={r['close']} prev_close={r['prev_close']} ({r['date']})",
            flush=True,
        )


def _probe_etf_proxy_bars(db: ScreenerDB) -> None:
    """490590 매수체크가 쓰는 대장주 일봉이 실제로 DB에 있는지 (2026-09-16 추가).

    **화면(app/page.tsx)은 stock_price_history를 읽기만 하고 직접 받아오지 않는다.**
    그 종목이 정규 스크리닝 유니버스나 조정폭 밴드에 안 걸리면 일봉이 아예 없고, 화면은
    조용히 "일봉 부족으로 판정에서 빠졌습니다"만 뜬다 — 종목을 바꾸기 전에 **여기서
    확인하지 않으면 바꾼 종목이 판정에 아예 안 들어가는 것을 모른 채 넘어간다.**

    2026-09-16에 사용자가 실제 구성종목을 확인해 줬다(네이버/증권사 앱 실측):
      NVDA 14.67 · GOOGL 13.97 · MRVL 10.46 · PLTR 5.80 · MSFT 5.70 ·
      META 5.06 · ANET 5.01 · AMZN 4.65 · RISE 미국AI밸류체인TOP3Plus 4.6 · TSM 4.3
    지금 하드코딩된 5개 중 **ORCL·AMD는 상위 10개에 없다.** 후보를 바꾸려면 새 종목의
    일봉이 있는지부터 봐야 해서 둘 다 찍는다.
    """
    print("\n=== 490590 대장주 일봉 보유 현황 ===", flush=True)
    current = ["ORCL", "GOOGL", "NVDA", "AMD", "MRVL"]
    candidates = ["PLTR", "MSFT", "META", "ANET", "AMZN", "TSM"]
    # classifyStage가 A/B/C를 판정하는 최소치. 이보다 적으면 화면은 "판정 불가"다.
    min_bars = 66

    for label, tickers in (("지금 쓰는 5개", current), ("실제 상위 구성 후보", candidates)):
        print(f"  [{label}]", flush=True)
        for ticker in tickers:
            rows = _attempt(
                f"{ticker} 일봉",
                lambda t=ticker: (
                    db.client.table("stock_price_history")
                    .select("date", count="exact")
                    .eq("market", "US")
                    .eq("ticker", t)
                    .order("date", desc=True)
                    .limit(1)
                    .execute()
                ),
            )
            if rows is None:
                continue
            count = rows.count or 0
            latest = rows.data[0]["date"] if rows.data else "없음"
            verdict = "판정 가능" if count >= min_bars else f"**판정 불가** ({min_bars}봉 미만)"
            print(f"    {ticker:<6} {count:>4}봉 · 최근 {latest} → {verdict}", flush=True)


def _probe_watchlist_tickers(db: ScreenerDB) -> None:
    """watchlist_tickers 실제 행 수와 490590 존재 여부를 직접 찍는다.

    사이트에서 "추가했는데 목록에 안 뜬다"는 신고가 들어왔을 때, 작업용 컨테이너에는
    Supabase 자격증명이 없어 여기서만 확인할 수 있다 — /api/watchlist가 실제로 insert에
    성공했는지(DB 진실)와 화면이 보여주는 값(캐시 경유)이 다른지를 가른다.
    """
    print("\n=== watchlist_tickers ===", flush=True)
    rows = _attempt(
        "watchlist_tickers",
        lambda: (
            db.client.table("watchlist_tickers")
            .select("market, ticker, name, category, added_at")
            .order("added_at", desc=True)
            .execute()
        ).data
        or [],
    )
    if rows is None:
        return
    print(f"  총 {len(rows)}행 · 최근 추가: {rows[0]['market']} {rows[0]['ticker']} ({rows[0]['added_at']})", flush=True)

    # 목록에 있는 것과 **차트가 그려지는 것은 다르다** — 감시 종목은 정규 유니버스
    # 수집 루프를 안 타서, main.py의 _backfill_missing_watchlist_history가 돌기
    # 전까지 일봉이 0개다(화면엔 "평가 대기"로만 뜬다). 몇 봉이 언제까지 쌓였는지는
    # 여기서만 알 수 있다.
    #
    # **문제 있는 종목만 나열한다.** 30줄을 다 찍으면 정작 봐야 할 줄(0봉인 종목)이
    # 묻히고, 로그를 꼬리부터 읽을 때 잘려 나간다.
    missing: list[str] = []
    ok_count = 0
    latest_dates: list[str] = []
    for r in rows:
        ticker, market = r["ticker"], r["market"]
        bars = _attempt(f"{market} {ticker} 일봉 수", lambda t=ticker, m=market: db.count_price_bars(t, m))
        if bars is None:
            continue
        if bars == 0:
            missing.append(f"{market} {ticker} ({r['name']})")
            continue
        ok_count += 1
        latest = _attempt(
            f"{market} {ticker} 최신 일봉",
            lambda t=ticker, m=market: (
                db.client.table("stock_price_history")
                .select("date")
                .eq("ticker", t)
                .eq("market", m)
                .order("date", desc=True)
                .limit(1)
                .execute()
            ).data
            or [],
        )
        if latest:
            latest_dates.append(latest[0]["date"])

    newest_bar = max(latest_dates) if latest_dates else "—"
    print(f"  일봉 있음 {ok_count}개 (가장 최근 봉 {newest_bar}) · 일봉 0봉 {len(missing)}개", flush=True)
    for label in missing:
        print(f"    ✗ {label}: 0봉 — 아직 백필 전", flush=True)

    # 가장 최근에 추가한 종목의 실제 일봉을 몇 개 찍는다. **봉 수만으로는 데이터가
    # 쓸 만한지 알 수 없다** — 값이 0이거나 거래량이 비어 있어도 "N봉 있음"으로는
    # 똑같이 보이기 때문이다(차트는 그때 빈 화면이 된다).
    newest = rows[0]
    newest_bars = _attempt(
        "최근 추가 종목 봉 수",
        lambda: db.count_price_bars(newest["ticker"], newest["market"]),
    )
    # 66봉은 프론트(etfEntryCheck.classifyStage)가 A/B/C를 판정하는 최소치다 —
    # 이보다 적으면 일봉은 있는데 화면은 "판정 불가"로 뜬다.
    verdict = "판정 가능" if (newest_bars or 0) >= 66 else "66봉 미만 — 화면은 판정 불가로 뜬다"
    print(
        f"\n  가장 최근 추가 종목({newest['market']} {newest['ticker']}): "
        f"총 {newest_bars}봉 → {verdict}",
        flush=True,
    )
    print("  최근 일봉 5개:", flush=True)
    sample = _attempt(
        "최근 추가 종목 일봉 샘플",
        lambda: (
            db.client.table("stock_price_history")
            .select("date, open, high, low, close, volume")
            .eq("ticker", newest["ticker"])
            .eq("market", newest["market"])
            .order("date", desc=True)
            .limit(5)
            .execute()
        ).data
        or [],
    )
    if not sample:
        print("    (없음 — 아직 백필 전이거나 수집이 실패했다)", flush=True)
        return

    for row in sample:
        print(
            f"    {row['date']}  시 {row['open']}  고 {row['high']}  "
            f"저 {row['low']}  종 {row['close']}  거래량 {row['volume']}",
            flush=True,
        )

    # 차트가 실제로 그려지는지는 작업용 컨테이너에서 확인할 방법이 없다(Supabase
    # 자격증명도, 배포된 사이트 접속도 없다). 그때는 여기에 `.limit(60)` 조회를
    # 한 줄 JSON으로 찍어, 그 값을 로컬 미리보기(app/dev/preview)에 넣고 StockChart로
    # 렌더해 확인했다(2026-09-15, 490590). 매번 찍으면 로그만 길어져서 상시로는 두지
    # 않는다 — 다시 필요하면 그때 되살릴 것.


def main() -> None:
    load_dotenv()
    db = ScreenerDB.from_env()

    for market in _MARKETS:
        print(f"\n=== {market} ===", flush=True)
        regime = _attempt("market_regime", lambda: _latest_regime(db, market))
        print(f"  market_regime 최신: {regime or '(없음)'}", flush=True)

        counts_by_table: dict[str, list[tuple[str, int]]] = {}
        for table in ("screened_stocks", "leading_sectors"):
            counts = _attempt(table, lambda t=table: _date_counts(db, t, market)) or []
            counts_by_table[table] = counts
            shown = ", ".join(f"{d}:{n}행" for d, n in counts) or "(없음)"
            print(f"  {table}: {shown}", flush=True)

        # 화면이 실제로 하는 조회를 그대로 재현한다 — 화면은 **종목 쪽 최신 날짜**로
        # 찾는다(getLatestScreenedDate). 장세 날짜로 찾던 옛 방식이 눌림목 탭을
        # 통째로 비웠기 때문이다(2026-09-09).
        # 위에서 받은 값을 재사용한다 — 같은 조회를 두 번 하면 응답만 느려지고
        # 얻는 게 없다(2026-09-14에 이 중복이 504의 원인 중 하나였다).
        stock_dates = counts_by_table["screened_stocks"]
        if stock_dates:
            latest_date, _ = stock_dates[0]
            rows = _attempt(
                f"screened_stocks({latest_date})",
                lambda: (
                    db.client.table("screened_stocks")
                    .select("ticker")
                    .eq("market", market)
                    .eq("date", latest_date)
                    .execute()
                ).data
                or [],
            )
            if rows is not None:
                n = len(rows)
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
    _probe_market_indices(db)
    _probe_etf_proxy_bars(db)
    # 감시 종목은 **맨 마지막에** 찍는다 — 로그를 꼬리부터 읽는 일이 많아서,
    # 앞에 두면 긴 목록에 밀려 정작 확인하려던 줄이 잘려 나간다.
    _probe_watchlist_tickers(db)


if __name__ == "__main__":
    main()
