"""
S&P 1500 (S&P 500 + 400 + 600) + NASDAQ 100 + Russell 3000 합산 유니버스.
S&P 1500 + NASDAQ 100 은 눌림목 스크리너 대상, Russell 3000 (Vanguard VTHR API)은
패턴 매칭 커버리지 확장용.
"""
from __future__ import annotations

import io
import re
import time
import zipfile
from collections.abc import Callable

import FinanceDataReader as fdr
import pandas as pd
import requests
import yfinance as yf

# Russell 3000 구성종목 소스. 지수 자체는 FTSE Russell이 유료로만 배포하므로 이를
# 추종하는 ETF의 공개 보유종목 파일에서 얻는다. 한 곳이 막혀도 나머지로 이어가도록
# 두 곳을 순서대로 시도한다(2026-09-09: Vanguard 단일 소스가 조용히 막혀 있었다).
#
# 1순위 iShares IWV — CSV 파일이라 봇 차단이 덜하고 형식이 오래 안정적이다.
# 2순위 Vanguard VTHR — 원래 쓰던 내부 JSON API. HTML 차단 페이지를 HTTP 200으로
#       돌려주기 시작해 json() 파싱이 깨졌다(아래 _require_json 참고).
# stockanalysis.com의 지수 구성종목 목록 — Russell 3000 = Russell 1000 + Russell 2000
# 이라 두 장을 합쳐 만든다. 이 사이트는 NASDAQ100 수집에도 이미 쓰고 있어 형식·가용성이
# 검증돼 있다(_fetch_nasdaq100).
# stockanalysis.com 내부 스크리너 API. 시총 내림차순으로 원하는 개수만 받을 수 있어
# "미국 상장 시총 상위 3,000개"(= Russell 3000의 정의)를 그대로 만들 수 있다.
STOCKANALYSIS_SCREENER_URL = (
    "https://stockanalysis.com/api/screener/s/f"
    "?m=marketCap&s=desc&c=s,n,marketCap&cn=3000&i=stocks"
)
# 전체 종목 목록 페이지(시총 컬럼 포함).
STOCKANALYSIS_ALL_STOCKS_URL = "https://stockanalysis.com/stocks/"

# 네이버 증권 앱이 쓰는 해외주식 API. 시가총액 내림차순으로 페이지 단위로 준다 —
# "시총 상위 N개"를 그대로 받을 수 있어 Russell 3000 근사에 가장 잘 맞는다.
NAVER_WORLD_URL = "https://api.stock.naver.com/stock/exchange/{exchange}/marketValue"
_NAVER_EXCHANGES = ("NASDAQ", "NYSE", "AMEX")
_NAVER_PAGE_SIZE = 100
ISHARES_IWV_URL = (
    "https://www.ishares.com/us/products/239714/ishares-russell-3000-etf/"
    "1467271812596.ajax?fileType=csv&fileName=IWV_holdings&dataType=fund"
)
VANGUARD_VTHR_BASE = (
    "https://investor.vanguard.com/investment-products/etfs/profile/api/VTHR/portfolio-holding/stock"
)

# iShares CSV의 sector는 GICS 이름이지만 표기가 미묘하게 다른 값이 섞여 들어올 수
# 있다(예: 'Communication'). 모르는 이름을 그대로 저장하면 broadSector()에서 조용히
# '기타'로 빠지므로, 아는 GICS 이름만 통과시키고 나머지는 비워 둔다 —
# _backfill_missing_sectors가 필요할 때 yfinance로 채운다.
_GICS_SECTORS: frozenset[str] = frozenset({
    "Information Technology",
    "Health Care",
    "Financials",
    "Consumer Discretionary",
    "Consumer Staples",
    "Communication Services",
    "Industrials",
    "Energy",
    "Utilities",
    "Real Estate",
    "Materials",
})

_KIS_MASTER_BASE = "https://new.real.download.dws.co.kr/common/master/"
_KIS_MASTER_FILES = {"NAS": "nasmst.cod", "NYS": "nysmst.cod", "AMS": "amsmst.cod"}
_KR_RE = re.compile(r"[가-힣]")

