from datetime import date
from unittest.mock import patch

import pandas as pd

from pipeline.src.market_indices import collect_market_index_snapshots

_FAKE_KR = pd.DataFrame(
    {"Close": [2500.0, 2550.0]},
    index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
)


def _fake_us_download(ticker: str):
    columns = pd.MultiIndex.from_tuples([("Close", ticker)])
    return pd.DataFrame(
        [[35000.0], [35200.0]],
        columns=columns,
        index=pd.to_datetime(["2024-01-01", "2024-01-02"]),
    )


@patch("pipeline.src.market_indices.yf.download")
@patch("pipeline.src.market_indices.fdr.DataReader", return_value=_FAKE_KR)
def test_collect_market_index_snapshots_returns_latest_and_prev_close(mock_fdr, mock_yf):
    mock_yf.side_effect = lambda ticker, **kwargs: _fake_us_download(ticker)

    result = collect_market_index_snapshots(date(2024, 1, 2))

    by_name = {r["index_name"]: r for r in result}
    assert by_name["코스피"]["close"] == 2550.0
    assert by_name["코스피"]["prev_close"] == 2500.0
    assert by_name["코스피"]["date"] == "2024-01-02"
    assert by_name["다우존스"]["close"] == 35200.0
    assert by_name["다우존스"]["prev_close"] == 35000.0
    # 5개(코스피·코스닥·다우존스·나스닥·S&P500) 전부 수집돼야 한다
    assert len(result) == 5


@patch("pipeline.src.market_indices.yf.download", side_effect=RuntimeError("network down"))
@patch("pipeline.src.market_indices.fdr.DataReader", return_value=_FAKE_KR)
def test_collect_market_index_snapshots_skips_failed_index_without_crashing(mock_fdr, mock_yf):
    # 미국 지수 3개는 전부 실패해도, 국내 지수 2개는 그대로 수집돼야 한다
    # (한쪽 소스 장애가 전체를 막으면 안 됨).
    result = collect_market_index_snapshots(date(2024, 1, 2))

    names = {r["index_name"] for r in result}
    assert names == {"코스피", "코스닥"}


@patch("pipeline.src.market_indices.yf.download")
@patch(
    "pipeline.src.market_indices.fdr.DataReader",
    return_value=pd.DataFrame({"Close": [2500.0]}, index=pd.to_datetime(["2024-01-02"])),
)
def test_collect_market_index_snapshots_skips_index_with_fewer_than_two_closes(mock_fdr, mock_yf):
    mock_yf.side_effect = lambda ticker, **kwargs: _fake_us_download(ticker)

    result = collect_market_index_snapshots(date(2024, 1, 2))

    names = {r["index_name"] for r in result}
    assert "코스피" not in names
    assert "코스닥" not in names
