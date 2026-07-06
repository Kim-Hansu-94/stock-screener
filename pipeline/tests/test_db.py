from unittest.mock import MagicMock

from pipeline.src.db import PipelineResult, ScreenerDB


def test_save_pipeline_result_writes_all_tables():
    client = MagicMock()
    db = ScreenerDB(client)

    # 종목의 "date"(2024-01-01)는 result.date(2024-01-02)와 일부러 다르게 주어,
    # save_pipeline_result가 종목 자체의 date를 result.date로 덮어쓰지 않는지 검증한다.
    result = PipelineResult(
        date="2024-01-02",
        market="KR",
        regime="bull",
        leading_sectors=["Semiconductors", "Auto"],
        screened_stocks=[{"ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
                           "close": 70000, "market_cap": 4e14, "rsi": 45.0, "date": "2024-01-01"}],
        price_history=[{"ticker": "005930", "market": "KR", "date": "2024-01-02",
                         "open": 100, "high": 105, "low": 99, "close": 104, "volume": 1000}],
    )

    db.save_pipeline_result(result)

    client.table.assert_any_call("market_regime")
    client.table.assert_any_call("leading_sectors")
    client.table.assert_any_call("screened_stocks")
    client.table.assert_any_call("stock_price_history")

    regime_call = client.table.return_value.upsert.call_args_list[0]
    assert regime_call.args[0] == {"date": "2024-01-02", "market": "KR", "regime": "bull"}

    screened_call = client.table.return_value.upsert.call_args_list[2]
    assert screened_call.args[0] == [{
        "market": "KR", "ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
        "close": 70000, "market_cap": 4e14, "rsi": 45.0, "date": "2024-01-01",
    }]


def test_save_pipeline_result_skips_empty_sector_and_stock_lists():
    client = MagicMock()
    db = ScreenerDB(client)

    result = PipelineResult(
        date="2024-01-02", market="KR", regime="bear",
        leading_sectors=[], screened_stocks=[], price_history=[],
    )

    db.save_pipeline_result(result)

    table_calls = [call.args[0] for call in client.table.call_args_list]
    assert table_calls == ["market_regime"]