# Yahoo Finance uses hyphens for share class suffixes (BRK-B, BF-B).
_TICKER_CORRECTIONS: dict[str, str] = {
    "BRKB": "BRK-B",
    "BFB": "BF-B",
}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
}


def _normalize_ticker(t: str) -> str:
    if not isinstance(t, str):
        return ""
    t = t.strip()
    if t in _TICKER_CORRECTIONS:
        return _TICKER_CORRECTIONS[t]
    return t.replace(".", "-")


def _read_html(url: str) -> list[pd.DataFrame]:
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    resp.raise_for_status()
    return pd.read_html(io.StringIO(resp.text))


def _body_snippet(resp: requests.Response) -> str:
    """응답 앞부분을 한 줄로. 차단 페이지인지 빈 응답인지 로그만 보고 알 수 있게."""
    return " ".join(resp.text.split())[:160] or "(빈 응답)"


def _require_json(resp: requests.Response) -> dict:
    """JSON이 아닌 응답을 사유가 드러나는 에러로 바꾼다.

    봇 차단 페이지는 HTTP 200 + HTML로 오기 때문에 raise_for_status()를 통과한다.
    그대로 .json()을 부르면 'Expecting value: line 1 column 1 (char 0)'만 남아서,
    로그를 봐도 왜 실패했는지 알 수 없다(실제로 이 상태로 며칠 방치됐다).
    """
    try:
        return resp.json()
    except ValueError:
        raise RuntimeError(
            f"JSON이 아닌 응답 (content-type={resp.headers.get('content-type')}): {_body_snippet(resp)}"
        ) from None


def _rows_from_json(payload) -> list[dict]:
    """응답 어딘가에 있는 '딕셔너리들의 리스트'를 찾아 돌려준다.

    내부 API라 감싸는 키 이름이 예고 없이 바뀐다(data.data / data / result ...).
    키 이름을 고정하면 그때마다 조용히 빈 결과가 되므로 구조로 찾는다.
    """
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for value in payload.values():
            rows = _rows_from_json(value)
            if len(rows) > 10:  # 메타데이터 몇 개짜리 리스트와 구분
                return rows
    return []


def _fetch_stockanalysis_screener() -> pd.DataFrame:
    """stockanalysis.com 스크리너 API에서 시총 상위 종목."""
    resp = requests.get(STOCKANALYSIS_SCREENER_URL, headers=_HEADERS, timeout=30)
    resp.raise_for_status()
    rows = _rows_from_json(_require_json(resp))
    if not rows:
        raise RuntimeError(f"종목 배열을 찾을 수 없음: {_body_snippet(resp)}")

    sample = rows[0]
    ticker_key = next((k for k in ("s", "symbol", "ticker") if k in sample), None)
    if ticker_key is None:
        raise RuntimeError(f"티커 키를 찾을 수 없음 (키: {list(sample)[:8]})")
    name_key = next((k for k in ("n", "name", "companyName") if k in sample), ticker_key)
    return pd.DataFrame({
        "ticker": [str(r.get(ticker_key, "")) for r in rows],
        "name": [str(r.get(name_key, "")) for r in rows],
        "sector": None,
    })


def _stockanalysis_page(page: int) -> pd.DataFrame | None:
    """전체 종목 목록의 한 페이지(티커·종목명·시총). 표를 못 찾으면 None."""
    url = STOCKANALYSIS_ALL_STOCKS_URL if page == 1 else f"{STOCKANALYSIS_ALL_STOCKS_URL}?p={page}"
    for t in _read_html(url):
        cols = {str(c).lower().replace(" ", ""): c for c in t.columns}
        symbol_col = cols.get("symbol") or cols.get("ticker")
        cap_col = cols.get("marketcap")
        if symbol_col is None or cap_col is None:
            continue
        name_col = cols.get("companyname") or cols.get("name") or symbol_col
        return pd.DataFrame({
            "ticker": t[symbol_col].astype(str),
            "name": t[name_col].astype(str),
            "sector": None,
            "_cap": t[cap_col].map(_parse_cap),
        })
    return None


