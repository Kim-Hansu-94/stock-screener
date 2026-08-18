from datetime import date
from unittest.mock import MagicMock

import pandas as pd

from pipeline.src import main as main_module
from pipeline.src.pipeline import MarketPipelineResult, ScreenedStock


def test_main_saves_kr_and_us_results(monkeypatch, tmp_path):
    # as_of는 wall-clock today(2024-01-02)와 일부러 다르게 주어, 파이프라인이
    # 실제 마지막 봉의 날짜를 그대로 전달하는지(= today로 덮어쓰지 않는지) 검증한다.
    # universe_df는 main.py가 index_membership·market_cap 컬럼을 참조하므로(KOSPI +
    # 시총 하한으로 기회 종목 필터링) production과 동일한 형태로 채운다.
    kr_universe_df = pd.DataFrame([
        {"ticker": "005930", "name": "Samsung", "sector": "Semiconductors",
         "index_membership": "KOSPI", "market_cap": 4e14},
    ])
    kr_result = MarketPipelineResult(
        market="KR", regime="bull", as_of=date(2024, 1, 3), leading_sectors=["Semiconductors"],
        screened_stocks=[ScreenedStock(ticker="005930", name="Samsung", sector="Semiconductors",
                                        close=70000.0, market_cap=4e14, rsi=45.0, as_of=date(2024, 1, 3))],
        price_history={"005930": pd.DataFrame(
            {"Open": [100], "High": [105], "Low": [99], "Close": [104], "Volume": [1000]},
            index=pd.to_datetime(["2024-01-02"]),
        )},
        universe_df=kr_universe_df,
    )
    # universe_df는 main.py가 index_membership·market_cap 컬럼을 참조하므로
    # (기회 종목/Russell 분류 + 시총 하한) production과 동일한 형태로 채워야 한다.
    us_universe_df = pd.DataFrame([
        {"ticker": "AAPL", "name": "Apple", "sector": "Technology",
         "index_membership": "S&P500", "market_cap": 3e12},
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
    monkeypatch.setattr(main_module.prices_kr, "get_kr_stock_history", lambda *a, **k: pd.DataFrame())

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


def test_opportunity_universe_excludes_stocks_below_the_market_cap_floor(monkeypatch, tmp_path):
    """종목발굴(횡보·조정)은 장기 보유 전제라 시총 하한 미만 종목을 아예 대상에서 뺀다.

    하한 미만 종목이 일봉 수집·스냅샷 계산 어느 쪽에도 들어가지 않아야 한다 —
    한쪽에만 걸리면 "일봉은 받았는데 화면엔 없는" 반쪽 상태가 된다.
    """
    kr_universe_df = pd.DataFrame([
        # 3,000억 이상 → 대상
        {"ticker": "005930", "name": "Big", "sector": "Semiconductors",
         "index_membership": "KOSPI", "market_cap": 4e14},
        # 2,000억 → 하한 미만이라 제외
        {"ticker": "111111", "name": "Small", "sector": "Semiconductors",
         "index_membership": "KOSPI", "market_cap": 2e11},
        # 시총 미확인(NaN) → 비교가 False라 제외
        {"ticker": "222222", "name": "Unknown", "sector": "Semiconductors",
         "index_membership": "KOSPI", "market_cap": float("nan")},
    ])
    kr_result = MarketPipelineResult(
        market="KR", regime="bull", as_of=date(2024, 1, 3), universe_df=kr_universe_df,
    )
    us_result = MarketPipelineResult(
        market="US", regime="bear", as_of=date(2024, 1, 3),
        universe_df=pd.DataFrame([
            {"ticker": "AAPL", "name": "Apple", "sector": "Technology",
             "index_membership": "S&P500", "market_cap": 3e12},
        ]),
    )

    monkeypatch.setattr(main_module, "_today_kst", lambda: date(2024, 1, 2))
    monkeypatch.setattr(main_module, "run_kr_pipeline", lambda today: kr_result)
    monkeypatch.setattr(main_module, "run_us_pipeline", lambda today: us_result)
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "_SEED_FILE", tmp_path / ".yfinance_opp_seeded")
    monkeypatch.setattr(main_module, "_SEEDED_TICKERS_FILE", tmp_path / ".yfinance_opp_seeded_tickers")
    monkeypatch.setattr(main_module, "_KR_SEED_FILE", tmp_path / ".kr_opp_seeded")
    monkeypatch.setattr(main_module, "_KR_SEEDED_TICKERS_FILE", tmp_path / ".kr_opp_seeded_tickers")
    monkeypatch.setattr(main_module.prices_us, "get_opportunity_histories", lambda *a, **k: {})
    monkeypatch.setattr(main_module.prices_kr, "get_kr_stock_history", lambda *a, **k: pd.DataFrame())

    seen_snapshot_tickers: dict[str, list[str]] = {}
    monkeypatch.setattr(
        main_module, "refresh_opportunity_snapshot",
        lambda db, market, rows, today: seen_snapshot_tickers.__setitem__(
            market, [r["ticker"] for r in rows]
        ),
    )
    # 실적 수집은 밴드 판정에 DB를 타므로 이 테스트에서는 통째로 비활성화한다.
    monkeypatch.setattr(main_module, "in_band_tickers", lambda *a, **k: {})
    monkeypatch.setattr(main_module, "refresh_fundamentals", lambda *a, **k: None)
    monkeypatch.setattr(main_module, "seed_long_monthly", lambda *a, **k: None)

    monkeypatch.setattr(
        main_module.ScreenerDB, "from_env", classmethod(lambda cls: MagicMock())
    )

    main_module.main()

    # 일봉 수집 대상(seed 파일에 기록되는 목록)에서 소형주가 빠졌는지
    seeded = (tmp_path / ".kr_opp_seeded_tickers").read_text()
    assert "005930" in seeded
    assert "111111" not in seeded
    assert "222222" not in seeded

    # 스냅샷 계산 대상에서도 동일하게 빠졌는지
    assert seen_snapshot_tickers["KR"] == ["005930"]
