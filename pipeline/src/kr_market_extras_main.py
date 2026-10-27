"""국내 시장 부가 데이터 2종 수집 — 수급 · 목표주가 컨센서스.

**자사주 매입 추적은 2026-10-27에 통째로 걷어냈다 (사용자 요청).** 이 기능은
SK하이닉스의 40조원 자사주 프로그램을 따라가려고 만든 것인데, DART 최신 공시가
2026-10-26에 `자기주식취득결과보고서`로 바뀌었다 — 결과보고서는 프로그램이
**끝난 뒤** 나오는 서류다(삼성전자도 10-12에 같은 상태). 지켜볼 대상이 없어진
화면을 남겨두면 끝난 프로그램의 진행률만 계속 보여주게 된다. 되살릴 일이 생기면
git 이력에 `buyback.py`·`broker_flow.py`·`trstk.py`가 그대로 남아 있다.

**본 파이프라인(main.py)과 분리된 별도 워크플로**다
(`.github/workflows/kr_market_extras.yml`). 부동산·US 재무건전성과 같은 이유다 —
여기가 실패했다고 매일 도는 스크리닝이 죽으면 안 되고, 셋 다 갱신 주기가 다르다.

**대상 종목을 유니버스 전체로 잡지 않는다.** 코스피 전 종목이면 종목당 3~4회
요청이 수천 건이 되는데, 정작 화면에 뜨지 않는 종목이 대부분이다. 그래서 실제로
사이트에 보이는 국내 종목만 모은다:

  - 감시·보유 종목 (`watchlist_tickers`)
  - 최근 눌림목 스크리닝에 걸린 종목 (`screened_stocks`)
  - 횡보·조정 후보 (`opportunity_snapshot`)

수급은 매일 의미가 바뀌므로 매 실행 갱신하고, 컨센서스는 며칠에 한 번 바뀌는
정보라 실행당 상한을 둬 나눠 받는다(fundamentals.py의 30일 주기와 같은 발상 —
한 번에 다 받으려다 레이트리밋에 걸리는 것보다 낫다).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from . import consensus as consensus_mod
from . import investor_flow as flow_mod
from .db import ScreenerDB

KST = timezone(timedelta(hours=9))

# 수급은 종목당 요청 3회(3페이지)라 대상이 많으면 그대로 시간이 된다.
MAX_FLOW_TICKERS = 60
# 컨센서스는 하루에 다 받을 필요가 없다 — 실행마다 앞에서부터 이만큼씩.
MAX_CONSENSUS_TICKERS = 40

FLOW_DAYS = 60


def _today_kst() -> date:
    return datetime.now(KST).date()


def _target_tickers(db: ScreenerDB) -> list[tuple[str, str]]:
    """(ticker, name) 목록. 화면에 실제로 뜨는 국내 종목만."""
    seen: dict[str, str] = {}

    # 1) 감시·보유 종목 — 사용자가 직접 등록한 것이라 가장 우선한다.
    for ticker, market, name in db.get_watchlist_tickers():
        if market == "KR":
            seen.setdefault(ticker, name or ticker)

    # 2) 최근 스크리닝에 걸린 종목
    try:
        for ticker in db.get_recently_screened_tickers("KR"):
            seen.setdefault(ticker, ticker)
    except Exception as exc:  # noqa: BLE001
        print(f"  최근 스크리닝 종목 조회 실패(계속 진행): {exc}", flush=True)

    # 3) 횡보·조정 후보
    try:
        resp = (
            db.client.table("opportunity_snapshot")
            .select("ticker, name")
            .eq("market", "KR")
            .limit(200)
            .execute()
        )
        for row in resp.data or []:
            seen.setdefault(row["ticker"], row.get("name") or row["ticker"])
    except Exception as exc:  # noqa: BLE001
        print(f"  횡보·조정 후보 조회 실패(계속 진행): {exc}", flush=True)

    return list(seen.items())


def run_investor_flow(db: ScreenerDB, targets: list[tuple[str, str]]) -> None:
    picked = targets[:MAX_FLOW_TICKERS]
    print(f"수급 수집 ({len(picked)}개 대상)...", flush=True)

    rows: list[dict] = []
    failures: list[str] = []
    source_used: set[str] = set()
    for ticker, name in picked:
        try:
            got = flow_mod.build_rows(ticker, name, days=FLOW_DAYS)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{ticker}: {exc}")
            continue
        rows.extend(got)
        if got:
            source_used.add(str(got[0].get("source")))

    db.save_investor_flow(rows)
    print(f"  → {len(rows)}행 저장 (소스: {', '.join(sorted(source_used)) or '없음'})", flush=True)
    if failures:
        # 앞 3건만 남긴다 — 전부 찍으면 로그가 실패로 뒤덮여 정작 성공 요약이 안 보인다.
        print(f"  실패 {len(failures)}건: {'; '.join(failures[:3])}", flush=True)


def run_consensus(db: ScreenerDB, targets: list[tuple[str, str]]) -> None:
    picked = targets[:MAX_CONSENSUS_TICKERS]
    as_of = _today_kst().isoformat()
    print(f"목표주가 컨센서스 수집 ({len(picked)}개 대상)...", flush=True)

    # 상승여력 계산용 종가. 없으면 그 종목만 upside_pct가 빈다.
    closes: dict[str, float] = {}
    try:
        resp = (
            db.client.table("screened_stocks")
            .select("ticker, close, date")
            .eq("market", "KR")
            .order("date", desc=True)
            .limit(500)
            .execute()
        )
        for row in resp.data or []:
            closes.setdefault(row["ticker"], float(row["close"]))
    except Exception as exc:  # noqa: BLE001
        print(f"  종가 조회 실패(상승여력은 비워 둠): {exc}", flush=True)

    rows: list[dict] = []
    failures: list[str] = []
    for ticker, name in picked:
        try:
            rows.append(consensus_mod.build_row(ticker, name, as_of, closes.get(ticker)))
        except Exception as exc:  # noqa: BLE001
            # 커버하는 증권사가 없는 소형주는 목표가 자체가 없다 — 정상이다.
            failures.append(f"{ticker}: {exc}")

    db.save_consensus(rows)
    print(f"  → {len(rows)}개 저장, {len(failures)}개 없음/실패", flush=True)
    if failures:
        print(f"  사유 예: {'; '.join(failures[:3])}", flush=True)


def main() -> None:
    load_dotenv()
    db = ScreenerDB.from_env()

    targets = _target_tickers(db)
    if not targets:
        print(
            "국내 부가 데이터 수집 생략: 대상 종목이 없음 "
            "(본 파이프라인이 아직 안 돌았을 수 있음)",
            flush=True,
        )
        return
    print(f"대상 국내 종목 {len(targets)}개", flush=True)

    # 둘 중 하나가 죽어도 나머지는 저장되게 따로 감싼다 — 수급이 막혔다고
    # 컨센서스까지 못 받을 이유가 없다.
    for label, fn in (
        ("수급", run_investor_flow),
        ("컨센서스", run_consensus),
    ):
        try:
            fn(db, targets)
        except Exception as exc:  # noqa: BLE001
            print(f"{label} 수집 실패(나머지는 계속): {exc}", flush=True)

    print("국내 부가 데이터 수집 완료", flush=True)


if __name__ == "__main__":
    main()