def _parse_cap(value) -> float | None:
    """'1.23B' → 1.23e9. 시총 컬럼이 단위 접미사가 붙은 문자열로 온다."""
    units = {"T": 1e12, "B": 1e9, "M": 1e6, "K": 1e3}
    text = str(value).replace(",", "").replace("$", "").strip()
    if not text or text[-1] not in units:
        return None
    try:
        return float(text[:-1]) * units[text[-1]]
    except ValueError:
        return None


def _fetch_stockanalysis_all_stocks() -> pd.DataFrame:
    """전체 종목 목록을 페이지를 넘겨가며 모아 시총 상위 3,000개를 돌려준다.

    한 페이지에 500개씩만 렌더된다(알파벳 순). 1페이지만 읽으면 A로 시작하는
    종목만 들어와 NVDA·MSFT 같은 대형주가 통째로 빠진다 — 실제로 첫 시도가
    그렇게 500개짜리 반쪽 결과를 냈다.
    """
    frames: list[pd.DataFrame] = []
    seen: set[str] = set()
    for page in range(1, _STOCKANALYSIS_MAX_PAGES + 1):
        df = _stockanalysis_page(page)
        if df is None or df.empty:
            break
        new = df[~df["ticker"].isin(seen)]
        print(f"    p{page}: {len(df)}개 (신규 {len(new)}개)", flush=True)
        # 페이지 파라미터가 안 먹으면 같은 500개가 계속 온다 — 그때는 멈춘다.
        if new.empty:
            break
        seen.update(new["ticker"])
        frames.append(new)

    if not frames:
        raise RuntimeError(f"{STOCKANALYSIS_ALL_STOCKS_URL} 에서 시총이 있는 표를 찾을 수 없음")

    df = pd.concat(frames, ignore_index=True)
    # 시총을 못 읽은 행은 상위 3,000개를 자르는 기준이 없으니 뺀다.
    df = df.dropna(subset=["_cap"]).sort_values("_cap", ascending=False)
    return df.head(_RUSSELL_TARGET_SIZE).drop(columns="_cap")


def _naver_page(exchange: str, page: int) -> list[dict]:
    resp = requests.get(
        NAVER_WORLD_URL.format(exchange=exchange),
        params={"page": page, "pageSize": _NAVER_PAGE_SIZE},
        headers=_HEADERS,
        timeout=20,
    )
    resp.raise_for_status()
    return _rows_from_json(_require_json(resp))


def _fetch_naver_world() -> pd.DataFrame:
    """네이버 해외주식 시총 상위 목록(나스닥·뉴욕·아멕스)을 합쳐 상위 3,000개.

    시총 내림차순으로 내려오므로 목표 개수만 채우면 멈춘다 — 전체를 훑을 필요가 없다.
    """
    rows: list[dict] = []
    for exchange in _NAVER_EXCHANGES:
        got = 0
        for page in range(1, 40):
            try:
                page_rows = _naver_page(exchange, page)
            except Exception as exc:  # noqa: BLE001
                print(f"    {exchange} p{page} 실패: {exc}", flush=True)
                break
            if not page_rows:
                break
            rows.extend(page_rows)
            got += len(page_rows)
            # 거래소별로 넉넉히 받아 두고 마지막에 시총으로 다시 줄 세운다.
            if got >= _RUSSELL_TARGET_SIZE:
                break
        print(f"    {exchange}: {got}개", flush=True)

    if not rows:
        raise RuntimeError("네이버 해외주식 목록에서 한 건도 받지 못함")

    sample = rows[0]
    ticker_key = next(
        (k for k in ("symbolCode", "reutersCode", "symbol", "itemCode") if k in sample), None
    )
    if ticker_key is None:
        raise RuntimeError(f"티커 키를 찾을 수 없음 (키: {list(sample)[:12]})")
    name_key = next((k for k in ("stockName", "stockNameEng", "name") if k in sample), ticker_key)
    cap_key = next((k for k in ("marketValue", "marketCap", "amount") if k in sample), None)

    df = pd.DataFrame({
        "ticker": [str(r.get(ticker_key, "")) for r in rows],
        "name": [str(r.get(name_key, "")) for r in rows],
        "sector": None,
        "_cap": [_naver_number(r.get(cap_key)) if cap_key else None for r in rows],
    })
    df = df.drop_duplicates(subset="ticker")
    if cap_key and df["_cap"].notna().any():
        df = df.dropna(subset=["_cap"]).sort_values("_cap", ascending=False)
    # 시총 필드를 못 찾아도 응답이 이미 시총 내림차순이라 앞에서부터 자르면 된다.
    return df.head(_RUSSELL_TARGET_SIZE).drop(columns="_cap")


