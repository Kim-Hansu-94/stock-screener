"""실적 요약 수집.

횡보·조정 스크리너는 가격·거래량만 본다. 그래서 "5년째 내려오는 중인 종목"과
"바닥을 다진 종목"의 차트 모양이 같으면 구분하지 못한다. 둘을 가르는 가장
결정적인 정보는 하나다 — 주가가 빠질 때 실적도 같이 빠졌는가.

국내 종목은 dart_fundamentals.py(DART 전자공시)로 수집한다 — Yahoo가 국내
소형주 손익계산서를 잘 못 가지고 있어 계속 "데이터 없음"으로 남는 문제가 있었다.
미국 종목은 그대로 yfinance를 쓴다.

호출부(main.py)가 유니버스 전체가 아니라 조정폭 20~60% 밴드 안 종목만 넘긴다 —
stock_fundamentals는 오직 그 밴드 후보 카드(OpportunityTab)에서만 읽히므로, 밴드
밖 종목의 실적을 받아봐야 화면 어디에도 안 쓰인다. 그래도 밴드는 하루 단위로
꽤 안정적으로 유지되는 반면 그 안에서 하드필터(신저가·박스폭)를 통과해 실제
카드로 뜨는지는 매일 뒤집힐 수 있어, "오늘 뜬 카드"가 아니라 "밴드 전체"를
대상으로 미리 채워둔다 — 그래야 하드필터를 새로 통과한 날 바로 실적이 보인다.

yfinance는 종목당 요청이 필요해 전 종목을 매일 받을 수 없다. 실적은 분기에
한 번 바뀌므로, 30일이 지난 종목만 대상으로 하고 1회 실행당 상한을 둬서
여러 실행에 걸쳐 채운다(첫 주에 전체가 채워지고 이후엔 갱신분만 남는다).
"""

from __future__ import annotations

import os
from datetime import date, timedelta

import pandas as pd
import yfinance as yf

from . import dart_fundamentals
from .db import ScreenerDB

# 1회 실행당 조회 상한. 종목당 2~3초(재무제표 + info 각 1요청)라 전 종목을 한 번에
# 받으면 실행이 1시간 가까이 길어지고 Yahoo 레이트 리밋에 걸린다.
# 실패한 종목은 stale로 남아 다음 실행에서 자동 재시도된다.
MAX_PER_RUN = 400
# 중간 저장 단위. 전부 받은 뒤 한 번에 저장하면 실행이 중단될 때 그때까지의 수집분이
# 통째로 날아간다. 저장된 종목은 updated_at이 갱신돼 다음 실행에서 건너뛴다.
SAVE_CHUNK = 50
# 실적은 분기 단위로 바뀌므로 이 기간이 지난 종목만 다시 받는다.
MAX_AGE_DAYS = 30

# _stale_tickers는 "그동안 저장된 적이 있는가"로 재시도 여부를 정한다. 그런데
# corp_code_not_found(DART corpCode.xml에 그 티커의 법인코드 자체가 없음 — 우선주
# 등 DART가 별도로 등록하지 않는 종목)는 저장할 데이터가 없어 계속 못 저장되고,
# 그래서 매 실행 다시 시도된다. 실제로 20개 중 12개가 이 사유로 매번 재시도되고
# 있었다(2026-08-19 실행 로그). DART의 corpCode.xml 자체가 "이 티커는 없다"고
# 답한 확정적 사실이라 재시도해도 결과가 달라지지 않는다 — prices_us.py가 짧은
# 상장 종목을 _short_history로 기억해 두는 것과 같은 이유로, 여기도 빈 행을 남겨
# "이번 달엔 시도했다"로 표시해 둔다.
_NULL_FUNDAMENTALS = {
    "fiscal_year_latest": None, "fiscal_year_prior": None,
    "revenue_latest": None, "revenue_prior": None,
    "operating_income_latest": None, "operating_income_prior": None,
    "net_income_latest": None, "net_income_prior": None,
    "eps_latest": None, "eps_prior": None, "per": None, "pbr": None,
}

# 최신 회계연도와 몇 년 전을 비교할지. 국장(dart_fundamentals._parse_year)이 당기 vs
# 전전기, 즉 2년 간격으로 고정돼 있어 미장도 같은 간격을 쓴다.
#
# 예전에는 미장만 "가능한 한 긴 구간"(income_stmt의 가장 오래된 열, 보통 3~4년)을
# 썼다. 그런데 판정 임계값(frontend/lib/fundamentals.ts의 REVENUE_DROP 20% /
# PROFIT_DROP 30%)은 구간 길이를 보지 않고 두 시장에 똑같이 적용된다. 그래서 같은
# "실적 악화" 배지가 시장마다 다른 뜻이었다 — 2년간 -20%는 연 -10.6%인데 4년간
# -20%는 연 -5.4%라, 미국 종목이 2배 관대한 기준으로 판정됐다.
_PRIOR_YEAR_GAP = 2

