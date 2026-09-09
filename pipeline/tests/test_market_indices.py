from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pandas as pd

from pipeline.src.market_indices import collect_market_index_snapshots

KST = timezone(timedelta(hours=9))

# 국내 지수 폴백(fdr GitHub CSV 캐시)은 하루 늦은 값을 준다 — 테스트에서도 그렇게
# 둬야 "yfinance를 먼저 쓰는가"를 실제로 확인할 수 있다.
_FAKE_FDR_KR = pd.DataFrame(
    {"Close": [2400.0, 2450.0]},
    index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
)


def _fake_download(ticker: str, dates: list[str], closes: list[float]):
    columns = pd.MultiIndex.from_tuples([("Close", ticker)])
    return pd.DataFrame([[c] for c in closes], columns=columns, index=pd.to_datetime(dates))


def _download_ok(ticker: str, **kwargs):
    if ticker in ("^KS11", "^KQ11"):
        # 실제로는 10일치가 오므로 오늘 봉을 버려도 최신·직전 두 개가 남는다.
        return _fake_download(
            ticker, ["2024-01-01", "2024-01-02", "2024-01-03"], [2450.0, 2500.0, 2550.0]
        )
    return _fake_download(ticker, ["2024-01-02", "2024-01-03"], [35000.0, 35200.0])


# 장 마감 후(16:30 KST) 실행 — 오늘 종가를 그대로 쓴다.
_AFTER_CLOSE = datetime(2024, 1, 3, 16, 30, tzinfo=KST)


@patch("pipeline.src.market_indices.yf.download", side_effect=_download_ok)
@patch("pipeline.src.market_indices.fdr.DataReader", return_value=_FAKE_FDR_KR)
def test_collect_market_index_snapshots_returns_latest_and_prev_close(mock_fdr, mock_yf):
    result = collect_market_index_snapshots(date(2024, 1, 3), now_kst=_AFTER_CLOSE)

    by_name = {r["index_name"]: r for r in result}
    assert by_name["코스피"]["close"] == 2550.0
    assert by_name["코스피"]["prev_close"] == 2500.0
    assert by_name["코스피"]["date"] == "2024-01-03"
    assert by_name["다우존스"]["close"] == 35200.0
    assert by_name["다우존스"]["prev_close"] == 35000.0
    # 5개(코스피·코스닥·다우존스·나스닥·S&P500) 전부 수집돼야 한다
    assert len(result) == 5
    # 국내도 실시간(yfinance)에서 나와야 한다 — fdr 캐시는 하루 늦어서 부르면 안 된다.
    assert mock_fdr.call_count == 0


@patch("pipeline.src.market_indices.yf.download", side_effect=_download_ok)
@patch("pipeline.src.market_indices.fdr.DataReader", return_value=_FAKE_FDR_KR)
def test_kr_snapshot_drops_todays_unfinished_bar_before_market_close(mock_fdr, mock_yf):
    # 한국장 마감(15:30) 전에 실행하면 오늘(1/3) 봉은 아직 장중 값이라 버리고
    # 직전 거래일(1/2) 종가를 저장해야 한다.
    before_close = datetime(2024, 1, 3, 6, 30, tzinfo=KST)

    result = collect_market_index_snapshots(date(2024, 1, 3), now_kst=before_close)

    kospi = {r["index_name"]: r for r in result}["코스피"]
    assert kospi["date"] == "2024-01-02"
    assert kospi["close"] == 2500.0
    assert kospi["prev_close"] == 2450.0
    # 하루 늦은 fdr 캐시로 떨어지지 않고 실시간 값 안에서 해결돼야 한다.
    assert mock_fdr.call_count == 0


@patch("pipeline.src.market_indices.yf.download", side_effect=RuntimeError("network down"))
@patch("pipeline.src.market_indices.fdr.DataReader", return_value=_FAKE_FDR_KR)
def test_kr_falls_back_to_fdr_cache_when_yfinance_fails(mock_fdr, mock_yf):
    # yfinance가 통째로 죽어도 국내 지수는 fdr 캐시로라도 채운다(하루 늦은 값 <<< 빈 값).
    result = collect_market_index_snapshots(date(2024, 1, 3), now_kst=_AFTER_CLOSE)

    by_name = {r["index_name"]: r for r in result}
    assert set(by_name) == {"코스피", "코스닥"}
    assert by_name["코스피"]["close"] == 2450.0


@patch("pipeline.src.market_indices.yf.download", side_effect=_download_ok)
@patch(
    "pipeline.src.market_indices.fdr.DataReader",
    return_value=pd.DataFrame({"Close": [2500.0]}, index=pd.to_datetime(["2024-01-02"])),
)
def test_collect_market_index_snapshots_skips_index_with_fewer_than_two_closes(mock_fdr, mock_yf):
    def one_close(ticker: str, **kwargs):
        if ticker in ("^KS11", "^KQ11"):
            return _fake_download(ticker, ["2024-01-03"], [2550.0])
        return _download_ok(ticker, **kwargs)

    mock_yf.side_effect = one_close

    result = collect_market_index_snapshots(date(2024, 1, 3), now_kst=_AFTER_CLOSE)

    names = {r["index_name"] for r in result}
    assert "코스피" not in names
    assert "코스닥" not in names
    assert "다우존스" in names