def _naver_number(value) -> float | None:
    """'1,234,567' 또는 숫자 → float. 네이버는 금액을 콤마 문자열로 주기도 한다."""
    if value is None:
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return None


def _fetch_kis_master_universe() -> pd.DataFrame:
    """한국투자증권 해외주식 마스터 파일에서 시총 상위 3,000개.

    파이프라인이 한글 종목명을 얻으려고 이미 받는 파일이라 새 의존이 없다.
    다만 이 파일에 시총 필드가 있는지는 배포본마다 다르므로, 없으면 필드 배치를
    에러 메시지에 담아 알려준다(그래야 다음에 어느 칸을 쓸지 정할 수 있다).
    """
    records: list[list[str]] = []
    for exchange, filename in _KIS_MASTER_FILES.items():
        try:
            resp = requests.get(f"{_KIS_MASTER_BASE}{filename}.zip", timeout=60)
            resp.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                raw = zf.read(zf.namelist()[0])
        except Exception as exc:  # noqa: BLE001
            print(f"    {exchange} 마스터 실패: {exc}", flush=True)
            continue
        for line in raw.split(b"\n"):
            line = line.rstrip(b"\r")
            if not line:
                continue
            parts = line.decode("euc-kr", errors="replace").split("\t")
            if len(parts) >= 7:
                records.append(parts)

    if not records:
        raise RuntimeError("마스터 파일을 하나도 못 받음")

    # 티커 칸(4)은 기존 한글명 매핑에서 검증된 위치다. 시총 후보 칸을 찾는다:
    # 숫자로 읽히면서 값의 폭이 큰(대형주~소형주) 칸이 시총일 가능성이 높다.
    width = min(len(r) for r in records)
    best_col, best_span = None, 0.0
    for col in range(width):
        values = [_naver_number(r[col]) for r in records[:2000]]
        nums = [v for v in values if v and v > 0]
        if len(nums) < len(records[:2000]) * 0.8:
            continue
        span = max(nums) / min(nums)
        # 시총은 최대/최소 비율이 수천 배 이상 벌어진다(주가·주식수 칸과 구분).
        if span > best_span and max(nums) > 1e8:
            best_col, best_span = col, span

    if best_col is None:
        layout = " | ".join(f"[{i}]{v[:14]}" for i, v in enumerate(records[0][:width]))
        raise RuntimeError(f"시총으로 볼 만한 칸이 없음 ({width}칸): {layout}")

    df = pd.DataFrame({
        "ticker": [r[4].strip() for r in records],
        "name": [r[6].strip() for r in records],
        "sector": None,
        "_cap": [_naver_number(r[best_col]) for r in records],
    })
    df = df[df["ticker"].str.match(r"^[A-Z]{1,5}(-[A-Z])?$", na=False)].drop_duplicates(subset="ticker")
    print(f"    시총 추정 칸=[{best_col}] (최대/최소 {best_span:,.0f}배)", flush=True)
    return df.dropna(subset=["_cap"]).sort_values("_cap", ascending=False).head(_RUSSELL_TARGET_SIZE).drop(columns="_cap")


