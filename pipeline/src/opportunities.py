"""횡보·조정 후보 사전 계산.

이전에는 페이지 요청마다 유니버스 1,460종목의 조정폭을 집계하고, 밴드를 통과한
수백 종목의 일봉 14만 행을 받아 점수를 다시 계산했다. 왕복 30회 이상이 걸려
캐시가 비면(배포 직후·파이프라인 갱신 직후) 로딩이 크게 느려졌다.

데이터는 하루 한 번만 바뀌므로 여기서 미리 계산해 opportunity_snapshot에 저장하고,
화면은 그 표만 읽는다. 점수 판정은 watchlist.evaluate_watch를 그대로 재사용해
감시 종목과 기준이 갈라지지 않게 한다.
"""

from __future__ import annotations

from datetime import date, timedelta

from .db import ScreenerDB
from .watchlist import MIN_DRAWDOWN, MAX_DRAWDOWN, evaluate_watch

# 조정폭 집계 RPC 배치 (frontend queries.ts의 OPP_DRAWDOWN_BATCH와 동일)
DRAWDOWN_BATCH = 250
# 일봉 조회 배치 — PostgREST max_rows=1000을 넘기므로 페이지네이션과 함께 쓴다
BARS_BATCH = 15
BARS_PAGE = 1000
# 점수 계산에 필요한 창(저점 높이기 240봉)보다 넉넉하게
BARS_DAYS = 500
# 실제 창은 "정확히 1095일"이 아니라 **최근 36개월**이다. 일봉을 600일만 보관하게 되면서
# 그 이전 구간을 월봉이 맡는데, 월봉은 달 단위라 1095일 지점에서 자를 수가 없다.
# get_opp_drawdowns는 3년 전이 속한 달을 통째로 포함하므로 창이 최대 30일 길어진다.
# 그 달을 빼는 쪽이 더 나쁘다 — 고점을 놓치면 조정폭이 얕게 나와 "덜 빠진 종목"으로 오판한다.
_DRAWDOWN_LOOKBACK_DAYS = 3 * 365


def in_band_tickers(db: ScreenerDB, market: str, tickers: list[str], today: date) -> dict[str, dict]:
    """조정폭 20~60% 구간 종목과 그 3년 고점·현재가를 돌려준다.

    fundamentals.py가 실적 수집 대상을 "화면에 뜰 가능성이 있는 종목"으로 좁히는 데도
    이 함수를 재사용한다 — 유니버스 전체(코스피 942개 등)를 다 받으면 실제로 카드에
    뜨는 건 그 중 일부(조정폭 밴드 안)뿐이라 나머지는 낭비다.
    """
    cutoff = (today - timedelta(days=_DRAWDOWN_LOOKBACK_DAYS)).isoformat()
    result: dict[str, dict] = {}
    for i in range(0, len(tickers), DRAWDOWN_BATCH):
        batch = tickers[i : i + DRAWDOWN_BATCH]
        rpc = db.client.rpc(
            "get_opp_drawdowns",
            {"p_market": market, "p_tickers": batch, "p_cutoff": cutoff},
        ).execute()
        for row in rpc.data or []:
            high3y = float(row.get("high3y") or 0)
            current = float(row.get("current_close") or 0)
            if high3y <= 0:
                continue
            drawdown = (high3y - current) / high3y * 100
            if MIN_DRAWDOWN <= drawdown <= MAX_DRAWDOWN:
                result[row["ticker"]] = {
                    "high3y": high3y,
                    "current_close": current,
                    "drawdown": drawdown,
                }
    return result


def _fetch_bars_bulk(
    db: ScreenerDB, market: str, tickers: list[str], today: date
) -> dict[str, list[dict]]:
    cutoff = (today - timedelta(days=BARS_DAYS)).isoformat()
    grouped: dict[str, list[dict]] = {}
    for i in range(0, len(tickers), BARS_BATCH):
        batch = tickers[i : i + BARS_BATCH]
        start = 0
        while True:
            res = (
                db.client.table("stock_price_history")
                .select("ticker, date, open, high, low, close, volume")
                .eq("market", market)
                .in_("ticker", batch)
                .gte("date", cutoff)
                .order("ticker")
                .order("date")
                .range(start, start + BARS_PAGE - 1)
                .execute()
            )
            rows = res.data or []
            for r in rows:
                grouped.setdefault(r["ticker"], []).append({
                    "date": str(r["date"])[:10],
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": float(r["volume"]),
                })
            if len(rows) < BARS_PAGE:
                break
            start += BARS_PAGE
    return grouped


def refresh_opportunity_snapshot(
    db: ScreenerDB, market: str, universe_rows: list[dict], today: date
) -> None:
    """유니버스에서 후보를 추려 점수와 함께 opportunity_snapshot에 저장한다."""
    tickers = [r["ticker"] for r in universe_rows]
    if not tickers:
        return

    try:
        print(f"{market} 횡보·조정 후보 계산 중 ({len(tickers)}종목)...", flush=True)
        in_band = in_band_tickers(db, market, tickers, today)
        if not in_band:
            print("  밴드 통과 종목 없음", flush=True)
            return
        print(f"  조정폭 20~60%: {len(in_band)}개 → 일봉 수집", flush=True)

        bars_by_ticker = _fetch_bars_bulk(db, market, list(in_band), today)
        meta = {r["ticker"]: r for r in universe_rows}

        rows: list[dict] = []
        for ticker, summary in in_band.items():
            bars = bars_by_ticker.get(ticker, [])
            status = evaluate_watch(bars)
            if not status["qualified"]:
                continue
            info = meta.get(ticker, {})
            rows.append({
                "ticker": ticker,
                "market": market,
                "computed_at": today.isoformat(),
                "name": info.get("name") or ticker,
                "name_kr": info.get("name_kr") or None,
                "sector": info.get("sector") or None,
                "index_membership": info.get("index_membership") or None,
                "current_close": summary["current_close"],
                "high3y": summary["high3y"],
                "drawdown": summary["drawdown"],
                "score": status["score"],
                "days_since_low": status["days_since_low"],
                "vcp": status["vcp"],
                "higher_lows": status["higher_lows"],
                "volume_dry": status["volume_dry"],
                "aligned_mas": status["aligned_mas"],
                "volume_trigger": status["volume_trigger"],
                "as_of_date": bars[-1]["date"] if bars else None,
            })

        # 이번 계산에서 빠진 종목(밴드 이탈·하드 필터 탈락·시총 하한 미달)은 화면에서도
        # 사라져야 한다. 지우고 다시 넣어야 확실하다 — 자세한 이유는 db.py 주석 참고.
        db.replace_opportunity_snapshot(market, rows)
        print(f"  → {len(rows)}개 저장", flush=True)
    except Exception as exc:  # noqa: BLE001
        # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행한다.
        print(f"  {market} 후보 계산 실패: {exc}", flush=True)
