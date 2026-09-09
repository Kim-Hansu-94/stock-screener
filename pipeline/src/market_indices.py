"""홈 화면 시황 위젯용 지수 스냅샷 수집 (코스피·코스닥·다우존스·나스닥·S&P500).

차트가 아니라 "지금 얼마고 전일 대비 몇 % 인지"만 보여주면 되므로, 전체 이력을
쌓지 않고 최신 종가·직전 종가만 매 실행 덮어쓴다(save_market_index_snapshots가
upsert). 환율은 프론트가 frankfurter.app에서 직접 받아오므로(fetchUsdKrwRate)
여기서는 다루지 않는다.

⚠️ 국내 지수를 FinanceDataReader로 받으면 안 된다(2026-09-09 수정). 개별 종목과
달리 `fdr.DataReader('KS11')`은 거래소를 직접 부르지 않고 제3자가 GitHub에 올려두는
CSV 캐시(FinanceData/fdr_krx_data_cache)를 읽는데, 그 파일 갱신이 하루 이상 늦다 —
9/9 오후에 조회해도 마지막 행이 9/7이었고, 그래서 화면에 "국내 9/7 장마감 기준"이
떠 있었다(해외는 yfinance 실시간이라 9/8로 정상). 에러가 아니라 조용히 옛날 값을
주기 때문에 파이프라인 로그만 봐서는 알 수 없다.

그래서 국내도 미국과 같은 yfinance(^KS11/^KQ11)를 먼저 쓰고, 그게 실패했을 때만
fdr 캐시로 떨어진다 — 하루 늦은 값이라도 아무것도 없는 것보다는 낫다(대신 로그에
남긴다). 어느 값이 언제 것인지 확인할 수 있게 수집한 날짜를 로그에 찍는다.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import FinanceDataReader as fdr
import yfinance as yf

KST = timezone(timedelta(hours=9))

# 연휴 등으로 며칠 비어도 최신·직전 종가 둘 다 확보할 수 있게 여유를 둔다.
_LOOKBACK_DAYS = 10

# 한국거래소 정규장 마감(15:30 KST)에 종가 확정 여유를 더한 시각. 이 시각 전에
# 실행하면(정기 06:30 실행, 손으로 돌리는 낮 시간 실행) 오늘 봉은 아직 장중
# 값이므로 "장마감 종가"로 저장하면 안 된다.
_KR_CLOSE_HOUR, _KR_CLOSE_MINUTE = 15, 40

# (표시 이름, yfinance 티커, FinanceDataReader 폴백 티커)
_KR_INDEXES = [
    ("코스피", "^KS11", "KS11"),
    ("코스닥", "^KQ11", "KQ11"),
]

# (표시 이름, yfinance 티커)
_US_INDEXES = [
    ("다우존스", "^DJI"),
    ("나스닥", "^IXIC"),
    ("S&P500", "^GSPC"),
]


def _snapshot_from_closes(name: str, dates: list, closes: list[float]) -> dict | None:
    if len(closes) < 2:
        return None
    return {
        "index_name": name,
        "date": dates[-1],
        "close": float(closes[-1]),
        "prev_close": float(closes[-2]),
    }


def _yahoo_closes(ticker: str, start: date, end: date) -> tuple[list[str], list[float]]:
    """yfinance 일봉의 (날짜, 종가). end는 배타적이라 호출부가 하루를 더해 넘긴다."""
    df = yf.download(ticker, start=start.isoformat(), end=end.isoformat(), progress=False)
    if df.empty:
        return [], []
    closes = df["Close"][ticker].dropna()
    return [d.date().isoformat() for d in closes.index], [float(c) for c in closes]


def _fdr_closes(ticker: str, start: date, end: date) -> tuple[list[str], list[float]]:
    df = fdr.DataReader(ticker, start.isoformat(), end.isoformat())
    closes = df["Close"].dropna()
    return [d.date().isoformat() for d in closes.index], [float(c) for c in closes]


def drop_unfinished_kr_bar(
    dates: list[str], closes: list[float], now_kst: datetime
) -> tuple[list[str], list[float]]:
    """아직 안 끝난 오늘 봉을 떼어낸다.

    한국장 마감 전에 조회하면 yfinance가 "오늘" 봉을 장중 값으로 채워 준다. 그걸
    그대로 저장하면 화면에 장중 시세가 "장마감 기준"으로 뜬다.
    """
    if not dates:
        return dates, closes
    is_today = dates[-1] == now_kst.date().isoformat()
    before_close = (now_kst.hour, now_kst.minute) < (_KR_CLOSE_HOUR, _KR_CLOSE_MINUTE)
    if is_today and before_close:
        return dates[:-1], closes[:-1]
    return dates, closes


def _kr_snapshot(
    name: str, yahoo_ticker: str, fdr_ticker: str, today: date, now_kst: datetime
) -> dict | None:
    start = today - timedelta(days=_LOOKBACK_DAYS)
    dates: list[str] = []
    closes: list[float] = []
    try:
        # end가 배타적이라 하루를 더해야 오늘 종가가 들어온다(저녁 16:30 실행용).
        dates, closes = _yahoo_closes(yahoo_ticker, start, today + timedelta(days=1))
        dates, closes = drop_unfinished_kr_bar(dates, closes, now_kst)
    except Exception as exc:  # noqa: BLE001
        print(f"  시황 지수 실시간 조회 실패 ({name}): {exc}", flush=True)

    if len(closes) < 2:
        # fdr은 GitHub CSV 캐시라 보통 하루 늦다 — 최후 수단임을 로그에 남긴다.
        print(f"  시황 지수 {name}: 실시간 데이터 부족 → fdr 캐시(하루 지연 가능)로 대체", flush=True)
        dates, closes = _fdr_closes(fdr_ticker, start, today)

    return _snapshot_from_closes(name, dates, closes)


def _us_snapshot(name: str, ticker: str, today: date) -> dict | None:
    # 미장은 한국 시간 새벽에 닫히므로 today를 그대로(배타적으로) 넘기면 직전
    # 거래일까지 들어온다 — 아직 열리지도 않은 오늘 봉을 잡을 위험이 없다.
    dates, closes = _yahoo_closes(ticker, today - timedelta(days=_LOOKBACK_DAYS), today)
    return _snapshot_from_closes(name, dates, closes)


def collect_market_index_snapshots(today: date, now_kst: datetime | None = None) -> list[dict]:
    now = now_kst or datetime.now(KST)
    snapshots: list[dict] = []
    for name, yahoo_ticker, fdr_ticker in _KR_INDEXES:
        try:
            snap = _kr_snapshot(name, yahoo_ticker, fdr_ticker, today, now)
        except Exception as exc:  # noqa: BLE001
            print(f"  시황 지수 수집 실패 ({name}): {exc}", flush=True)
            continue
        if snap:
            snapshots.append(snap)
    for name, ticker in _US_INDEXES:
        try:
            snap = _us_snapshot(name, ticker, today)
        except Exception as exc:  # noqa: BLE001
            print(f"  시황 지수 수집 실패 ({name}): {exc}", flush=True)
            continue
        if snap:
            snapshots.append(snap)

    # 어느 지수가 언제 것인지 로그로 확인할 수 있게 남긴다 — 소스가 조용히 옛날
    # 값을 주는 사고(fdr KRX 캐시)가 실제로 있었기 때문에 개수만으로는 부족하다.
    for snap in snapshots:
        print(f"    {snap['index_name']}: {snap['date']} 종가 {snap['close']:,.2f}", flush=True)
    return snapshots