def _fetch_ishares_iwv() -> pd.DataFrame:
    """iShares IWV(Russell 3000 ETF) 보유종목 CSV에서 티커 목록 반환.

    CSV 앞에 펀드명·기준일 같은 머리말이 몇 줄 붙어 오므로 'Ticker,'로 시작하는
    실제 헤더 줄을 찾아 거기서부터 읽는다(머리말 줄 수는 고정이 아니다).
    """
    resp = requests.get(ISHARES_IWV_URL, headers=_HEADERS, timeout=30)
    resp.raise_for_status()
    lines = resp.text.splitlines()
    header_i = next((i for i, line in enumerate(lines) if line.lstrip('"').startswith("Ticker")), None)
    if header_i is None:
        raise RuntimeError(f"CSV 헤더('Ticker,...')를 찾을 수 없음: {_body_snippet(resp)}")

    df = pd.read_csv(io.StringIO("\n".join(lines[header_i:])))
    if "Ticker" not in df.columns:
        raise RuntimeError(f"CSV에 Ticker 컬럼 없음 (컬럼: {list(df.columns)[:8]})")

    # 현금·선물 같은 비주식 행을 뺀다(Asset Class 컬럼이 없으면 티커 정리로만 거른다).
    if "Asset Class" in df.columns:
        df = df[df["Asset Class"].astype(str).str.strip() == "Equity"]

    sector = df["Sector"].astype(str).str.strip() if "Sector" in df.columns else None
    return pd.DataFrame({
        "ticker": df["Ticker"].astype(str),
        "name": df["Name"].astype(str) if "Name" in df.columns else "",
        # 아는 GICS 이름만 통과 — 모르는 표기를 그대로 두면 '기타'로 잘못 분류된다.
        "sector": sector.where(sector.isin(_GICS_SECTORS)) if sector is not None else None,
    })


def _fetch_vthr_holdings() -> pd.DataFrame:
    """Vanguard VTHR (Russell 3000 ETF) API에서 미국 주식 티커 목록 반환."""
    all_entities: list[dict] = []
    start = 1
    total_size: int | None = None
    while True:
        resp = requests.get(
            f"{VANGUARD_VTHR_BASE}?start={start}&count=500",
            headers=_HEADERS,
            timeout=20,
        )
        resp.raise_for_status()
        data = _require_json(resp)
        if total_size is None:
            total_size = data.get("size", 0)
        entities = data.get("fund", {}).get("entity", [])
        if not entities:
            break
        all_entities.extend(entities)
        if len(all_entities) >= total_size:
            break
        start += 500
        time.sleep(0.2)

    result = pd.DataFrame({
        "ticker": [str(e.get("ticker", "")).strip() for e in all_entities],
        "name": [e.get("longName", "") for e in all_entities],
        "sector": None,
    })
    result["ticker"] = result["ticker"].str.replace(".", "-", regex=False)
    result = result[result["ticker"].notna() & ~result["ticker"].isin(["-", "", "nan"])]
    return result


# Russell 3000인데 이보다 적게 왔다면 형식이 바뀌어 반쪽만 파싱된 것으로 본다.
# (실제 구성종목은 2,500~3,000개 선)
_MIN_RUSSELL_TICKERS = 1000

# Russell 3000을 근사할 때 남길 종목 수. 지수 이름 그대로 3,000개.
_RUSSELL_TARGET_SIZE = 3000
# 전체 목록은 한 페이지 500개라 3,000개를 채우려면 6장이면 되지만, 페이지당
# 개수가 줄어도 목표를 채우도록 여유를 둔다.
_STOCKANALYSIS_MAX_PAGES = 15

# (소스 이름, 수집 함수) — 앞에서부터 시도한다.
_RUSSELL_SOURCES: list[tuple[str, Callable[[], pd.DataFrame]]] = [
    ("네이버 해외주식 시총순", _fetch_naver_world),
    ("KIS 마스터 시총상위", _fetch_kis_master_universe),
    ("stockanalysis 전체목록", _fetch_stockanalysis_all_stocks),
    ("stockanalysis 스크리너API", _fetch_stockanalysis_screener),
    ("iShares IWV", _fetch_ishares_iwv),
    ("Vanguard VTHR", _fetch_vthr_holdings),
]


def _clean_russell(df: pd.DataFrame) -> pd.DataFrame:
    """티커 표기를 통일하고 빈 행을 버린다(소스마다 형식이 달라 여기서 한 번에)."""
    df = df.copy()
    df["ticker"] = df["ticker"].astype(str).str.strip().str.replace(".", "-", regex=False)
    return df[~df["ticker"].isin(["-", "", "nan", "None"])]


