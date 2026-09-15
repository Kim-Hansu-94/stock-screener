"""시황 지수 스냅샷 전용 엔트리포인트 — `python -m src.market_indices_main`.

본 파이프라인(`main.py`)도 매 실행마다 같은 수집을 하지만, 그쪽은 하루 두 번뿐이고
한 번에 50분 넘게 걸린다. 지수 6개를 받는 건 수십 초짜리 작업이라, **같은 수집만
4시간마다 따로 돌린다**(.github/workflows/market_indices.yml).

왜 4시간인가 (2026-09-15, 사용자 요청):
  미국장은 한국시간 22:30~05:00에 열리는데 본 파이프라인은 06:30·16:30 KST에만 돌아
  **둘 다 미국장이 닫혀 있는 시각**이었다. 그래서 미국 10년물 금리가 화면에 늘 직전
  거래일 종가로 떠 있었고, 장중 뉴스에 나오는 숫자와 어긋났다. 4시간마다 돌면 미국장이
  열려 있는 동안에도 값이 들어온다.

  그 값은 아직 안 끝난 봉이라 "종가"가 아니다. 확정인지 장중인지는 화면이
  `frontend/lib/usMarketSession.ts`에서 date와 updated_at으로 판정해 표시한다.

테이블은 지수당 1행 upsert라(`save_market_index_snapshots`) 본 파이프라인과 동시에
돌아도 서로 덮어쓸 뿐 깨지지 않는다.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from .db import ScreenerDB
from .market_indices import collect_market_index_snapshots

KST = timezone(timedelta(hours=9))


def main() -> None:
    # 워크플로는 시크릿을 pipeline/.env에 쓴다.
    load_dotenv()

    today: date = datetime.now(KST).date()
    db = ScreenerDB.from_env()

    print("시황 지수 스냅샷 수집 중...", flush=True)
    snapshots = collect_market_index_snapshots(today)
    if not snapshots:
        # 한 개도 못 받았으면 소스가 통째로 막힌 것이다. 조용히 초록불로 끝내면
        # "4시간마다 갱신되고 있다"고 믿게 되므로 실패로 끝낸다.
        print("지수를 하나도 받지 못했습니다 — 소스가 막혔는지 확인할 것", flush=True)
        sys.exit(1)

    db.save_market_index_snapshots(snapshots)
    print(f"  → {len(snapshots)}개 저장", flush=True)


if __name__ == "__main__":
    main()
