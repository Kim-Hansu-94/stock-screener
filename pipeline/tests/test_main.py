from datetime import date
from unittest.mock import MagicMock

import pandas as pd

from pipeline.src import main as main_module
from pipeline.src.pipeline import MarketPipelineResult, ScreenedStock


def test_main_saves_kr_and_us_results(monkeypatch, tmp_path):
    # as_of는 wall-clock today(2024-01-02)와 일부러 다르게 주어, 파이프라인이
    # 실제 마지막 봉의 날짜를 그대로 전달하는지(= today로 덮어쓰지 않는지) 검증한다.
    kr_result = MarketPipelineResult(
        market="KR", regime="bull", as_of=date(2024, 1, 3), leading_sectors=["Semiconductors"],
        screened_stocks=[ScreenedStock(ticker="005930", name="Samsung", sector="Semiconductors",
                                        close=70000.0, market_cap=4e14, rsi=45.0, as_of=date(2024, 1, 3))],
        price_history={"005930": pd.DataFrame(
            {"Open": [100], "High": [105], "Low": [99], "Close": [104], "Volume": [1000]},
            index=pd.to_datetime(["2024-01-02"]),
        )},
    )
    # universe_df는 main.py가 index_membership 컬럼을 참조하므로(기회 종목/Russell 분류)
    # production과 동일한 형태(ticker/name/sector/index_membership)로 채워야 한다.
    us_universe_df = pd.DataFrame([
        {"ticker": "AAPL", "name": "Apple", "sector": "Technology", "index_membership": "S&P500"},
    ])
    us_result = MarketPipelineResult(
        market="US", regime="bear", as_of=date(2024, 1, 3), universe_df=us_universe_df,
    )

    monkeypatch.setattr(main_module, "_today_kst", lambda: date(2024, 1, 2))
    monkeypatch.setattr(main_module, "run_kr_pipeline", lambda today: kr_result)
    monkeypatch.setattr(main_module, "run_us_pipeline", lambda today: us_result)
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "_SEED_FILE", tmp_path / ".yfinance_opp_seeded")
    monkeypatch.setattr(main_module, "_SEEDED_TICKERS_FILE", tmp_path / ".yfinance_opp_seeded_tickers")
    monkeypatch.setattr(main_module.prices_us, "get_opportunity_histories", lambda *a, **k: {})

    fake_db = MagicMock()
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    main_module.main()

    assert fake_db.save_pipeline_result.call_count == 2
    first_call_result = fake_db.save_pipeline_result.call_args_list[0].args[0]
    assert first_call_result.market == "KR"
    assert first_call_result.date == "2024-01-03"
    assert first_call_result.screened_stocks[0]["ticker"] == "005930"
    assert first_call_result.screened_stocks[0]["date"] == "2024-01-03"
    assert first_call_result.price_history[0]["ticker"] == "005930"
    assert first_call_result.price_history[0]["close"] == 104.0

    # Independently verify the second call (US result)
    second_call_result = fake_db.save_pipeline_result.call_args_list[1].args[0]
    assert second_call_result.market == "US"
    assert second_call_result.regime == "bear"
    assert second_call_result.screened_stocks == []
    assert second_call_result.price_history == []
