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


def test_replace_opportunity_snapshot_clears_the_market_first():
    """스냅샷은 그 시장 행을 지우고 다시 넣는다.

    PK가 (ticker, market)이라 날짜가 없어서, 저장만 하면 이번에 빠진 종목의 지난 행이
    영구히 남는다. 예전에는 `computed_at < today`로 지웠는데 같은 날 기준이 바뀌면
    (코드 배포 후 재실행) 옛 행도 computed_at이 오늘이라 그 비교를 빠져나갔다.
    """
    client, tables = _client_with_per_table_mocks()
    db = ScreenerDB(client)

    db.replace_opportunity_snapshot("KR", [{"ticker": "005930", "market": "KR", "score": 0.8}])

    assert tables["opportunity_snapshot"].delete.return_value.eq.call_args_list[0].args == (
        "market", "KR",
    )
    assert tables["opportunity_snapshot"].upsert.called


def test_replace_opportunity_snapshot_does_nothing_when_empty():
    """빈 결과로는 지우지 않는다.

    호출부가 데이터 이상(밴드 계산 실패 등)으로 빈 목록에 도달할 수 있어서,
    여기서 지우면 일시적 문제가 종목발굴 탭을 통째로 비운다.
    """
    client, tables = _client_with_per_table_mocks()
    ScreenerDB(client).replace_opportunity_snapshot("KR", [])
    assert "opportunity_snapshot" not in tables


# ── 월봉 적립 (일봉 600일 보관 전제) ──────────────────────────────────────
# 일봉이 보관 구간 밖으로 밀려나기 전에 월봉으로 남겨두는 호출이라, 조용히
# 빠지면 3년 고점이 몇 달 뒤에야 어긋난 채로 발견된다.

def test_accrue_long_monthly_calls_the_rpc():
    client = MagicMock()
    ScreenerDB(client).accrue_long_monthly()
    client.rpc.assert_called_once_with("accrue_long_monthly")


def test_accrue_long_monthly_failure_does_not_stop_the_pipeline(capsys):
    """적립이 실패해도 그날 스크리닝 전체를 죽이면 안 된다 (다음 실행에서 다시 적립된다)."""
    client = MagicMock()
    client.rpc.side_effect = RuntimeError("함수 미배포")

    ScreenerDB(client).accrue_long_monthly()  # 예외가 새어 나오면 실패

    assert "월봉 적립" in capsys.readouterr().out
