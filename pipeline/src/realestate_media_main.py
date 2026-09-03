"""부동산 뉴스·유튜브 수집 엔트리포인트 — `python -m src.realestate_media_main`.

주식 파이프라인·부동산 실거래 수집과 모두 분리해서 매일 한 번 돈다
(.github/workflows/realestate_media.yml). 이 수집이 실패해도 나머지 파이프라인은
영향받지 않는다.
"""

from __future__ import annotations

import sys
from datetime import date

from dotenv import load_dotenv

from .db import ScreenerDB
from .realestate_media import fetch_news, fetch_videos


def main() -> None:
    # 워크플로는 시크릿을 pipeline/.env에 쓴다.
    load_dotenv()

    news_rows, news_reason = fetch_news()
    video_rows, video_reason = fetch_videos()

    if news_reason == "no_api_key" and video_reason == "no_api_key":
        # 둘 다 키가 없으면 이 실행은 아무것도 하지 않은 것과 같다. 조용히 넘기면
        # 40초 만에 초록불로 끝나 "다 됐다"로 보인다 — realestate_main.py의
        # MOLIT_API_KEY 처리와 같은 이유로 여기서 멈춘다.
        print(
            "부동산 미디어 수집 생략: NAVER_CLIENT_ID/SECRET, YOUTUBE_API_KEY 둘 다 미설정",
            flush=True,
        )
        sys.exit(1)

    if news_reason == "no_api_key":
        print("뉴스 수집 생략: NAVER_CLIENT_ID/NAVER_CLIENT_SECRET 미설정", flush=True)
    elif news_reason != "ok":
        print(f"뉴스 수집 실패: {news_reason}", flush=True)
    else:
        print(f"뉴스 {len(news_rows)}건 수집", flush=True)

    if video_reason == "no_api_key":
        print("유튜브 수집 생략: YOUTUBE_API_KEY 미설정", flush=True)
    elif video_reason != "ok":
        print(f"유튜브 수집 실패: {video_reason}", flush=True)
    else:
        print(f"유튜브 {len(video_rows)}건 수집", flush=True)

    today = date.today().isoformat()
    rows = [{**r, "collected_date": today} for r in (news_rows + video_rows)]

    db = ScreenerDB.from_env()
    db.replace_realestate_media(rows)
    print(f"  → 총 {len(rows)}건 저장", flush=True)


if __name__ == "__main__":
    main()
