from datetime import date
from unittest.mock import MagicMock

from pipeline.src import us_financial_health_main as main_module


def test_main_scopes_to_in_band_universe_tickers(monkeypatch):
    """유니버스 전체가 아니라 조정폭 밴드 안 종목만 refresh_financial_health로
    넘겨야 한다 — stock_fundamentals는 그 밴드 카드에서만 읽힌다."""
    monkeypatch.setattr(main_module, "_today_kst", lambda: date(2024, 1, 2))
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)

    fake_db = MagicMock()
    fake_db.get_universe_tickers.return_value = ["AAPL", "MSFT", "OUT_OF_BAND"]
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    monkeypatch.setattr(
        main_module, "in_band_tickers",
        lambda db, market, tickers, today: {"AAPL": {}, "MSFT": {}},
    )

    seen = {}
    monkeypatch.setattr(
        main_module, "refresh_financial_health",
        lambda db, tickers, today: seen.update(tickers=sorted(tickers), today=today),
    )

    main_module.main()

    fake_db.get_universe_tickers.assert_called_once_with(
        "US", ["NASDAQ100", "S&P500"], main_module.US_MIN_MARKET_CAP,
    )
    assert seen == {"tickers": ["AAPL", "MSFT"], "today": date(2024, 1, 2)}


def test_main_skips_when_universe_is_empty(monkeypatch, capsys):
    """stock_universe가 비어 있으면(본 파이프라인이 아직 안 돌았거나 실패) 조용히
    넘어가지 않고 이유를 남긴다."""
    monkeypatch.setattr(main_module, "_today_kst", lambda: date(2024, 1, 2))
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)

    fake_db = MagicMock()
    fake_db.get_universe_tickers.return_value = []
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    called = []
    monkeypatch.setattr(
        main_module, "refresh_financial_health",
        lambda *a, **k: called.append(True),
    )

    main_module.main()

    assert called == []
    assert "US 재무건전성 수집 생략" in capsys.readouterr().out
