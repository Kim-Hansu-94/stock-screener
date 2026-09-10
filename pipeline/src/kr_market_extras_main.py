"""국내 시장 부가 데이터 3종 수집 — 수급 · 목표주가 컨센서스 · 자사주 매입.

**본 파이프라인(main.py)과 분리된 별도 워크플로**다
(`.github/workflows/kr_market_extras.yml`). 부동산·US 재무건전성과 같은 이유다 —
여기가 실패했다고 매일 도는 스크리닝이 죽으면 안 되고, 셋 다 갱신 주기가 다르다.

**대상 종목을 유니버스 전체로 잡지 않는다.** 코스피 전 종목이면 종목당 3~4회
요청이 수천 건이 되는데, 정작 화면에 뜨지 않는 종목이 대부분이다. 그래서 실제로
사이트에 보이는 국내 종목만 모은다:

  - 감시·보유 종목 (`watchlist_tickers`)
  - 최근 눌림목 스크리닝에 걸린 종목 (`screened_stocks`)
  - 횡보·조정 후보 (`opportunity_snapshot`)

수급은 매일 의미가 바뀌므로 매 실행 갱신하고, 컨센서스·자사주는 며칠에 한 번
바뀌는 정보라 실행당 상한을 둬 나눠 받는다(fundamentals.py의 30일 주기와 같은
발상 — 한 번에 다 받으려다 레이트리밋에 걸리는 것보다 낫다).
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from dotenv import load_dotenv

from . import broker_flow as broker_mod
from . import buyback as buyback_mod
from . import consensus as consensus_mod
from . import investor_flow as flow_mod
from .db import ScreenerDB

KST = timezone(timedelta(hours=9))

# 수급은 종목당 요청 3회(3페이지)라 대상이 많으면 그대로 시간이 된다.
MAX_FLOW_TICKERS = 60
# 컨센서스·자사주는 하루에 다 받을 필요가 없다 — 실행마다 앞에서부터 이만큼씩.
MAX_CONSENSUS_TICKERS = 40
MAX_BUYBACK_TICKERS = 40
# 거래원은 자사주 프로그램이 진행 중인 종목만 본다 — 전 종목을 훑을 이유가 없다.
MAX_BROKER_TICKERS = 30

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


def run_buyback(db: ScreenerDB, targets: list[tuple[str, str]]) -> None:
    picked = targets[:MAX_BUYBACK_TICKERS]
    print(f"자사주 매입 수집 ({len(picked)}개 대상)...", flush=True)

    try:
        corp_codes = buyback_mod.load_corp_codes()
    except Exception as exc:  # noqa: BLE001
        # DART_API_KEY가 없으면 여기서 끝난다 — 수급·컨센서스는 이미 저장됐다.
        print(f"  자사주 수집 생략: {exc}", flush=True)
        return

    closes = _latest_closes(db)
    rows: list[dict] = []
    no_program = 0
    failures: list[str] = []
    for ticker, name in picked:
        corp_code = corp_codes.get(ticker)
        if not corp_code:
            failures.append(f"{ticker}: corp_code 없음")
            continue
        try:
            row = buyback_mod.build_row(ticker, name, corp_code)
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{ticker}: {exc}")
            continue
        if row is None:
            no_program += 1
            continue
        rows.append(row)

    # 자사주 프로그램이 잡힌 종목만 거래원을 받는다. 여기서 오늘치를 먼저 저장한
    # 다음 누적을 다시 읽어야, 오늘 거래분이 추정 진행률에 바로 반영된다.
    #
    # 거래원은 **자사주보다 나중에 추가된 기능**이라 broker_trading 표가 아직 없을 수
    # 있다(마이그레이션 전). 그 경우에도 자사주 본체는 저장돼야 하므로 따로 감싼다 —
    # 안 그러면 부가 기능 하나 때문에 이미 받아 둔 공시 정보가 통째로 날아간다.
    try:
        _collect_broker_trading(db, rows, closes)
        _attach_estimated_progress(db, rows)
    except Exception as exc:  # noqa: BLE001
        print(f"  거래원 수집 실패(자사주 본체는 계속 저장): {exc}", flush=True)
        # 추정 열이 스키마에 없으면 upsert 자체가 깨진다. 붙였던 값을 도로 뗀다.
        for row in rows:
            for key in ("estimated_qty", "estimated_amount", "estimated_progress_pct", "observed_days"):
                row.pop(key, None)

    db.save_buyback(rows)
    # 이번에 실제로 조회한 종목 중 공시가 있는 것만 남긴다. 조회 자체를 안 한
    # 종목(상한에 걸려 이번 실행에서 빠진 종목)까지 지우면 안 되므로, 지울 대상을
    # picked 안으로 한정할 수 있도록 keep에 "이번에 본 종목 전체"를 넘긴다.
    looked_at = {t for t, _ in picked}
    keep = [r["ticker"] for r in rows] + [
        t for t in _existing_buyback_tickers(db) if t not in looked_at
    ]
    db.prune_buyback(keep)

    print(f"  → {len(rows)}개 저장, 자사주 공시 없음 {no_program}개, 실패 {len(failures)}건", flush=True)
    if failures:
        print(f"  사유 예: {'; '.join(failures[:3])}", flush=True)


def _collect_broker_trading(db: ScreenerDB, buyback_rows: list[dict], closes: dict[str, float]) -> None:
    """자사주 프로그램이 잡힌 종목의 오늘자 거래원(상위 5개 창구)을 저장한다.

    네이버가 그날 상위 5개만 주므로 **과거 소급이 안 된다** — 매일 쌓는 수밖에 없다.
    그래서 여기가 실패하면 그날치가 영영 빈다. 실패 사유를 반드시 남긴다.
    """
    picked = buyback_rows[:MAX_BROKER_TICKERS]
    if not picked:
        return
    today = _today_kst()
    print(f"  거래원 수집 ({len(picked)}개 종목)...", flush=True)

    rows: list[dict] = []
    failures: list[str] = []
    for entry in picked:
        ticker = entry["ticker"]
        try:
            rows.extend(
                broker_mod.build_rows(ticker, entry.get("name") or ticker, today, closes.get(ticker))
            )
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{ticker}: {exc}")

    db.save_broker_trading(rows)
    print(f"    → {len(rows)}행 저장, 실패 {len(failures)}건", flush=True)
    if failures:
        print(f"    사유 예: {'; '.join(failures[:3])}", flush=True)


def _attach_estimated_progress(db: ScreenerDB, buyback_rows: list[dict]) -> None:
    """위탁증권사 창구의 누적 순매수로 추정 진행률을 채운다.

    확정 진행률(`amount_progress_pct`, 결과보고서 기반)과 **따로** 채운다 —
    합치면 화면에서 어느 근거인지 알 수 없게 된다.
    """
    for entry in buyback_rows:
        broker = entry.get("broker")
        if not broker:
            continue
        history = db.get_broker_trading(entry["ticker"], entry.get("period_start"))
        estimate = broker_mod.estimate_buyback_progress(
            history, broker, entry.get("period_start"), entry.get("planned_amount")
        )
        entry.update(estimate)


def _latest_closes(db: ScreenerDB) -> dict[str, float]:
    """거래원 금액 환산용 최신 종가. 없으면 그 종목만 금액이 빈다."""
    closes: dict[str, float] = {}
    try:
        resp = (
            db.client.table("investor_flow")
            .select("ticker, close, date")
            .eq("market", "KR")
            .order("date", desc=True)
            .limit(1000)
            .execute()
        )
        for row in resp.data or []:
            closes.setdefault(row["ticker"], float(row["close"]))
    except Exception as exc:  # noqa: BLE001
        print(f"  종가 조회 실패(거래원 금액은 비워 둠): {exc}", flush=True)
    return closes


def _existing_buyback_tickers(db: ScreenerDB) -> list[str]:
    try:
        resp = db.client.table("stock_buyback").select("ticker").eq("market", "KR").execute()
    except Exception:  # noqa: BLE001
        return []
    return [r["ticker"] for r in (resp.data or [])]


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

    # 셋 중 하나가 죽어도 나머지는 저장되게 따로 감싼다 — 수급이 막혔다고
    # 컨센서스까지 못 받을 이유가 없다.
    for label, fn in (
        ("수급", run_investor_flow),
        ("컨센서스", run_consensus),
        ("자사주", run_buyback),
    ):
        try:
            fn(db, targets)
        except Exception as exc:  # noqa: BLE001
            print(f"{label} 수집 실패(나머지는 계속): {exc}", flush=True)

    print("국내 부가 데이터 수집 완료", flush=True)


if __name__ == "__main__":
    main()
