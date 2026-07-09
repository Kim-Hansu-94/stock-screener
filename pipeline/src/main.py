from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

from . import prices_kr, prices_us
from .db import PipelineResult, ScreenerDB
from .pattern_discovery import compute_pattern_matches
from .pipeline import US_SCREENER_INDEXES, MarketPipelineResult, run_kr_pipeline, run_us_pipeline

KST = timezone(timedelta(hours=9))
_SEED_FILE = Path(__file__).parent.parent / ".yfinance_opp_seeded"
_SEEDED_TICKERS_FILE = Path(__file__).parent.parent / ".yfinance_opp_seeded_tickers"


def _today_kst() -> date:
    return datetime.now(KST).date()


def _to_db_result(result: MarketPipelineResult, today: date) -> PipelineResult:
    screened_rows = [
        {
            "ticker": s.ticker, "name": s.name, "sector": s.sector,
            "close": s.close, "market_cap": s.market_cap, "rsi": s.rsi,
            "date": s.as_of.isoformat(),
        }
        for s in result.screened_stocks
    ]

    history_rows = []
    for ticker, hist in result.price_history.items():
        clean = hist.tail(380).dropna(subset=["Open", "High", "Low", "Close", "Volume"])
        for idx, row in clean.iterrows():
            history_rows.append({
                "ticker": ticker,
                "market": result.market,
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx),
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]),
            })

    universe_rows = []
    if not result.universe_df.empty:
        clean_universe = result.universe_df.fillna("")
        for _, row in clean_universe.iterrows():
            universe_rows.append({
                "ticker": row["ticker"],
                "market": result.market,
                "name": row.get("name", ""),
                "name_kr": row.get("name_kr", ""),
                "sector": row.get("sector", ""),
                "index_membership": row.get("index_membership", ""),
                "updated_at": today.isoformat(),
            })

    return PipelineResult(
        date=result.as_of.isoformat(),
        market=result.market,
        regime=result.regime,
        leading_sectors=result.leading_sectors,
        screened_stocks=screened_rows,
        price_history=history_rows,
        universe_metadata=universe_rows,
    )


def _supplement_kr_price_history(
    db: ScreenerDB,
    kr_result: MarketPipelineResult,
    today: date,
) -> None:
    recently = db.get_recently_screened_tickers("KR", days=7)
    covered = set(kr_result.price_history.keys())
    targets = [t for t in recently if t not in covered]
    if not targets:
        return

    print(f"  KR 보완 히스토리 수집 ({len(targets)}개)...", flush=True)
    rows: list[dict] = []
    for ticker in targets:
        try:
            hist = prices_kr.get_kr_stock_history(ticker, today, 10)
        except Exception:
            continue
        if hist.empty:
            continue
        clean = hist.dropna(subset=["Open", "High", "Low", "Close", "Volume"])
        for idx, row in clean.iterrows():
            rows.append({
                "ticker": ticker,
                "market": "KR",
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
                "open": float(row["Open"]),
                "high": float(row["High"]),
                "low": float(row["Low"]),
                "close": float(row["Close"]),
                "volume": int(row["Volume"]),
            })
    if rows:
        db.save_price_history(rows)
        print(f"  → {len(rows)}행 저장", flush=True)


