from __future__ import annotations

from datetime import date, datetime, timedelta

import FinanceDataReader as fdr
import pandas as pd
import yfinance as yf

from .market_indices import KST, drop_unfinished_kr_bar, naver_index_closes

KOSPI_INDEX_TICKER = "KS11"
KOSPI_YAHOO_TICKER = "^KS11"
KOSPI_NAVER_SYMBOL = "KOSPI"


def get_kospi_index_history(end: date, lookback_days: int, now_kst: datetime | None = None) -> pd.Series:
    """코스피 지수 종가 시계열. **이 시리즈의 마지막 날짜가 KR 파이프라인 전체의 기준일이다.**

    ⚠️ `fdr.DataReader("KS11")`을 쓰면 안 된다 — 개별 종목(네이버 실시간)과 달리 이 경로는
    제3자가 GitHub에 올려두는 CSV 캐시를 읽어 하루 이상 늦은 값을 에러 없이 준다
    (market_indices.py의 같은 주의사항 참고).

    이게 단순히 "지수가 하루 늦는" 문제로 끝나지 않았다: 기준일(as_of)이 지수에서 나오는
    바람에 market_regime·leading_sectors는 9/7로, 종목(screened_stocks)은 네이버 기준
    9/9로 저장됐고, 화면은 "최신 장세 날짜"로 종목을 찾으므로 **눌림목 탭이 통째로 비었다**
    (2026-09-09 발견).

    ⚠️ yfinance(^KS11)도 하루 늦을 수 있다(2026-09-10). 그래서 시황 위젯과 똑같이
    네이버 → yfinance → fdr 순서로 떨어진다 — 두 곳은 **항상 같은 소스·같은 장중 봉
    처리를 유지할 것**(한쪽만 고치면 장세 날짜와 종목 날짜가 다시 어긋난다).
    """
    start = end - timedelta(days=lookback_days)
    now = now_kst or datetime.now(KST)

    # 1순위: 네이버(국내 지수의 본진).
    try:
        dates, values = naver_index_closes(KOSPI_NAVER_SYMBOL, start, end)
        dates, values = drop_unfinished_kr_bar(dates, values, now)
        if len(values) >= 2:
            return pd.Series(values, index=pd.to_datetime(dates), name="Close")
    except Exception as exc:  # noqa: BLE001
        print(f"  코스피 지수 네이버 조회 실패: {exc}", flush=True)

    print("  코스피 지수: 네이버 데이터 부족 → yfinance로 대체", flush=True)
    try:
        # end는 배타적이라 하루를 더해야 오늘 종가가 들어온다(저녁 실행용).
        df = yf.download(
            KOSPI_YAHOO_TICKER,
            start=start.isoformat(),
            end=(end + timedelta(days=1)).isoformat(),
            progress=False,
        )
        if not df.empty:
            closes = df["Close"][KOSPI_YAHOO_TICKER].dropna()
            dates = [d.date().isoformat() for d in closes.index]
            dates, values = drop_unfinished_kr_bar(dates, list(closes), now)
            if len(values) >= 2:
                return pd.Series(values, index=pd.to_datetime(dates), name="Close")
    except Exception as exc:  # noqa: BLE001
        print(f"  코스피 지수 실시간 조회 실패: {exc}", flush=True)

    print("  코스피 지수: fdr 캐시(하루 지연 가능)로 대체", flush=True)
    df = fdr.DataReader(KOSPI_INDEX_TICKER, start.isoformat(), end.isoformat())
    return df["Close"]


def get_kr_stock_history(ticker: str, end: date, lookback_days: int) -> pd.DataFrame:
    start = end - timedelta(days=lookback_days)
    df = fdr.DataReader(ticker, start.isoformat(), end.isoformat())
    return df[["Open", "High", "Low", "Close", "Volume"]]
