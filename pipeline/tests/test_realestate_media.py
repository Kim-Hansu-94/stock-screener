import pytest

from pipeline.src import realestate_media


def _fake_news_response(monkeypatch, items, status=200):
    class Resp:
        status_code = status

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def json(self):
            return {"items": items}

    def _get(*_a, **_k):
        return Resp()

    monkeypatch.setattr(realestate_media.requests, "get", _get)


def _fake_video_response(monkeypatch, items, status=200):
    class Resp:
        status_code = status

        def raise_for_status(self):
            if self.status_code >= 400:
                raise RuntimeError(f"HTTP {self.status_code}")

        def json(self):
            return {"items": items}

    def _get(*_a, **_k):
        return Resp()

    monkeypatch.setattr(realestate_media.requests, "get", _get)


def test_fetch_news_returns_no_api_key_reason_when_unset(monkeypatch):
    monkeypatch.delenv("NAVER_CLIENT_ID", raising=False)
    monkeypatch.delenv("NAVER_CLIENT_SECRET", raising=False)

    rows, reason = realestate_media.fetch_news()

    assert rows == []
    assert reason == "no_api_key"


def test_fetch_news_strips_html_tags_and_picks_originallink(monkeypatch):
    monkeypatch.setenv("NAVER_CLIENT_ID", "id")
    monkeypatch.setenv("NAVER_CLIENT_SECRET", "secret")
    _fake_news_response(monkeypatch, [
        {
            "title": "<b>부동산</b> 시장 동향",
            "originallink": "https://www.hankyung.com/article/1",
            "link": "https://news.naver.com/article/1",
            "pubDate": "Wed, 03 Sep 2026 09:00:00 +0900",
        },
    ])

    rows, reason = realestate_media.fetch_news()

    assert reason == "ok"
    assert rows == [{
        "media_type": "news",
        "title": "부동산 시장 동향",
        "url": "https://www.hankyung.com/article/1",
        "source": "hankyung.com",
        "thumbnail_url": None,
        "published_at": "2026-09-03T09:00:00+09:00",
    }]


def test_fetch_news_falls_back_to_naver_link_when_no_originallink(monkeypatch):
    monkeypatch.setenv("NAVER_CLIENT_ID", "id")
    monkeypatch.setenv("NAVER_CLIENT_SECRET", "secret")
    _fake_news_response(monkeypatch, [
        {"title": "제목", "originallink": "", "link": "https://news.naver.com/article/2", "pubDate": None},
    ])

    rows, reason = realestate_media.fetch_news()

    assert rows[0]["url"] == "https://news.naver.com/article/2"
    assert rows[0]["published_at"] is None


def test_fetch_news_drops_items_without_a_usable_url(monkeypatch):
    monkeypatch.setenv("NAVER_CLIENT_ID", "id")
    monkeypatch.setenv("NAVER_CLIENT_SECRET", "secret")
    _fake_news_response(monkeypatch, [
        {"title": "링크 없음", "originallink": "", "link": "", "pubDate": None},
    ])

    rows, reason = realestate_media.fetch_news()

    assert rows == []
    assert reason == "ok"


def test_fetch_news_calls_naver_api_hub_with_the_ncp_headers(monkeypatch):
    """구 개발자센터(openapi.naver.com)는 신규 발급이 막혀 NAVER API HUB로
    이관됐다 — 엔드포인트와 인증 헤더 이름이 X-Naver-Client-Id/Secret에서
    X-NCP-APIGW-API-KEY-ID/KEY로 바뀌었다. 옛 이름으로 되돌아가면 401로
    조용히 실패하므로(요청 자체는 나가서 http_error가 아니라 응답 처리
    단계에서 걸림) 여기서 고정해 둔다."""
    monkeypatch.setenv("NAVER_CLIENT_ID", "id")
    monkeypatch.setenv("NAVER_CLIENT_SECRET", "secret")

    calls = []

    class Resp:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"items": []}

    def _get(url, params=None, headers=None, timeout=None):
        calls.append({"url": url, "headers": headers})
        return Resp()

    monkeypatch.setattr(realestate_media.requests, "get", _get)

    realestate_media.fetch_news()

    assert calls[0]["url"] == "https://naverapihub.apigw.ntruss.com/search/v1/news"
    assert calls[0]["headers"] == {
        "X-NCP-APIGW-API-KEY-ID": "id",
        "X-NCP-APIGW-API-KEY": "secret",
    }


def test_fetch_news_reports_http_errors(monkeypatch):
    monkeypatch.setenv("NAVER_CLIENT_ID", "id")
    monkeypatch.setenv("NAVER_CLIENT_SECRET", "secret")

    def _raise(*_a, **_k):
        raise ConnectionError("boom")

    monkeypatch.setattr(realestate_media.requests, "get", _raise)

    rows, reason = realestate_media.fetch_news()

    assert rows == []
    assert reason == "http_error_ConnectionError"


def test_fetch_videos_returns_no_api_key_reason_when_unset(monkeypatch):
    monkeypatch.delenv("YOUTUBE_API_KEY", raising=False)

    rows, reason = realestate_media.fetch_videos()

    assert rows == []
    assert reason == "no_api_key"


def test_fetch_videos_extracts_thumbnail_and_channel(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "key")
    _fake_video_response(monkeypatch, [
        {
            "id": {"videoId": "abc123"},
            "snippet": {
                "title": "요즘 부동산 시장 총정리",
                "channelTitle": "부동산 채널",
                "publishedAt": "2026-09-01T00:00:00Z",
                "thumbnails": {"medium": {"url": "https://img.youtube.com/vi/abc123/mqdefault.jpg"}},
            },
        },
    ])

    rows, reason = realestate_media.fetch_videos()

    assert reason == "ok"
    assert rows == [{
        "media_type": "video",
        "title": "요즘 부동산 시장 총정리",
        "url": "https://www.youtube.com/watch?v=abc123",
        "source": "부동산 채널",
        "thumbnail_url": "https://img.youtube.com/vi/abc123/mqdefault.jpg",
        "published_at": "2026-09-01T00:00:00Z",
    }]


def test_fetch_videos_skips_items_without_video_id(monkeypatch):
    monkeypatch.setenv("YOUTUBE_API_KEY", "key")
    _fake_video_response(monkeypatch, [
        {"id": {}, "snippet": {"title": "채널 결과(비디오 아님)"}},
    ])

    rows, reason = realestate_media.fetch_videos()

    assert rows == []
    assert reason == "ok"