_REVENUE_KEYS = ["Total Revenue", "TotalRevenue", "Operating Revenue"]
_OPERATING_KEYS = ["Operating Income", "OperatingIncome", "Total Operating Income As Reported"]
_NET_INCOME_KEYS = ["Net Income", "NetIncome", "Net Income Common Stockholders"]
_EPS_KEYS = ["Diluted EPS", "Basic EPS"]


def _yahoo_symbol(ticker: str, market: str) -> str:
    # KR 기회 종목 유니버스는 KOSPI만이라 .KS로 충분하다.
    return f"{ticker}.KS" if market == "KR" else ticker


def _pick(df: pd.DataFrame, keys: list[str], col) -> float | None:
    for key in keys:
        if key in df.index:
            value = df.loc[key, col]
            if pd.notna(value):
                return float(value)
    return None


def _why_missing(df: pd.DataFrame, keys: list[str], col) -> str:
    """값을 못 뽑은 이유를 두 갈래로 가른다 — 고칠 방법이 완전히 다르기 때문이다.

    missing: 우리가 아는 행 이름(_REVENUE_KEYS 등)이 인덱스에 하나도 없다.
             야후가 스키마를 바꾼 것이므로 실제 행 이름을 보고 폴백에 추가하면 된다.
    null:    행은 있는데 그 회계연도 값이 비어 있다(NaN). 행 이름을 아무리 봐도
             소용없고, 야후 쪽 데이터 공백이라 고칠 수단이 없다.

    예전에는 둘 다 "no_key_rows"로 뭉쳐서 로그에 행 이름만 6개 찍혔는데, 그게
    알파벳순이라 정작 궁금한 Total Revenue가 목록에 안 들어와 원인 판별이 안 됐다
    (2026-08-19 실행의 RMD 건).
    """
    present = [k for k in keys if k in df.index]
    if not present:
        return "missing"
    return "null"


def _pick_prior_column(columns, latest_col):
    """국장과 같은 2년 전 열을 고른다. 없으면 있는 것 중 가장 먼 열로 대신한다.

    yfinance income_stmt는 보통 4개 회계연도를 주므로 2년 전 열이 거의 항상 있다.
    상장이 짧아 없을 때는 비교를 통째로 포기하기보다 가장 먼 열을 쓰고, 실제 연도를
    fiscal_year_prior에 그대로 남긴다(화면이 연도를 함께 보여주므로 구간이 다르면
    사용자가 알 수 있다).
    """
    latest_year = pd.Timestamp(latest_col).year
    target_year = latest_year - _PRIOR_YEAR_GAP
    for col in columns:
        if pd.Timestamp(col).year == target_year:
            return col
    oldest = columns[-1]
    return None if oldest == latest_col else oldest