def fetch_russell3000() -> tuple[pd.DataFrame, str]:
    """Russell 3000 구성종목을 소스 순서대로 시도해 처음 성공한 것을 돌려준다.

    반환은 (행, 사용한 소스 이름). 전부 실패하면 마지막 사유를 담아 RuntimeError.
    """
    errors: list[str] = []
    for name, fetch in _RUSSELL_SOURCES:
        try:
            df = _clean_russell(fetch())
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
            continue
        # 3,000 종목짜리 지수인데 몇십 개만 왔다면 형식이 바뀐 것이다 — 조용히
        # 반쪽짜리를 쓰느니 다음 소스로 넘어간다.
        if len(df) < _MIN_RUSSELL_TICKERS:
            errors.append(f"{name}: 종목 수가 비정상적으로 적음({len(df)}개)")
            continue
        return df, name
    raise RuntimeError(" | ".join(errors) if errors else "시도할 소스 없음")


def _fetch_sp_index(wiki_url: str, membership_label: str) -> pd.DataFrame:
    """Wikipedia S&P 지수 구성종목 페이지에서 티커·이름·섹터 추출."""
    tables = _read_html(wiki_url)
    for t in tables:
        ticker_col = next(
            (c for c in t.columns if "symbol" in str(c).lower() or "ticker" in str(c).lower()), None
        )
        name_col = next(
            (c for c in t.columns if "security" in str(c).lower() or "company" in str(c).lower()), None
        )
        sector_col = next((c for c in t.columns if "sector" in str(c).lower()), None)
        if ticker_col and name_col:
            return pd.DataFrame({
                "ticker": t[ticker_col].astype(str),
                "name": t[name_col].astype(str),
                "sector": t[sector_col].astype(str) if sector_col else None,
                "index_membership": membership_label,
            })
    raise ValueError(f"{wiki_url} 에서 구성종목 테이블을 찾을 수 없음")


def _fetch_nasdaq100() -> pd.DataFrame:
    """나스닥 100 구성종목 추출.

    Wikipedia Nasdaq-100 페이지의 구성종목 표가 삭제되어(2026-07 확인)
    stockanalysis.com으로 대체. sector 정보는 없음 — S&P500과 겹치는 종목은
    dedup 시 S&P500(FDR) 쪽 sector가 우선 채택되어 대부분 보존되고, S&P500에
    없는 나머지(소수)는 _backfill_missing_sectors가 yfinance로 채운다.
    """
    url = "https://stockanalysis.com/list/nasdaq-100-stocks/"
    tables = _read_html(url)
    for t in tables:
        ticker_col = next(
            (c for c in t.columns if "symbol" in str(c).lower() or "ticker" in str(c).lower()), None
        )
        name_col = next((c for c in t.columns if "company" in str(c).lower()), None)
        if ticker_col and name_col:
            return pd.DataFrame({
                "ticker": t[ticker_col].astype(str),
                "name": t[name_col].astype(str),
                "sector": None,
                "index_membership": "NASDAQ100",
            })
    raise ValueError(f"{url} 에서 구성종목 테이블을 찾을 수 없음")


# yfinance(Yahoo Finance)의 sector 값은 GICS 표준 이름과 4개가 다르다. S&P500(FDR)이
# 채우는 sector는 GICS 표준 이름을 쓰고, frontend/lib/sectorMap.ts의 broadSector()도
# GICS 표준 이름을 기준으로 매칭한다 — 이 매핑 없이 그대로 저장하면 같은 stock_universe.
# sector 컬럼 안에 두 가지 이름 체계가 섞여, 이 네 업종의 NASDAQ100 전용 종목이
# broadSector()에서 '기타'로 잘못 빠진다(업종별 유동비율 기준이 있는데도 못 받음).
_YFINANCE_SECTOR_TO_GICS: dict[str, str] = {
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Financial Services": "Financials",
    "Basic Materials": "Materials",
}