def main() -> None:
    load_dotenv()
    today = _today_kst()
    db = ScreenerDB.from_env()

    kr_result = run_kr_pipeline(today)
    db.save_pipeline_result(_to_db_result(kr_result, today))

    # 최근 추천 종목 중 오늘 스크리너를 통과하지 못한 종목의 가격 보완
    # (통과하지 못하면 당일 종가가 stock_price_history에 누락되어 +1~+3일 수익률 계산 불가)
    _supplement_kr_price_history(db, kr_result, today)

    us_result = run_us_pipeline(today)
    db.save_pipeline_result(_to_db_result(us_result, today))

    # S&P500 + NASDAQ100 종목 히스토리 (기회 종목 스크리너용)
    # .yfinance_opp_seeded 파일(actions/cache로 유지)로 증분 여부 판단
    print("기회 종목 히스토리 수집 중...", flush=True)
    opp_mask = us_result.universe_df["index_membership"].isin(["NASDAQ100", "S&P500"])
    opp_tickers = us_result.universe_df.loc[opp_mask, "ticker"].tolist()

    if _SEED_FILE.exists():
        seed_date = date.fromisoformat(_SEED_FILE.read_text().strip())
        incremental_days = max((today - seed_date).days + 7, 14)
        # 파일 없으면 빈 set → 모든 티커를 신규로 처리해 3년 전체 재시드 (1회성 마이그레이션)
        seeded_tickers = (
            set(json.loads(_SEEDED_TICKERS_FILE.read_text()))
            if _SEEDED_TICKERS_FILE.exists()
            else set()
        )
        new_tickers = [t for t in opp_tickers if t not in seeded_tickers]
        existing_tickers = [t for t in opp_tickers if t in seeded_tickers]

        opp_histories: dict = {}
        if new_tickers:
            print(f"  신규/미시드 {len(new_tickers)}개 3년 전체 다운로드...", flush=True)
            opp_histories.update(
                prices_us.get_opportunity_histories(new_tickers, today, lookback_days=1095)
            )
        if existing_tickers:
            print(f"  기존 {len(existing_tickers)}개 증분 ({incremental_days}일)...", flush=True)
            opp_histories.update(
                prices_us.get_opportunity_histories(existing_tickers, today, lookback_days=incremental_days)
            )
    else:
        print("  최초 실행: 3년 전체 다운로드", flush=True)
        opp_histories = prices_us.get_opportunity_histories(opp_tickers, today, lookback_days=1095)

    opp_rows: list[dict] = []
    for ticker, hist in opp_histories.items():
        for idx, row in hist.iterrows():
            opp_rows.append({
                "ticker": ticker,
                "market": "US",
                "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
                "open": float(row.get("Open", 0)),
                "high": float(row.get("High", 0)),
                "low": float(row.get("Low", 0)),
                "close": float(row.get("Close", 0)),
                "volume": int(row.get("Volume", 0)),
            })
    db.save_price_history(opp_rows)
    print(f"  → {len(opp_rows)}행 저장", flush=True)
    _SEED_FILE.write_text(today.isoformat())
    _SEEDED_TICKERS_FILE.write_text(json.dumps(opp_tickers))

    # Russell 3000 히스토리를 yfinance 배치로 수집해 패턴 매칭 커버리지 확장.
    # KIS API(순차)는 스크리너 대상(S&P1500+NASDAQ100)만 받으므로 나머지는 여기서 별도 처리.
    russell_tickers = us_result.universe_df.loc[
        ~us_result.universe_df["index_membership"].isin(US_SCREENER_INDEXES),
        "ticker",
    ].tolist()
    if russell_tickers:
        print(f"Russell 3000 히스토리 수집 중... ({len(russell_tickers)}개, yfinance 배치)", flush=True)
        russell_histories = prices_us.get_opportunity_histories(
            russell_tickers, today, lookback_days=380
        )
        pattern_histories = {**us_result.price_history, **russell_histories}
    else:
        pattern_histories = us_result.price_history

    print("Gold Standard 패턴 유사도 계산 중...", flush=True)
    matches = compute_pattern_matches(pattern_histories, us_result.universe_df)
    # computed_at은 날짜가 아니라 실제 계산 시각(KST)을 저장한다.
    # 날짜만 넣으면 프론트가 UTC 자정으로 해석해 항상 "오전 9:00"으로 표시된다.
    db.save_pattern_matches(matches, datetime.now(KST).isoformat(timespec="seconds"))
    db.save_recommendation_history(matches, today.isoformat())

    # 패턴 매칭 종목 3년 히스토리 보강 (월봉 Bollinger/RSI 렌더링용)
    if matches:
        matched_tickers = list({m["ticker"] for m in matches})
        print(f"패턴 매칭 종목 3년 히스토리 보강 중... ({len(matched_tickers)}개)", flush=True)
        matched_histories = prices_us.get_opportunity_histories(matched_tickers, today, lookback_days=1095)
        matched_rows: list[dict] = []
        for ticker, hist in matched_histories.items():
            for idx, row in hist.iterrows():
                matched_rows.append({
                    "ticker": ticker,
                    "market": "US",
                    "date": idx.date().isoformat() if hasattr(idx, "date") else str(idx)[:10],
                    "open": float(row.get("Open", 0)),
                    "high": float(row.get("High", 0)),
                    "low": float(row.get("Low", 0)),
                    "close": float(row.get("Close", 0)),
                    "volume": int(row.get("Volume", 0)),
                })
        db.save_price_history(matched_rows)
        print(f"  → {len(matched_rows)}행 저장", flush=True)

    # 모든 히스토리 저장 후 월봉 사전 집계 MV 갱신
    print("월봉 집계(mv_monthly_ohlcv) 갱신 중...", flush=True)
    db.refresh_monthly_ohlcv()
    print("  → 완료", flush=True)


if __name__ == "__main__":
    main()
