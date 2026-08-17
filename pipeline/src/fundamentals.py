"""실적 요약 수집.

횡보·조정 스크리너는 가격·거래량만 본다. 그래서 "5년째 내려오는 중인 종목"과
"바닥을 다진 종목"의 차트 모양이 같으면 구분하지 못한다. 둘을 가르는 가장
결정적인 정보는 하나다 — 주가가 빠질 때 실적도 같이 빠졌는가.

국내 종목은 dart_fundamentals.py(DART 전자공시)로 수집한다 — Yahoo가 국내
소형주 손익계산서를 잘 못 가지고 있어 계속 "데이터 없음"으로 남는 문제가 있었다.
미국 종목은 그대로 yfinance를 쓴다. yfinance는 종목당 요청이 필요해 전 종목을
매일 받을 수 없다. 실적은 분기에 한 번 바뀌므로, 30일이 지난 종목만 대상으로
하고 1회 실행당 상한을 둬서 여러 실행에 걸쳐 채운다(첫 주에 전체가 채워지고
이후엔 갱신분만 남는다).
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from . import dart_fundamentals
from .db import ScreenerDB

# 1회 실행당 조회 상한. 종목당 2~3초(재무제표 + info 각 1요청)라 전 종목을 한 번에
# 받으면 실행이 1시간 가까이 길어지고 Yahoo 레이트 리밋에 걸린다. 아래 우선순위로
# 후보 풀이 앞에 오므로, 이 상한이면 화면에 뜨는 종목은 1회 실행으로 모두 채워진다.
# 실패한 종목은 stale로 남아 다음 실행에서 자동 재시도된다.
MAX_PER_RUN = 400
# 중간 저장 단위. 전부 받은 뒤 한 번에 저장하면 실행이 중단될 때 그때까지의 수집분이
# 통째로 날아간다. 저장된 종목은 updated_at이 갱신돼 다음 실행에서 건너뛴다.
SAVE_CHUNK = 50
# 실적은 분기 단위로 바뀌므로 이 기간이 지난 종목만 다시 받는다.
MAX_AGE_DAYS = 30
# 우선순위 판정용 — frontend/app/discover/page.tsx의 조정폭 밴드와 동일해야 한다.
MIN_DRAWDOWN = 20.0
MAX_DRAWDOWN = 60.0
# get_opp_drawdowns RPC 배치 크기 (frontend queries.ts의 OPP_DRAWDOWN_BATCH와 동일)
OPP_DRAWDOWN_BATCH = 250

_REVENUE_KEYS = ["Total Revenue", "TotalRevenue", "Operating Revenue"]
_OPERATING_KEYS = ["Operating Income", "OperatingIncome", "Total Operating Income As Reported"]
_NET_INCOME_KEYS = ["Net Income", "NetIncome", "Net Income Common Stockholders"]
_EPS_KEYS = ["Diluted EPS", "Basic EPS"]


def _yahoo_symbol(ticker: str, market: str) -> str:
    # KR 기회 종목 유니버스는 KOSPI만이라 .KS로 충분하다.
    return f"{ticker}.KS" if market == "KR" else ticker


def _pick(df: pd.DataFrame, keys: list[str], col) -> float | None:
    for key in keys:
        if key in df.index:
            value = df.loc[key, col]
            if pd.notna(value):
                return float(value)
    return None


def _extract(symbol: str) -> dict | None:
    """연간 손익계산서에서 최신/직전(3년 전) 실적과 밸류에이션 지표를 뽑는다."""
    ticker = yf.Ticker(symbol)
    try:
        inc = ticker.income_stmt
    except Exception:  # noqa: BLE001
        return None
    if inc is None or inc.empty or len(inc.columns) == 0:
        return None

    # 컬럼은 최신 회계연도부터 정렬돼 있다. 가장 오래된 열을 "직전"으로 삼아
    # 가능한 한 긴 구간(보통 3~4년)의 변화를 본다.
    latest_col = inc.columns[0]
    prior_col = inc.columns[-1]
    if latest_col == prior_col:
        prior_col = None

    def at(keys: list[str], col) -> float | None:
        return _pick(inc, keys, col) if col is not None else None

    per = pbr = None
    try:
        info = ticker.info or {}
        per = info.get("trailingPE")
        pbr = info.get("priceToBook")
    except Exception:  # noqa: BLE001
        pass

    return {
        "fiscal_year_latest": int(pd.Timestamp(latest_col).year),
        "fiscal_year_prior": int(pd.Timestamp(prior_col).year) if prior_col is not None else None,
        "revenue_latest": at(_REVENUE_KEYS, latest_col),
        "revenue_prior": at(_REVENUE_KEYS, prior_col),
        "operating_income_latest": at(_OPERATING_KEYS, latest_col),
        "operating_income_prior": at(_OPERATING_KEYS, prior_col),
        "net_income_latest": at(_NET_INCOME_KEYS, latest_col),
        "net_income_prior": at(_NET_INCOME_KEYS, prior_col),
        "eps_latest": at(_EPS_KEYS, latest_col),
        "eps_prior": at(_EPS_KEYS, prior_col),
        "per": float(per) if isinstance(per, (int, float)) else None,
        "pbr": float(pbr) if isinstance(pbr, (int, float)) else None,
    }


def _stale_tickers(db: ScreenerDB, market: str, tickers: list[str], today: date) -> list[str]:
    cutoff = (today - timedelta(days=MAX_AGE_DAYS)).isoformat()
    fresh: set[str] = set()
    page = 1000
    start = 0
    while True:
        result = (
            db.client.table("stock_fundamentals")
            .select("ticker, updated_at")
            .eq("market", market)
            .gte("updated_at", cutoff)
            .range(start, start + page - 1)
            .execute()
        )
        rows = result.data or []
        fresh.update(r["ticker"] for r in rows)
        if len(rows) < page:
            break
        start += page
    return [t for t in tickers if t not in fresh]


def _candidates_first(db: ScreenerDB, market: str, pending: list[str], today: date) -> list[str]:
    """조정폭 20~60% 구간(= 횡보·조정 탭 후보 풀)을 앞으로 당긴다.

    기준은 frontend/app/discover/page.tsx의 MIN/MAX_DRAWDOWN과 같아야 한다.
    조회에 실패하면 원래 순서를 그대로 쓴다 — 우선순위는 최적화일 뿐이고,
    실패했다고 실적 수집 자체를 멈출 이유는 없다.
    """
    # date(year-3, ...)은 윤년 2/29에 ValueError가 나므로 일수로 뺀다. 우선순위
    # 판정용이라 프론트(setFullYear(-3))와 며칠 어긋나는 것은 문제되지 않는다.
    cutoff = (today - timedelta(days=3 * 365)).isoformat()
    in_band: set[str] = set()
    try:
        for i in range(0, len(pending), OPP_DRAWDOWN_BATCH):
            batch = pending[i : i + OPP_DRAWDOWN_BATCH]
            result = db.client.rpc(
                "get_opp_drawdowns",
                {"p_market": market, "p_tickers": batch, "p_cutoff": cutoff},
            ).execute()
            for row in result.data or []:
                high3y = float(row.get("high3y") or 0)
                if high3y <= 0:
                    continue
                drawdown = (high3y - float(row["current_close"])) / high3y * 100
                if MIN_DRAWDOWN <= drawdown <= MAX_DRAWDOWN:
                    in_band.add(row["ticker"])
    except Exception as exc:  # noqa: BLE001
        print(f"  후보 우선순위 계산 실패 (원래 순서 유지): {exc}", flush=True)
        return pending

    if not in_band:
        return pending
    print(f"  후보 풀 {len(in_band)}개 우선", flush=True)
    return [t for t in pending if t in in_band] + [t for t in pending if t not in in_band]


def refresh_fundamentals(db: ScreenerDB, market: str, tickers: list[str], today: date) -> None:
    if not tickers:
        return
    if market == "KR" and not os.environ.get("DART_API_KEY"):
        # 키 미등록 상태로 400종목을 개별 시도해 전부 실패로 남기는 대신,
        # 한 줄로 원인을 밝히고 건너뛴다 — 등록되면 다음 실행부터 바로 채워진다.
        print("KR 실적 수집 생략: DART_API_KEY 미설정", flush=True)
        return
    try:
        pending = _stale_tickers(db, market, tickers, today)
    except Exception as exc:  # noqa: BLE001
        # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행한다.
        print(f"{market} 실적 대상 조회 실패: {exc}", flush=True)
        return
    if not pending:
        return

    # 화면에 실제로 뜨는 종목부터 채운다. 유니버스 순서대로 받으면 아무도 보지 않는
    # 종목의 실적을 먼저 가져오게 되어, 정작 카드에 뜨는 후보는 며칠간 빈칸이 된다.
    pending = _candidates_first(db, market, pending, today)

    batch = pending[:MAX_PER_RUN]
    print(f"{market} 실적 수집 ({len(batch)}/{len(pending)}개 대상)...", flush=True)

    pending_rows: list[dict] = []
    saved = 0
    failed = 0

    def flush() -> None:
        """모아둔 만큼 즉시 저장. 실행이 중간에 끊겨도 여기까지는 남는다."""
        nonlocal pending_rows, saved
        if not pending_rows:
            return
        try:
            db.save_fundamentals(pending_rows)
            saved += len(pending_rows)
        except Exception as exc:  # noqa: BLE001
            print(f"  실적 저장 실패 ({len(pending_rows)}개): {exc}", flush=True)
        pending_rows = []

    for n, ticker in enumerate(batch, 1):
        try:
            if market == "KR":
                data = dart_fundamentals.extract(ticker, today.year - 1)
            else:
                data = _extract(_yahoo_symbol(ticker, market))
        except Exception:  # noqa: BLE001
            data = None
        if data is None:
            failed += 1
        else:
            pending_rows.append(
                {"ticker": ticker, "market": market, "updated_at": today.isoformat(), **data}
            )
        # 중간 저장 — 러너가 죽거나 취소돼도 직전 청크까지의 수집분은 보존된다.
        if n % SAVE_CHUNK == 0:
            flush()
            print(f"  진행 {n}/{len(batch)} (저장 {saved} · 실패 {failed})", flush=True)

    flush()
    print(f"  → {saved}개 저장 (실패 {failed}개)", flush=True)
