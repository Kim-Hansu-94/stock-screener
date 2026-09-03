"""부동산 관련 뉴스·유튜브 링크 수집 — 네이버 뉴스검색 API + YouTube Data API.

주식 파이프라인·부동산 실거래 수집과 모두 분리해서 돈다
(.github/workflows/realestate_media.yml). 둘 중 하나가 실패해도 나머지 하나는
그대로 저장한다 — 뉴스 API가 막혀도 유튜브는 보여줄 수 있어야 하고, 그 반대도
마찬가지다.

두 API 다 키가 선택적이다: 하나만 등록돼 있으면 그 소스만 채우고, 둘 다 없으면
호출부(realestate_media_main.py)가 명확히 실패로 끝낸다(조용히 초록불로 끝나면
"다 됐다"로 착각하기 쉽다 — realestate.py의 MOLIT_API_KEY 처리와 같은 이유).

뉴스 검색은 2026-09 기준 구 개발자센터(openapi.naver.com)의 신규 발급이 막혀
NAVER API HUB(네이버클라우드플랫폼이 중개 운영)로 이관됐다 — 엔드포인트와 인증
헤더 이름만 바뀌었을 뿐(X-Naver-Client-Id/Secret → X-NCP-APIGW-API-KEY-ID/KEY),
요청 파라미터·응답 스키마는 기존과 동일하다. Client ID/Secret은 HUB 콘솔에서
"애플리케이션 등록" 후 "API 키 발급"으로 받는다 — 계정 전체의 IAM
Access Key/Secret Key(ncp_iam_...)와는 다른 값이니 혼동하지 말 것.
"""

from __future__ import annotations

import html
import os
import re

import requests

_NAVER_NEWS_URL = "https://naverapihub.apigw.ntruss.com/search/v1/news"
_YOUTUBE_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_TIMEOUT = 15

# 홈 화면 상단에 너무 많이 나열되지 않도록 소스별 상한.
NEWS_DISPLAY = 20
VIDEO_MAX_RESULTS = 12

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_tags(text: str) -> str:
    """네이버 뉴스검색 응답은 검색어 강조를 위해 <b> 태그와 HTML 엔티티가 섞여 온다."""
    return html.unescape(_TAG_RE.sub("", text)).strip()


def fetch_news(query: str = "부동산", display: int = NEWS_DISPLAY) -> tuple[list[dict], str]:
    """네이버 뉴스검색 API(NAVER API HUB). 반환은 (행 목록, 실패 사유) — 사유는 성공 시 "ok"."""
    client_id = os.environ.get("NAVER_CLIENT_ID")
    client_secret = os.environ.get("NAVER_CLIENT_SECRET")
    if not client_id or not client_secret:
        return [], "no_api_key"

    try:
        resp = requests.get(
            _NAVER_NEWS_URL,
            params={"query": query, "display": display, "sort": "date"},
            headers={
                "X-NCP-APIGW-API-KEY-ID": client_id,
                "X-NCP-APIGW-API-KEY": client_secret,
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        items = resp.json().get("items") or []
    except Exception as exc:  # noqa: BLE001
        return [], f"http_error_{type(exc).__name__}"

    rows = [
        {
            "media_type": "news",
            "title": _strip_tags(item.get("title", "")),
            # originallink가 비어 있는 경우(언론사가 원문을 안 주는 경우)가 있어
            # 네이버 뉴스 링크(link)로 폴백한다 — 둘 다 없으면 그 항목은 버린다.
            "url": item.get("originallink") or item.get("link") or "",
            "source": _news_source(item.get("originallink") or item.get("link") or ""),
            "thumbnail_url": None,
            "published_at": _parse_rfc822(item.get("pubDate")),
        }
        for item in items
    ]
    return [r for r in rows if r["url"] and r["title"]], "ok"


def _news_source(url: str) -> str | None:
    """언론사명을 API가 안 주므로 도메인에서 대략 뽑는다(예: news.naver.com)."""
    m = re.search(r"https?://(?:www\.|news\.)?([^/]+)", url)
    return m.group(1) if m else None


def _parse_rfc822(pub_date: str | None) -> str | None:
    """네이버는 RFC822 형식(예: 'Wed, 03 Sep 2026 09:00:00 +0900')을 준다."""
    if not pub_date:
        return None
    try:
        from email.utils import parsedate_to_datetime

        return parsedate_to_datetime(pub_date).isoformat()
    except (TypeError, ValueError):
        return None


def fetch_videos(query: str = "부동산", max_results: int = VIDEO_MAX_RESULTS) -> tuple[list[dict], str]:
    """YouTube Data API v3 search.list. 반환은 (행 목록, 실패 사유)."""
    api_key = os.environ.get("YOUTUBE_API_KEY")
    if not api_key:
        return [], "no_api_key"

    try:
        resp = requests.get(
            _YOUTUBE_SEARCH_URL,
            params={
                "key": api_key,
                "q": query,
                "part": "snippet",
                "type": "video",
                "order": "relevance",
                # 최근 7일 이내 업로드만 — "요즘 이슈되는" 취지에 맞게 오래된
                # 영상이 relevance만으로 계속 상위에 남는 걸 막는다.
                "publishedAfter": _seven_days_ago_iso(),
                "maxResults": max_results,
                "regionCode": "KR",
                "relevanceLanguage": "ko",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        items = resp.json().get("items") or []
    except Exception as exc:  # noqa: BLE001
        return [], f"http_error_{type(exc).__name__}"

    rows = []
    for item in items:
        video_id = (item.get("id") or {}).get("videoId")
        snippet = item.get("snippet") or {}
        if not video_id:
            continue
        thumbnails = snippet.get("thumbnails") or {}
        thumb = (thumbnails.get("medium") or thumbnails.get("default") or {}).get("url")
        rows.append({
            "media_type": "video",
            "title": html.unescape(snippet.get("title", "")),
            "url": f"https://www.youtube.com/watch?v={video_id}",
            "source": snippet.get("channelTitle"),
            "thumbnail_url": thumb,
            "published_at": snippet.get("publishedAt"),
        })
    return rows, "ok"


def _seven_days_ago_iso() -> str:
    from datetime import datetime, timedelta, timezone

    return (datetime.now(timezone.utc) - timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