def _backfill_missing_sectors(universe: pd.DataFrame) -> pd.DataFrame:
    """NASDAQ100 전용 종목(S&P500에 없어 sector가 비어 있는 소수)을 yfinance로 채운다.

    NASDAQ100 데이터 소스(stockanalysis.com)엔 sector 정보가 아예 없다.
    S&P500과 겹치는 종목은 dedup 시 S&P500(FDR) 쪽 sector로 이미 채워지므로,
    남는 건 NASDAQ100에만 속한 소수 종목뿐이다 — 개수가 적어(보통 10개 안팎)
    종목당 요청 1회(yfinance .info)로 감당할 만하다. 다른 지수(S&P400/600 등)는
    자체 소스에서 이미 sector를 받으므로 건드리지 않는다.

    사업 분야별 유동비율 기준(assessFinancialHealth)이나 화면의 업종 필터가
    이 sector 없이는 '미분류'로 빠져 정밀도를 못 받는다 — 실패해도(개별 티커
    조회 실패) 파이프라인 전체를 막지 않고 그 종목만 '미분류'로 남긴다.
    """
    missing_mask = universe["sector"].isna() & (universe["index_membership"] == "NASDAQ100")
    missing_tickers = universe.loc[missing_mask, "ticker"].tolist()
    if not missing_tickers:
        return universe

    print(
        f"  NASDAQ100 전용 종목 중 업종 정보 없음: {len(missing_tickers)}개 → yfinance로 보완",
        flush=True,
    )
    filled = 0
    for ticker in missing_tickers:
        try:
            sector = yf.Ticker(ticker).info.get("sector")
        except Exception:  # noqa: BLE001
            sector = None
        if sector:
            sector = _YFINANCE_SECTOR_TO_GICS.get(sector, sector)
            universe.loc[universe["ticker"] == ticker, "sector"] = sector
            filled += 1
    print(f"    → {filled}/{len(missing_tickers)}개 보완", flush=True)
    return universe


def get_us_korean_names() -> dict[str, str]:
    """KIS 해외주식 마스터 파일에서 티커 → 한글 종목명 매핑 반환.

    실패 시 빈 dict 반환 — 한글명 없어도 파이프라인 정상 작동.
    레이아웃: 단축코드(6) + 표준코드(12) + 한글명(40 bytes EUC-KR) + 영문명(80) + ...
    """
    result: dict[str, str] = {}
    for exchange, filename in _KIS_MASTER_FILES.items():
        url = f"{_KIS_MASTER_BASE}{filename}.zip"
        try:
            resp = requests.get(url, timeout=60)
            resp.raise_for_status()
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                actual = zf.namelist()[0]
                raw = zf.read(actual)
            count = 0
            for line in raw.split(b"\n"):
                line = line.rstrip(b"\r")
                if not line:
                    continue
                try:
                    parts = line.decode("euc-kr", errors="replace").split("\t")
                    if len(parts) < 7:
                        continue
                    ticker = parts[4].strip()
                    kr_name = parts[6].strip()
                except Exception:
                    continue
                if not ticker or not _KR_RE.search(kr_name):
                    continue
                if not re.match(r"^[A-Z]{1,5}(-[A-Z])?$", ticker):
                    continue
                result[ticker] = kr_name
                count += 1
            print(f"  KIS 마스터 [{exchange}] {filename}: {count}개 한글명", flush=True)
        except Exception as exc:
            print(f"  KIS 마스터 [{exchange}] 건너뜀: {exc}", flush=True)
    return result


