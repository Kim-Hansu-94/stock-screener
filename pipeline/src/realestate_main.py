"""부동산 수집 엔트리포인트 — `python -m src.realestate_main [--months N]`.

주식 파이프라인(main.py)과 분리해서 돌린다. 실거래는 신고 기한이 30일이라
매일 볼 이유가 없고, 부동산 수집이 실패했다고 주식 스크리닝이 죽으면 안 된다.

기본은 최근 3개월만 다시 훑는다. 실거래 신고가 최대 30일까지 늦게 들어오므로
지난달·지지난달 수치가 나중에 바뀐다 — 한 번 넣고 끝내면 최근 달이 영원히
과소집계된 채로 남는다. 첫 실행처럼 과거를 채우려면 --months로 늘린다.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date

from dotenv import load_dotenv

from .db import ScreenerDB
from .lawd_codes import CAPITAL_AREA
from .realestate import collect

_DEFAULT_MONTHS = 3


def recent_months(today: date, count: int) -> list[tuple[int, int]]:
    """오늘이 속한 달부터 과거로 count개월."""
    out: list[tuple[int, int]] = []
    year, month = today.year, today.month
    for _ in range(count):
        out.append((year, month))
        month -= 1
        if month == 0:
            year, month = year - 1, 12
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--months", type=int, default=_DEFAULT_MONTHS)
    args = parser.parse_args()

    # 워크플로는 시크릿을 pipeline/.env에 쓴다. main.py처럼 여기서도 읽어야
    # os.getenv가 값을 본다 — 이걸 빼먹어서 첫 두 실행이 "키 미설정"으로 건너뛰었다.
    load_dotenv()

    # collect()는 라이브러리로서 키가 없으면 조용히 건너뛴다(그 동작에 테스트가 걸려
    # 있다). 하지만 엔트리포인트까지 조용하면 실행이 초록불로 끝나 "다 됐다"로 보인다.
    # 여기서 멈춰서 그 착시를 막는다.
    if not os.getenv("MOLIT_API_KEY"):
        print("MOLIT_API_KEY를 읽지 못했습니다 (pipeline/.env 또는 환경변수 확인)", flush=True)
        sys.exit(1)

    months = recent_months(date.today(), args.months)
    print(f"부동산 실거래 수집 — 수도권 {len(CAPITAL_AREA)}개 지역 × {len(months)}개월", flush=True)

    rows, diag = collect(CAPITAL_AREA, months)
    if not rows:
        print("  저장할 데이터 없음", flush=True)
        _report(diag)
        # 한 건도 못 받았으면 실패다. 초록불로 끝나면 로그를 열어보기 전까지
        # 정상 수집과 구분이 안 된다.
        sys.exit(1)

    ScreenerDB().save_realestate_monthly(rows)
    print(f"  → {len(rows)}행 저장", flush=True)
    _report(diag)


def _report(diag: dict[str, list[str]]) -> None:
    if diag.get("aborted"):
        print("  연속 실패가 이어져 조기 중단했습니다 — 아래 사유가 전 지역 공통입니다.", flush=True)

    # 지역코드가 틀리면 API가 에러가 아니라 빈 결과를 준다. 조용히 비는 걸 막으려고
    # 반드시 남긴다 — 이 목록이 lawd_codes.py를 고치는 근거다.
    empty = diag.get("empty") or []
    if empty:
        print(f"  ⚠️ 전 기간 0건인 지역 {len(empty)}개 (지역코드 확인 필요): {', '.join(empty[:15])}", flush=True)

    errors = diag.get("error") or []
    if errors:
        print(f"  호출 실패 {len(errors)}건 (예: {errors[0]})", flush=True)


if __name__ == "__main__":
    main()
