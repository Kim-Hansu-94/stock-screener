from collections import defaultdict
from unittest.mock import MagicMock

from pipeline.src.db import PipelineResult, ScreenerDB


def _client_with_per_table_mocks():
    """테이블 이름별로 다른 mock을 돌려주는 client.

    MagicMock 기본 동작은 client.table("a")와 client.table("b")가 같은 객체라
    "어느 테이블에 delete가 갔는지"를 구분할 수 없다.
    """
    tables: dict[str, MagicMock] = defaultdict(MagicMock)
    client = MagicMock()
    client.table.side_effect = lambda name: tables[name]
    return client, tables


def test_save_pipeline_result_writes_all_tables():
    client, tables = _client_with_per_table_mocks()
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

    assert {"market_regime", "leading_sectors", "screened_stocks",
            "stock_price_history"} <= set(tables)

    regime_call = tables["market_regime"].upsert.call_args_list[0]
    assert regime_call.args[0] == {"date": "2024-01-02", "market": "KR", "regime": "bull"}

    screened_call = tables["screened_stocks"].upsert.call_args_list[0]
    assert screened_call.args[0] == [{
        "market": "KR", "ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
        "close": 70000, "market_cap": 4e14, "rsi": 45.0, "date": "2024-01-01",
    }]


def test_screened_stocks_are_replaced_not_merged():
    """같은 날 두 번 돌 때 지난 실행의 종목이 남지 않도록 그날 행을 먼저 지운다.

    upsert만 하면 PK가 겹치는 종목만 덮이고, 이번엔 조건을 만족하지 않아 빠진
    종목의 지난 행은 그대로 남아 유령처럼 화면에 계속 뜬다.
    """
    client, tables = _client_with_per_table_mocks()
    db = ScreenerDB(client)

    result = PipelineResult(
        date="2024-01-02", market="KR", regime="bull",
        leading_sectors=["Semiconductors"],
        screened_stocks=[{"ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
                           "close": 70000, "market_cap": 4e14, "rsi": 45.0, "date": "2024-01-02"}],
    )

    db.save_pipeline_result(result)

    # 넣기 전에 그 시장·그 날짜를 지웠는지
    eq_chain = tables["screened_stocks"].delete.return_value.eq
    assert eq_chain.call_args_list[0].args == ("market", "KR")
    assert eq_chain.return_value.eq.call_args_list[0].args == ("date", "2024-01-02")
    assert tables["screened_stocks"].upsert.called

    # 주도 섹터도 같은 이유로 갈아끼운다 (섹터 수가 줄면 지난 rank가 남는다)
    assert tables["leading_sectors"].delete.called


def test_empty_screening_result_still_clears_the_day():
    """통과 종목이 0개여도 삭제는 수행한다.

    스크리닝 실패는 예외로 중단되므로, 여기에 도달했다는 건 '정상적으로 돌았는데
    조건을 만족하는 종목이 없었다'는 뜻이다. 그런데도 지난 실행 행을 남겨두면
    조건을 만족하지 않는 종목이 화면에 계속 뜬다.
    """
    client, tables = _client_with_per_table_mocks()
    db = ScreenerDB(client)

    result = PipelineResult(
        date="2024-01-02", market="KR", regime="bear",
        leading_sectors=[], screened_stocks=[], price_history=[],
    )

    db.save_pipeline_result(result)

    assert tables["screened_stocks"].delete.called
    assert not tables["screened_stocks"].upsert.called
    assert tables["leading_sectors"].delete.called
    assert not tables["leading_sectors"].upsert.called