def get_us_universe() -> pd.DataFrame:
    """S&P 1500 + NASDAQ 100 + Russell 3000 합산 유니버스를 반환."""
    parts: list[pd.DataFrame] = []

    # 1. S&P 500 (FinanceDataReader – sector 정보 풍부하여 앞에 배치)
    try:
        sp500 = fdr.StockListing("S&P500")[["Symbol", "Name", "Sector"]].rename(
            columns={"Symbol": "ticker", "Name": "name", "Sector": "sector"}
        )
        sp500["index_membership"] = "S&P500"
        parts.append(sp500)
        print(f"  S&P 500: {len(sp500)}개")
    except Exception as e:
        print(f"  S&P 500 실패: {e}")

    # 2. NASDAQ 100 (stockanalysis.com) — 눌림목 스크리너 대상 지수
    try:
        nasdaq100 = _fetch_nasdaq100()
        parts.append(nasdaq100)
        print(f"  NASDAQ100: {len(nasdaq100)}개")
    except Exception as e:
        print(f"  NASDAQ100 실패: {e}")

    # 3. S&P 400/600 (Wikipedia) — 눌림목 스크리너 대상 지수들
    for label, url in [
        ("S&P400", "https://en.wikipedia.org/wiki/List_of_S%26P_400_companies"),
        ("S&P600", "https://en.wikipedia.org/wiki/List_of_S%26P_600_companies"),
    ]:
        try:
            df = _fetch_sp_index(url, label)
            parts.append(df)
            print(f"  {label}: {len(df)}개")
        except Exception as e:
            print(f"  {label} 실패: {e}")

    # 3. Russell 3000 – 패턴 매칭용 커버리지 확장 (스크리너 대상 아님)
    try:
        russell, source = fetch_russell3000()
        russell["index_membership"] = "Russell3000"
        parts.append(russell)
        print(f"  Russell 3000 ({source}): {len(russell)}개")
    except Exception as e:
        # 실패해도 파이프라인은 계속 간다(S&P1500+NASDAQ100만으로도 스크리너는 돈다).
        # 다만 초록불 실행 로그에 한 줄로 묻히면 며칠씩 모르고 지나가므로, GitHub
        # Actions가 실행 요약에 띄우는 ::warning:: 으로 올린다.
        print(f"::warning::Russell 3000 수집 실패 — 패턴 매칭 커버리지가 좁아집니다 ({e})")

    if not parts:
        raise RuntimeError("유니버스 수집 완전 실패")

    universe = pd.concat(parts, ignore_index=True)
    universe["ticker"] = universe["ticker"].map(_normalize_ticker)
    universe = universe[universe["ticker"].str.len() > 0]
    # S&P500 → NASDAQ100 → S&P400 → S&P600 → Russell3000 순으로 중복 시 앞쪽 우선
    # (S&P500 sector 정보 보존 + 스크리너 대상 라벨이 Russell3000보다 우선)
    universe = universe.drop_duplicates(subset="ticker", keep="first")
    print(f"  → 합산 유니버스: {len(universe)}개 (중복 제거 후)")

    universe = _backfill_missing_sectors(universe)

    kr_names = get_us_korean_names()
    universe["name_kr"] = universe["ticker"].map(kr_names).fillna("")
    matched = (universe["name_kr"] != "").sum()
    print(f"  → 한글명 매핑: {matched}개 / {len(universe)}개", flush=True)

    return universe[["ticker", "name", "name_kr", "sector", "index_membership"]]


def _probe_russell_sources() -> int:
    """소스별로 따로 두드려 보고 결과를 출력한다 — `python -m src.universe_us`.

    작업용 컨테이너는 ETF·시세 사이트 네트워크가 막혀 있어 여기서 확인할 수 없다.
    .github/workflows/universe_probe.yml로 Actions에서 1분 만에 돌려본다 —
    22분짜리 본 파이프라인을 돌려가며 소스를 고르지 않아도 된다.
    """
    results: list[str] = []
    ok = 0
    for name, fetch in _RUSSELL_SOURCES:
        try:
            df = _clean_russell(fetch())
        except Exception as exc:  # noqa: BLE001
            results.append(f"  x {name}: {exc}")
            continue
        sectors = int(df["sector"].notna().sum()) if "sector" in df.columns else 0
        results.append(
            f"  o {name}: {len(df)}개 (업종 있는 행 {sectors}개) 예: {list(df['ticker'][:5])}"
        )
        ok += 1

    # 소스 하나가 진행률 표시줄을 수백 줄 쏟아내면 앞선 결과가 로그에서 밀려난다.
    # 그래서 마지막에 전부 모아 한 번 더 찍는다.
    print("\n=== 소스별 결과 ===", flush=True)
    for line in results:
        print(line, flush=True)
    return ok


if __name__ == "__main__":
    import sys

    print("Russell 3000 소스 점검...", flush=True)
    sys.exit(0 if _probe_russell_sources() else 1)
