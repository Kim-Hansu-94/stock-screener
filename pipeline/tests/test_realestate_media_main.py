from datetime import date
from unittest.mock import MagicMock

import pytest

from pipeline.src import realestate_media_main as main_module


def test_main_saves_combined_news_and_video_rows(monkeypatch):
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "date", MagicMock(today=lambda: date(2026, 9, 3)))
    monkeypatch.setattr(
        main_module, "fetch_news",
        lambda: ([{"media_type": "news", "title": "뉴스1", "url": "https://n"}], "ok"),
    )
    monkeypatch.setattr(
        main_module, "fetch_videos",
        lambda: ([{"media_type": "video", "title": "영상1", "url": "https://v"}], "ok"),
    )

    fake_db = MagicMock()
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    main_module.main()

    saved = fake_db.replace_realestate_media.call_args.args[0]
    assert saved == [
        {"media_type": "news", "title": "뉴스1", "url": "https://n", "collected_date": "2026-09-03"},
        {"media_type": "video", "title": "영상1", "url": "https://v", "collected_date": "2026-09-03"},
    ]


def test_main_exits_when_both_sources_lack_api_keys(monkeypatch):
    """두 소스 다 키가 없으면 이 실행은 아무것도 안 한 것과 같다 — 조용히 초록불로
    끝나면 '다 됐다'로 착각하기 쉬워 여기서 멈춘다."""
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "fetch_news", lambda: ([], "no_api_key"))
    monkeypatch.setattr(main_module, "fetch_videos", lambda: ([], "no_api_key"))

    fake_db = MagicMock()
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    with pytest.raises(SystemExit):
        main_module.main()

    assert not fake_db.replace_realestate_media.called


def test_main_proceeds_with_only_one_source_available(monkeypatch, capsys):
    """뉴스 API 키만 없어도 유튜브는 그대로 수집·저장한다."""
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "date", MagicMock(today=lambda: date(2026, 9, 3)))
    monkeypatch.setattr(main_module, "fetch_news", lambda: ([], "no_api_key"))
    monkeypatch.setattr(
        main_module, "fetch_videos",
        lambda: ([{"media_type": "video", "title": "영상1", "url": "https://v"}], "ok"),
    )

    fake_db = MagicMock()
    monkeypatch.setattr(main_module.ScreenerDB, "from_env", classmethod(lambda cls: fake_db))

    main_module.main()

    assert fake_db.replace_realestate_media.called
    assert "뉴스 수집 생략" in capsys.readouterr().out
