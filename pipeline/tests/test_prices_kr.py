from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch

import pandas as pd

from pipeline.src.prices_kr import get_kospi_index_history, get_kr_stock_history

FAKE_OHLCV = pd.DataFrame({
    "Open": [100, 101],
    "High": [105, 106],
    "Low": [99, 100],
    "Close": [104, 105],
    "Volume": [1000, 1100],
    "Change": [0.01, 0.01],
}, index=pd.to_datetime(["2024-01-01", "2024-01-02"]))


KST = timezone(timedelta(hours=9))
_AFTER_CLOSE = datetime(2024, 1, 3, 16, 30, tzinfo=KST)


def _fake_yahoo(dates: list[str], closes: list[float]) -> pd.DataFrame:
    columns = pd.MultiIndex.from_tuples([("Close", "^KS11")])
    return pd.DataFrame([[c] for c in closes], columns=columns, index=pd.to_datetime(dates))


# 이 시리즈의 마지막 날짜가 KR 파이프라인 전체의 기준일(as_of)이 되고, 화면은 그 날짜로
# 종목을 찾는다. fdr 캐시(하루 지연)를 쓰면 장세와 종목 날짜가 어긋나 눌림목 탭이
# 통째로 빈다 — 2026-09-09에 실제로 그랬다.
@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
@patch("pipeline.src.prices_kr.yf.download")
def test_get_kospi_index_history_prefers_realtime_over_fdr_cache(mock_yf, mock_reader):
    mock_yf.return_value = _fake_yahoo(["2024-01-02", "2024-01-03"], [2500.0, 2550.0])

    result = get_kospi_index_history(end=date(2024, 1, 3), lookback_days=300, now_kst=_AFTER_CLOSE)

    assert list(result) == [2500.0, 2550.0]
    assert result.index[-1].date() == date(2024, 1, 3)
    # 하루 늦는 fdr 캐시는 부르지도 않아야 한다.
    assert mock_reader.call_count == 0


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
@patch("pipeline.src.prices_kr.yf.download", side_effect=RuntimeError("network down"))
def test_get_kospi_index_history_falls_back_to_fdr(mock_yf, mock_reader):
    result = get_kospi_index_history(end=date(2024, 1, 2), lookback_days=300, now_kst=_AFTER_CLOSE)

    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "KS11"
    assert list(result) == [104, 105]


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
@patch("pipeline.src.prices_kr.yf.download")
def test_get_kospi_index_history_drops_todays_unfinished_bar(mock_yf, mock_reader):
    # 장 마감(15:30) 전 실행이면 오늘 봉은 장중 값이라 기준일로 삼으면 안 된다.
    mock_yf.return_value = _fake_yahoo(
        ["2024-01-01", "2024-01-02", "2024-01-03"], [2450.0, 2500.0, 2550.0]
    )
    before_close = datetime(2024, 1, 3, 6, 30, tzinfo=KST)

    result = get_kospi_index_history(end=date(2024, 1, 3), lookback_days=300, now_kst=before_close)

    assert result.index[-1].date() == date(2024, 1, 2)
    assert mock_reader.call_count == 0


@patch("pipeline.src.prices_kr.fdr.DataReader", return_value=FAKE_OHLCV)
def test_get_kr_stock_history_returns_ohlcv_columns(mock_reader):
    result = get_kr_stock_history("005930", end=date(2024, 1, 2), lookback_days=120)
    mock_reader.assert_called_once()
    assert mock_reader.call_args[0][0] == "005930"
    assert list(result.columns) == ["Open", "High", "Low", "Close", "Volume"]
