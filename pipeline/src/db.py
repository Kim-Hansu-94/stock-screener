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

        if result.leading_sectors:
            rows = [
                {"date": result.date, "market": result.market, "sector": sector, "rank": rank + 1}
                for rank, sector in enumerate(result.leading_sectors)
            ]
            self.client.table("leading_sectors").upsert(rows).execute()

        if result.screened_stocks:
            rows = [
                {"date": result.date, "market": result.market, **stock}
                for stock in result.screened_stocks
            ]
            self.client.table("screened_stocks").upsert(rows).execute()

        if result.price_history:
            _batch_upsert(self.client, "stock_price_history", result.price_history)

        if result.universe_metadata:
            _batch_upsert(self.client, "stock_universe", result.universe_metadata)

    def save_price_history(self, rows: list[dict]) -> None:
        if rows:
            _batch_upsert(self.client, "stock_price_history", rows)

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