def _extract(symbol: str) -> tuple[dict | None, str]:
    """연간 손익계산서에서 최신/2년 전 실적과 밸류에이션 지표를 뽑는다.

    반환은 dart_fundamentals.extract와 같은 (데이터, 사유) 쌍. 예전에는 실패를
    전부 None으로 뭉개서 호출부가 yahoo_no_data 한 덩어리로만 셌다 — 야후가
    응답을 안 준 건지, 행 이름이 바뀐 건지 구분할 수 없어 "미장이 멀쩡한가"를
    로그로 판단할 방법이 없었다. 국장에서 겪은 것과 같은 문제라 같은 방식으로
    푼다.
    """
    ticker = yf.Ticker(symbol)
    try:
        inc = ticker.income_stmt
    except Exception as exc:  # noqa: BLE001
        return None, f"income_stmt_error_{type(exc).__name__}"
    if inc is None or inc.empty or len(inc.columns) == 0:
        return None, "no_income_statement"

    # 컬럼은 최신 회계연도부터 정렬돼 있다. 국장(DART)과 같은 2년 간격을 고른다 —
    # 자세한 이유는 _PRIOR_YEAR_GAP 주석 참고.
    latest_col = inc.columns[0]
    prior_col = _pick_prior_column(inc.columns, latest_col)

    def at(keys: list[str], col) -> float | None:
        return _pick(inc, keys, col) if col is not None else None

    per = pbr = None
    try:
        info = ticker.info or {}
        per = info.get("trailingPE")
        pbr = info.get("priceToBook")
    except Exception:  # noqa: BLE001
        pass

    result = {
        "fiscal_year_latest": int(pd.Timestamp(latest_col).year),
        "fiscal_year_prior": int(pd.Timestamp(prior_col).year) if prior_col is not None else None,
        "revenue_latest": at(_REVENUE_KEYS, latest_col),
        "revenue_prior": at(_REVENUE_KEYS, prior_col),
        "operating_income_latest": at(_OPERATING_KEYS, latest_col),
        "operating_income_prior": at(_OPERATING_KEYS, prior_col),
        "net_income_latest": at(_NET_INCOME_KEYS, latest_col),
        "net_income_prior": at(_NET_INCOME_KEYS, prior_col),
        "eps_latest": at(_EPS_KEYS, latest_col),
        "eps_prior": at(_EPS_KEYS, prior_col),
        "per": float(per) if isinstance(per, (int, float)) else None,
        "pbr": float(pbr) if isinstance(pbr, (int, float)) else None,
    }

    # 국장(dart_fundamentals._parse_year)과 같은 최소 조건 — 매출·순이익 중 하나는
    # 있어야 실적 판정이 된다. 예전에는 이 검사가 미장에만 없어서, 손익계산서는
    # 받았는데 _REVENUE_KEYS/_NET_INCOME_KEYS 중 어느 행 이름도 안 맞는 경우
    # 값이 전부 null인 행을 "성공"으로 저장했다. 화면에는 '데이터 없음'으로만
    # 뜨는데 로그의 "N개 저장"은 늘어나, 실제 커버리지가 부풀려 보였다.
    #
    # yfinance는 야후 응답을 스크레이핑하는 비공식 경로라 행 이름이 예고 없이
    # 바뀔 수 있다. 그래서 실패 시 실제 행 이름을 사유에 실어 보낸다 — 국장에서
    # 계정명을 이렇게 찍어 3라운드 만에 "당기순이익(손실)"을 찾아냈던 것과 같다.
    if result["revenue_latest"] is None and result["net_income_latest"] is None:
        rev_why = _why_missing(inc, _REVENUE_KEYS, latest_col)
        ni_why = _why_missing(inc, _NET_INCOME_KEYS, latest_col)
        detail = f"rev={rev_why},ni={ni_why}"
        # 실제 행 이름은 스키마 변경이 의심될 때만 붙인다. 값이 NaN인 경우(null)는
        # 행 이름을 봐야 아무 정보가 없고, 로그만 길어져 진짜 신호를 가린다.
        if rev_why == "missing" and ni_why == "missing":
            seen = sorted(str(i) for i in inc.index)[:6]
            if seen:
                detail += ";rows=" + ",".join(seen)
        return None, f"no_key_rows:{detail}"

    return result, "ok"


def _stale_tickers(db: ScreenerDB, market: str, tickers: list[str], today: date) -> list[str]:
    cutoff = (today - timedelta(days=MAX_AGE_DAYS)).isoformat()
    fresh: set[str] = set()
    page = 1000
    start = 0
    while True:
        result = (
            db.client.table("stock_fundamentals")
            .select("ticker, updated_at")
            .eq("market", market)
            .gte("updated_at", cutoff)
            .range(start, start + page - 1)
            .execute()
        )
        rows = result.data or []
        fresh.update(r["ticker"] for r in rows)
        if len(rows) < page:
            break
        start += page
    return [t for t in tickers if t not in fresh]


