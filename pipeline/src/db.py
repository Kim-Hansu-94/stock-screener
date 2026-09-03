from __future__ import annotations

import os
from dataclasses import dataclass, field

from supabase import Client, create_client

_UPSERT_CHUNK = 1_000


@dataclass
class PipelineResult:
    date: str
    market: str
    regime: str
    leading_sectors: list[str] = field(default_factory=list)
    screened_stocks: list[dict] = field(default_factory=list)
    price_history: list[dict] = field(default_factory=list)
    universe_metadata: list[dict] = field(default_factory=list)


def _batch_upsert(client: Client, table: str, rows: list[dict]) -> None:
    for i in range(0, len(rows), _UPSERT_CHUNK):
        client.table(table).upsert(rows[i : i + _UPSERT_CHUNK]).execute()


def _replace_day(client: Client, table: str, market: str, dates: list[str], rows: list[dict]) -> None:
    """그날 그 시장의 행을 통째로 갈아끼운다 (지우고 다시 넣기).

    upsert만 하면 PK(date, market, ticker)가 겹치는 행만 덮이고, 이번 실행에서
    빠진 종목의 지난 실행 행은 그대로 남는다. 하루에 두 번 이상 돌면(아침 전체 +
    저녁 kr_only, 백업 schedule, 수동 재실행) 조건을 더 이상 만족하지 않는
    종목이 유령처럼 화면에 계속 뜨는 이유가 이것이다.

    rows가 비어 있어도 삭제는 수행한다 — 이 시점에 도달했다는 건 스크리닝이
    정상 완료됐는데 통과 종목이 없었다는 뜻이므로(실패는 예외로 중단된다)
    지난 실행 결과를 남겨두면 안 된다.
    """
    for day in dates:
        client.table(table).delete().eq("market", market).eq("date", day).execute()
    if rows:
        _batch_upsert(client, table, rows)


