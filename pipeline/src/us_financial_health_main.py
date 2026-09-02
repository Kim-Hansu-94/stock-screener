"""US 재무건전성(대차대조표) 전용 수집 — 21:00 KST 별도 워크플로.

실적(income_stmt)은 06:30 KST 본 파이프라인이 매일 수집한다(fundamentals.py).
대차대조표(current_assets 등)는 yfinance에서 income_stmt와 별도 호출이 필요해
종목당 요청이 두 배가 된다 — 본 파이프라인에 얹지 않고 낮은 빈도(같은 30일
주기)로 독립 실행한다.

유니버스도 다시 수집하지 않는다 — universe_us.py(S&P1500+NASDAQ100+Russell3000
전체 수집)를 다시 돌리면 이 실행만을 위해 무거운 작업을 반복하는 셈이라,
그날 아침 본 파이프라인이 이미 stock_universe에 저장해 둔 것을 그대로 읽는다.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import ScreenerDB
from .fundamentals import refresh_financial_health
from .opportunities import in_band_tickers
from .pipeline import US_MIN_MARKET_CAP

KST = timezone(timedelta(hours=9))
US_OPP_INDEXES = ("NASDAQ100", "S&P500")


def _today_kst() -> date:
    return datetime.now(KST).date()


def main() -> None:
    load_dotenv()
    today = _today_kst()
    db = ScreenerDB.from_env()

    opp_tickers = db.get_universe_tickers("US", list(US_OPP_INDEXES), US_MIN_MARKET_CAP)
    if not opp_tickers:
        print(
            "US 재무건전성 수집 생략: stock_universe에 US 유니버스가 없음 "
            "(본 파이프라인이 아직 안 돌았을 수 있음)",
            flush=True,
        )
        return

    # fundamentals.py의 실적 수집과 같은 이유로 조정폭 밴드 안 종목만 대상으로
    # 좁힌다 — stock_fundamentals는 그 밴드 카드에서만 읽히므로 나머지는 낭비다.
    in_band = list(in_band_tickers(db, "US", opp_tickers, today))
    refresh_financial_health(db, in_band, today)


if __name__ == "__main__":
    main()