def refresh_fundamentals(
    db: ScreenerDB,
    market: str,
    tickers: list[str],
    today: date,
    *,
    ticker_to_name: dict[str, str] | None = None,
    name_to_ticker: dict[str, str] | None = None,
) -> None:
    """tickers는 유니버스 전체가 아니라 호출부가 이미 조정폭 밴드로 좁힌 목록이어야 한다.

    ticker_to_name/name_to_ticker: KR 우선주 폴백용(dart_fundamentals.extract에
    그대로 전달). 우선주는 DART corpCode.xml에 자기 종목코드가 없어 이름에서
    "우"/"N우B" 접미사를 떼어 보통주를 찾아야 한다 — main.py가 유니버스 전체
    (밴드로 좁히기 전)에서 만든 매핑을 넘긴다. US 경로는 쓰지 않는다.
    """
    # 아래 조기 return들은 예전에 아무 로그도 안 남겼다. 그래서 미장 실적 진단을
    # 넣고 실행했는데 "US 실적 수집" 줄 자체가 안 보여, 코드를 다시 읽고서야
    # pending이 비어 조용히 빠져나간 걸 알았다(2026-08-19). 건너뛴 것도 결과이므로
    # 이유를 남긴다 — 안 그러면 "진단이 안 도는 것"과 "실패가 0인 것"이 로그에서
    # 똑같아 보인다.
    if not tickers:
        print(f"{market} 실적 수집 생략: 대상 종목 없음(조정폭 밴드가 비었음)", flush=True)
        return
    if market == "KR" and not os.environ.get("DART_API_KEY"):
        # 키 미등록 상태로 400종목을 개별 시도해 전부 실패로 남기는 대신,
        # 한 줄로 원인을 밝히고 건너뛴다 — 등록되면 다음 실행부터 바로 채워진다.
        print("KR 실적 수집 생략: DART_API_KEY 미설정", flush=True)
        return
    try:
        pending = _stale_tickers(db, market, tickers, today)
    except Exception as exc:  # noqa: BLE001
        # 테이블 미생성 등으로 실패해도 파이프라인 본체는 계속 진행한다.
        print(f"{market} 실적 대상 조회 실패: {exc}", flush=True)
        return
    if not pending:
        print(
            f"{market} 실적 수집 생략: 대상 {len(tickers)}개가 모두 최근 "
            f"{MAX_AGE_DAYS}일 내 갱신됨",
            flush=True,
        )
        return

    batch = pending[:MAX_PER_RUN]
    print(f"{market} 실적 수집 ({len(batch)}/{len(pending)}개 대상)...", flush=True)

    pending_rows: list[dict] = []
    saved = 0
    failed = 0
    # 실패 사유별 개수 + 사유별 종목 예시. 예전에는 "실패 20개"라는 숫자만 남고
    # 원인이 하나도 안 보였다 — 이유가 no_api_key인지 corp_code_not_found인지
    # dart_status_013인지에 따라 고칠 곳이 완전히 다르므로, 다음에 같은 일이 생기면
    # 로그만으로 원인을 알게 한다. 예시 종목까지 남겨야 "그 티커가 왜 그런지"를
    # 바로 찾아볼 수 있다 — 개수만으로는 예를 들어 corp_code_not_found가 우선주
    # 때문인지 다른 이유인지 구분이 안 된다.
    failure_reasons: dict[str, int] = {}
    failure_examples: dict[str, list[str]] = {}

    def flush() -> None:
        """모아둔 만큼 즉시 저장. 실행이 중간에 끊겨도 여기까지는 남는다."""
        nonlocal pending_rows, saved
        if not pending_rows:
            return
        try:
            db.save_fundamentals(pending_rows)
            saved += len(pending_rows)
        except Exception as exc:  # noqa: BLE001
            print(f"  실적 저장 실패 ({len(pending_rows)}개): {exc}", flush=True)
        pending_rows = []

    for n, ticker in enumerate(batch, 1):
        reason = "ok"
        try:
            if market == "KR":
                data, reason = dart_fundamentals.extract(
                    ticker, today.year - 1,
                    name=(ticker_to_name or {}).get(ticker),
                    name_to_ticker=name_to_ticker,
                )
            else:
                data, reason = _extract(_yahoo_symbol(ticker, market))
        except Exception as exc:  # noqa: BLE001
            data, reason = None, f"exception_{type(exc).__name__}"
        if data is None:
            failed += 1
            bucket, _, detail = reason.partition(":")
            failure_reasons[bucket] = failure_reasons.get(bucket, 0) + 1
            examples = failure_examples.setdefault(bucket, [])
            if len(examples) < 8:
                examples.append(f"{ticker}[{detail}]" if detail else ticker)
            if bucket == "corp_code_not_found":
                # 다시 물어도 같은 답이 나오는 확정적 실패라, 빈 행이라도 저장해
                # 다음 30일간 재시도 대상에서 뺀다. 실제 실적 화면 표시는 null
                # 행이든 아예 없는 행이든 assessEarnings 결과가 'unknown'으로
                # 동일해 사용자에게 보이는 것은 달라지지 않는다.
                pending_rows.append(
                    {"ticker": ticker, "market": market, "updated_at": today.isoformat(),
                     **_NULL_FUNDAMENTALS}
                )
        else:
            pending_rows.append(
                {"ticker": ticker, "market": market, "updated_at": today.isoformat(), **data}
            )
        # 중간 저장 — 러너가 죽거나 취소돼도 직전 청크까지의 수집분은 보존된다.
        if n % SAVE_CHUNK == 0:
            flush()
            print(f"  진행 {n}/{len(batch)} (저장 {saved} · 실패 {failed})", flush=True)

    flush()
    reason_summary = ", ".join(
        f"{k}={v}" for k, v in sorted(failure_reasons.items(), key=lambda kv: -kv[1])
    )
    suffix = f": {reason_summary}" if reason_summary else ""
    print(f"  → {saved}개 저장 (실패 {failed}개{suffix})", flush=True)
    for reason, tickers_seen in sorted(failure_examples.items(), key=lambda kv: -len(kv[1])):
        print(f"    {reason} 예: {', '.join(tickers_seen)}", flush=True)