class ScreenerDB:
    def __init__(self, client: Client):
        self.client = client

    @classmethod
    def from_env(cls) -> "ScreenerDB":
        url = os.environ["SUPABASE_URL"]
        key = os.environ["SUPABASE_SERVICE_KEY"]
        return cls(create_client(url, key))

    def save_pipeline_result(self, result: PipelineResult) -> None:
        self.client.table("market_regime").upsert({
            "date": result.date,
            "market": result.market,
            "regime": result.regime,
        }).execute()

        sector_rows = [
            {"date": result.date, "market": result.market, "sector": sector, "rank": rank + 1}
            for rank, sector in enumerate(result.leading_sectors)
        ]
        _replace_day(self.client, "leading_sectors", result.market, [result.date], sector_rows)

        # 각 종목의 "date"는 stock dict 안에 이미 실제 마지막 봉의 날짜로 들어있음
        # (pipeline.py의 as_of). result.date로 덮어쓰면 안 되므로 여기서 넣지 않는다.
        stock_rows = [
            {"market": result.market, **stock}
            for stock in result.screened_stocks
        ]
        # 삭제 대상 날짜는 result.date와 실제 행의 date를 합집합으로 잡는다. 보통
        # 둘은 같지만, 다를 경우 한쪽만 지우면 유령 행이 남는다.
        stock_dates = sorted({result.date} | {r["date"] for r in stock_rows if r.get("date")})
        _replace_day(self.client, "screened_stocks", result.market, stock_dates, stock_rows)

        if result.price_history:
            _batch_upsert(self.client, "stock_price_history", result.price_history)

        if result.universe_metadata:
            try:
                _batch_upsert(self.client, "stock_universe", result.universe_metadata)
            except Exception as exc:
                # market_cap 컬럼이 아직 없는 배포(ALTER TABLE 미실행)에서도 파이프라인이
                # 죽지 않도록, 해당 컬럼만 빼고 한 번 더 시도한다.
                if "market_cap" not in str(exc):
                    raise
                stripped = [
                    {k: v for k, v in row.items() if k != "market_cap"}
                    for row in result.universe_metadata
                ]
                _batch_upsert(self.client, "stock_universe", stripped)

    def save_long_monthly(self, rows: list[dict]) -> None:
        if rows:
            _batch_upsert(self.client, "stock_long_monthly", rows)

    def replace_opportunity_snapshot(self, market: str, rows: list[dict]) -> None:
        """그 시장의 스냅샷을 이번 계산 결과로 통째로 갈아끼운다.

        PK가 (ticker, market)이라 날짜가 없다. upsert만 하면 이번에 빠진 종목의
        지난 행이 영구히 남는다 — 시총 하한 같은 기준을 올렸을 때 기준 미달 종목이
        화면에서 안 사라지는 이유가 이것이다.

        예전에는 `computed_at < today`로 지웠는데, 같은 날 기준이 바뀌면(코드 배포 후
        재실행) 옛 행도 computed_at이 오늘이라 그 비교에서 빠져나갔다.

        rows가 비어 있으면 아무것도 하지 않는다. 호출부가 이미 데이터 이상일 때
        빈 결과로 도달할 수 있어서, 여기서 지우면 일시적 문제가 탭을 통째로 비운다.
        """
        if not rows:
            return
        self.client.table("opportunity_snapshot").delete().eq("market", market).execute()
        _batch_upsert(self.client, "opportunity_snapshot", rows)

    def save_realestate_monthly(self, rows: list[dict]) -> None:
        # PK가 (region_code, month)라 같은 달을 다시 넣으면 덮어쓴다. 실거래 신고가
        # 최대 30일 늦게 들어와 최근 달 수치가 계속 바뀌므로 upsert여야 한다.
        if rows:
            _batch_upsert(self.client, "realestate_monthly", rows)

    def replace_realestate_media(self, rows: list[dict]) -> None:
        """뉴스·유튜브 링크를 통째로 갈아끼운다 — 날짜별 이력을 안 쌓는 "오늘의
        스냅샷"이라(어제 뉴스를 보여줄 이유가 없다) upsert가 아니라 전체 삭제 후
        재삽입이다. rows가 비어 있으면(양쪽 API 다 실패) 지우지 않는다 — 일시적
        오류로 화면이 통째로 비는 것보다 어제 것이라도 남아 있는 게 낫다.
        """
        if not rows:
            return
        self.client.table("realestate_media").delete().neq("id", 0).execute()
        _batch_upsert(self.client, "realestate_media", rows)

    def save_fundamentals(self, rows: list[dict]) -> None:
        if rows:
            _batch_upsert(self.client, "stock_fundamentals", rows)

    def save_price_history(self, rows: list[dict]) -> None:
        if rows:
            _batch_upsert(self.client, "stock_price_history", rows)

    def refresh_monthly_ohlcv(self) -> None:
        # 일봉 저장 후 월봉 사전 집계 MV를 갱신 (CONCURRENTLY라 조회를 막지 않음).
        self.client.rpc("refresh_monthly_ohlcv").execute()

    def accrue_long_monthly(self) -> None:
        """방금 끝난 달의 월봉을 stock_long_monthly(영구 테이블)에 적립한다.

        일봉은 600일만 보관하므로, 그 밖으로 밀려나기 전에 월봉으로 남겨두지 않으면
        3년 고점 계산이 무너진다. mv_monthly_ohlcv는 일봉에서 파생되는 뷰라
        같이 사라지므로 대신이 되지 못한다.

        실패해도 파이프라인 본체는 계속 진행한다 — 다음 실행에서 다시 적립되고,
        여기서 멈추면 그날 스크리닝 결과 전체가 날아간다.
        """
        try:
            self.client.rpc("accrue_long_monthly").execute()
        except Exception as exc:  # noqa: BLE001
            print(f"  월봉 적립(accrue_long_monthly) 실패: {exc}", flush=True)

    def get_recently_screened_tickers(self, market: str, days: int = 5) -> list[str]:
        from datetime import date, timedelta
        cutoff = (date.today() - timedelta(days=days)).isoformat()
        result = (
            self.client.table("screened_stocks")
            .select("ticker")
            .eq("market", market)
            .gte("date", cutoff)
            .execute()
        )
        return list({row["ticker"] for row in (result.data or [])})

    def get_universe_tickers(
        self, market: str, index_memberships: list[str], min_market_cap: float,
    ) -> list[str]:
        """stock_universe에서 이미 저장된 유니버스로 티커 목록을 뽑는다.

        US 재무건전성 전용 워크플로(us_financial_health_main.py, 21:00 KST)가
        무거운 유니버스 재수집(universe_us.py) 없이, 그날 아침 본 파이프라인이
        이미 저장해 둔 stock_universe를 그대로 재사용하는 데 쓴다.
        """
        tickers: list[str] = []
        page = 1000
        start = 0
        while True:
            result = (
                self.client.table("stock_universe")
                .select("ticker")
                .eq("market", market)
                .in_("index_membership", index_memberships)
                .gte("market_cap", min_market_cap)
                .range(start, start + page - 1)
                .execute()
            )
            rows = result.data or []
            tickers.extend(r["ticker"] for r in rows)
            if len(rows) < page:
                break
            start += page
        return tickers

    def get_latest_regime_date(self, market: str) -> str | None:
        """market_regime에 저장된 해당 시장의 최신 as_of 날짜(YYYY-MM-DD). 없으면 None.

        아침 전체 실행이 KR을 다시 돌 필요가 있는지 판단하는 데 쓴다 — 저녁
        KR 전용 실행이 이미 최신 종가를 저장해뒀다면 아침엔 건너뛴다.
        """
        result = (
            self.client.table("market_regime")
            .select("date")
            .eq("market", market)
            .order("date", desc=True)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return rows[0]["date"] if rows else None

    def save_pattern_matches(self, matches: list[dict], computed_at: str) -> None:
        if not matches:
            return
        # 기존 결과 전체 삭제 후 새 결과 삽입
        self.client.table("pattern_match_results").delete().gte("rank", 1).execute()
        rows = [
            {
                "ticker": m["ticker"],
                "name": m["name"],
                "sector": m.get("sector"),
                "similarity": m["similarity"],
                "matched_standard": m["matched_standard"],
                "matched_standard_ticker": m["matched_standard_ticker"] or "",
                "matched_bottom": m["matched_bottom"],
                "volume_triggered": m["volume_triggered"],
                "close": m.get("close"),
                "rank": i + 1,
                "computed_at": computed_at,
            }
            for i, m in enumerate(matches)
        ]
        self.client.table("pattern_match_results").insert(rows).execute()

    def save_recommendation_history(self, matches: list[dict], recommended_date: str) -> None:
        if not matches:
            return
        existing = self.client.table("recommendation_history") \
            .select("ticker", count="exact") \
            .eq("recommended_date", recommended_date) \
            .execute()
        if existing.count and existing.count > 0:
            print(f"  [history] {recommended_date} 이미 저장됨, 건너뜀", flush=True)
            return
        rows = [
            {
                "ticker": m["ticker"],
                "name": m["name"],
                "sector": m.get("sector"),
                "entry_price": m.get("close"),
                "recommended_date": recommended_date,
                "rank": i + 1,
            }
            for i, m in enumerate(matches)
        ]
        self.client.table("recommendation_history").insert(rows).execute()
        print(f"  [history] {len(rows)}개 추천 기록 저장", flush=True)
