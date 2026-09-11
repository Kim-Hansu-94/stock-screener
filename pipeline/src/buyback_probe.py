"""자사주 "실제 매입량"을 어디서 받을 수 있는지 두드려 보는 탐색 프로브.

`python -m src.buyback_probe` — 저장하지 않는다. 응답이 오는지, 어떤 모양인지만 찍는다.

## 왜 필요한가

지금 `buyback.py`가 쓰는 DART 주요사항보고서(`tsstkAqDecsn`)는 **"얼마를 사겠다"는
계획 공시**다. 그래서 진행률이 기간 기준 근사치뿐이고, "지금까지 실제로 얼마나
샀나"는 못 낸다.

시장에서는 이걸 두 방법으로 추적한다. 둘 다 여기서 두드려 본다:

1. **DART 공시서류원본파일** — 자기주식취득**결과**보고서는 정형 API 항목이 없다
   (2026-09-10 프로브에서 `tsstkAqTrctrCnsCnc`가 status=101로 없는 것을 확인한 것과
   같은 맥락). 대신 `list.json`으로 접수번호를 얻어 원문 파일을 통째로 받아
   파싱하는 길이 있다. **새 키가 필요 없다** — 지금 쓰는 DART_API_KEY 그대로.
   한계: 결과보고서는 프로그램이 **끝난 뒤** 나오므로 진행 중에는 안 잡힌다.

2. **네이버 거래원(증권사 창구별 순매수)** — 자사주 취득은 회사가 주관 증권사
   창구를 통해 사므로, 그 창구의 일별 순매수를 보면 **진행 중에도** 매입량을
   따라갈 수 있다. SK하이닉스 자사주를 SK증권 창구로 추적한다는 이야기가 이것이다.
   한계: 그 창구 매수가 전부 자사주는 아니다(같은 증권사의 다른 고객 주문이 섞인다)
   — 그래서 이건 "확정 수치"가 아니라 **추정치**이고, 화면에 그렇게 밝혀야 한다.

두 방법은 서로를 대체하지 않는다. 1번은 사후 확정치, 2번은 진행 중 추정치다.
"""

from __future__ import annotations

import io
import re
import sys
from datetime import date, timedelta
from urllib.parse import urljoin
import zipfile

import pandas as pd
import requests
from dotenv import load_dotenv

from . import broker_flow
from .buyback import _api_key, _disclosure_list, load_corp_codes
from .buyback import _get as _dart_get
from .naver_api import HEADERS, TIMEOUT

_SAMPLES = [("000660", "SK하이닉스"), ("005930", "삼성전자")]

_DOCUMENT_URL = "https://opendart.fss.or.kr/api/document.xml"

# 거래원(증권사 창구별 매매) 후보 경로. 어느 것이 살아 있는지 모르므로 전부 두드린다.
_BROKER_URLS = [
    ("종목 메인(거래원 인라인)", "https://finance.naver.com/item/main.naver?code={code}"),
    ("시세 탭", "https://finance.naver.com/item/sise.naver?code={code}"),
    ("거래원 프레임", "https://finance.naver.com/item/frgn.naver?code={code}"),
    ("모바일 trend API", "https://m.stock.naver.com/api/stock/{code}/trend"),
]

# 이 글자들이 응답에 있으면 거래원 표가 들어 있을 가능성이 높다.
_BROKER_MARKERS = ("거래원", "증권", "매도상위", "매수상위")


def _probe_dart_document() -> None:
    print("\n[A] DART 공시서류원본파일 (자기주식취득 결과보고서 원문)", flush=True)
    api_key = _api_key()
    if not api_key:
        print("  x DART_API_KEY 미설정", flush=True)
        return

    try:
        corp_codes = load_corp_codes()
    except Exception as exc:  # noqa: BLE001
        print(f"  x corp_code 로드 실패: {exc}", flush=True)
        return

    for ticker, name in _SAMPLES:
        corp_code = corp_codes.get(ticker)
        if not corp_code:
            print(f"  x {name}({ticker}): corp_code 없음", flush=True)
            continue

        disclosures = _disclosure_list(corp_code, api_key)
        # 결과보고서가 있으면 그걸 우선 본다 — 실제 취득 금액은 거기 있다.
        results = [d for d in disclosures if "결과" in str(d.get("report_nm", ""))]
        target = (results or disclosures)[-1] if (results or disclosures) else None
        if target is None:
            print(f"  - {name}({ticker}): 자기주식 공시 없음", flush=True)
            continue

        rcept_no = target.get("rcept_no")
        print(f"  · {name}({ticker}): '{target.get('report_nm')}' ({target.get('rcept_dt')}) rcept_no={rcept_no}", flush=True)

        try:
            resp = requests.get(
                _DOCUMENT_URL, params={"crtfc_key": api_key, "rcept_no": rcept_no}, timeout=30
            )
            resp.raise_for_status()
        except Exception as exc:  # noqa: BLE001
            print(f"      x 원문 요청 실패: {exc}", flush=True)
            continue

        head = resp.content[:200]
        # 에러는 XML(status/message)로, 성공은 ZIP(PK 시그니처)으로 온다.
        if not resp.content.startswith(b"PK"):
            print(f"      x ZIP이 아님({len(resp.content)}B): {head[:200]!r}", flush=True)
            continue

        try:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                names = zf.namelist()
                print(f"      o ZIP {len(resp.content):,}B, 파일={names}", flush=True)
                raw = zf.read(names[0])
        except Exception as exc:  # noqa: BLE001
            print(f"      x ZIP 열기 실패: {exc}", flush=True)
            continue

        # 공시 원문은 EUC-KR인 경우가 많다. 둘 다 시도해 본다.
        text = None
        for encoding in ("utf-8", "euc-kr", "cp949"):
            try:
                text = raw.decode(encoding)
                print(f"      o 인코딩={encoding}, {len(text):,}자", flush=True)
                break
            except UnicodeDecodeError:
                continue
        if text is None:
            print("      x 어떤 인코딩으로도 못 읽음", flush=True)
            continue

        # 금액이 어느 표현으로 들어 있는지 본다 — 파싱 코드를 짜려면 이게 필요하다.
        for keyword in ("취득금액", "취득한 자기주식", "취득수량", "취득주식수", "총取得"):
            index = text.find(keyword)
            if index >= 0:
                snippet = text[index : index + 160].replace("\n", " ")
                print(f"      · '{keyword}' 주변: {snippet}", flush=True)

        try:
            tables = pd.read_html(io.StringIO(text))
            print(f"      o 표 {len(tables)}개", flush=True)
            for i, table in enumerate(tables[:6]):
                flat = " ".join(str(v) for v in table.astype(str).values.flatten())
                if any(k in flat for k in ("취득", "수량", "금액")):
                    print(f"        [표 {i}] shape={table.shape}", flush=True)
                    for row in table.astype(str).values[:5]:
                        print(f"          {list(row)[:6]}", flush=True)
        except Exception as exc:  # noqa: BLE001
            print(f"      · 표 파싱 실패(원문이 표가 아닐 수 있음): {exc}", flush=True)


def _probe_broker_windows() -> None:
    print("\n[B] 네이버 거래원 (증권사 창구별 순매수 — 진행 중 추정용)", flush=True)
    for ticker, name in _SAMPLES[:1]:  # 한 종목만 봐도 구조는 같다
        for label, template in _BROKER_URLS:
            url = template.format(code=ticker)
            try:
                resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
            except Exception as exc:  # noqa: BLE001
                print(f"  x {label}: {exc}", flush=True)
                continue

            if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = "euc-kr"
            text = resp.text
            found = [m for m in _BROKER_MARKERS if m in text]
            print(f"  · {label}: {len(text):,}자, 발견={found or '없음'}", flush=True)
            if not found:
                continue

            try:
                tables = pd.read_html(io.StringIO(text))
            except Exception as exc:  # noqa: BLE001
                print(f"      표 파싱 실패: {exc}", flush=True)
                continue
            for i, table in enumerate(tables):
                flat = " ".join(str(v) for v in table.astype(str).values.flatten())
                if "증권" not in flat:
                    continue
                print(f"      [표 {i}] shape={table.shape} 컬럼={list(table.columns)[:6]}", flush=True)
                for row in table.astype(str).values[:5]:
                    print(f"        {list(row)[:6]}", flush=True)


def _probe_broker_parser() -> None:
    """탐색이 아니라 **실제 파서**가 살아 있는 페이지에서 도는지 본다.

    [B]는 표가 있다는 것까지만 봤다. 그 표를 broker_flow.parse_brokers가 제대로
    읽는지는 별개 문제다 — 컨센서스에서 "표는 찾았는데 엉뚱한 칸을 읽던" 일을
    한 번 겪었으므로 파서까지 여기서 돌려 본다.
    """
    print("\n[C] broker_flow 파서 실측", flush=True)
    for ticker, name in _SAMPLES:
        try:
            brokers, source = broker_flow.fetch_brokers(ticker)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            continue
        top = sorted(brokers.items(), key=lambda kv: kv[1]["net_qty"], reverse=True)[:3]
        print(f"  o {name}({ticker}): 소스={source}, 창구 {len(brokers)}곳", flush=True)
        for broker, values in top:
            print(
                f"      {broker}: 매수 {values['buy_qty']:,.0f} / 매도 {values['sell_qty']:,.0f} "
                f"→ 순매수 {values['net_qty']:,.0f}",
                flush=True,
            )


# KRX 정보데이터시스템. 네이버가 "오늘 상위 5개 창구"만 주는 것과 달리 여기는
# 통계 조회라 **과거 날짜를 지정할 수 있다** — 되면 취득 시작일부터 소급할 수 있다.
# bld 코드는 화면마다 다르고 공개 문서가 없어 후보를 두드려 본다.
_KRX_URL = "http://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
_KRX_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": "http://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd",
    "X-Requested-With": "XMLHttpRequest",
}
_KRX_CANDIDATES = [
    ("회원사별 거래실적(종목)", "dbms/MDC/STAT/standard/MDCSTAT02501"),
    ("회원사별 거래실적(일별)", "dbms/MDC/STAT/standard/MDCSTAT02601"),
    ("종목별 거래실적", "dbms/MDC/STAT/standard/MDCSTAT01701"),
    ("투자자별 거래실적", "dbms/MDC/STAT/standard/MDCSTAT02203"),
]


def _probe_krx_broker_history() -> None:
    """거래원 **과거 이력**을 받을 수 있는 곳 탐색.

    네이버 경로는 그날 상위 5개뿐이라 소급이 안 된다. SK하이닉스는 8월 20일에
    취득을 시작했는데 수집은 오늘부터라, 관측 하루치(1.16조)를 40조로 나눠 2.9%가
    나오는 상황이다 — 그건 "회사가 3%만 샀다"가 아니라 "우리가 하루만 봤다"는 뜻이다.
    과거를 받을 수 있으면 이 간극이 사라진다.
    """
    print("\n[D] KRX 거래원 과거 이력 탐색", flush=True)
    today = date.today()
    start = today - timedelta(days=30)
    for label, bld in _KRX_CANDIDATES:
        payload = {
            "bld": bld,
            "locale": "ko_KR",
            "isuCd": "KR7000660001",  # SK하이닉스 표준코드
            "tboxisuCd_finder_stkisu0_0": "000660/SK하이닉스",
            "isuCd2": "",
            "codeNmisuCd_finder_stkisu0_0": "SK하이닉스",
            "strtDd": start.strftime("%Y%m%d"),
            "endDd": today.strftime("%Y%m%d"),
            "trdDd": today.strftime("%Y%m%d"),
            "share": "1",
            "money": "1",
            "csvxls_isNo": "false",
        }
        try:
            resp = requests.post(_KRX_URL, data=payload, headers=_KRX_HEADERS, timeout=25)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:  # noqa: BLE001
            print(f"  x {label}({bld}): {exc}", flush=True)
            continue

        # 응답을 감싸는 키가 화면마다 다르다(OutBlock_1 / output / block1 ...).
        rows: list = []
        for value in data.values() if isinstance(data, dict) else []:
            if isinstance(value, list) and value and isinstance(value[0], dict):
                if len(value) > len(rows):
                    rows = value
        if not rows:
            print(f"  - {label}({bld}): 행 없음, 키={list(data)[:6] if isinstance(data, dict) else type(data)}", flush=True)
            continue
        print(f"  o {label}({bld}): {len(rows)}행, 키={sorted(rows[0].keys())[:12]}", flush=True)
        print(f"      첫 행={dict(list(rows[0].items())[:8])}", flush=True)


# ============================================================
# KRX KIND — 자기주식매매 신청/체결내역
# ============================================================
#
# **이게 진짜 소스다.** raoni.xyz 화면의 출처 표기가 "KRX KIND 자기주식매매
# 신청/체결내역 공시"였다(2026-09-11 사용자 제보). 거기엔 일자별 신청·체결 수량이
# 그대로 공시된다 — 창구 순매수로 추정할 필요가 없고 **소급도 된다**.
# 실제로 그 화면은 SK하이닉스 누적 43.0%(10,350,000/24,070,000주)를 보여줬다.
#
# ## 왜 HTML만 뒤지면 안 되는가
#
# 처음엔 KIND 페이지 HTML에서 `.do` 경로만 정규식으로 뽑았다. 그런데 **데이터
# 주소는 HTML이 아니라 페이지가 불러오는 .js 안에 적혀 있는 게 보통**이다
# (2026-09-11 지적받음). 확장자를 .do로 좁힌 것도 실수였다 — KRX 계열은
# data.krx의 getJsonData.cmd처럼 .cmd도 쓴다.
#
# 그래서 이 프로브는 (1) 확장자를 넓게 잡고 (2) **페이지가 부르는 .js를 직접
# 받아서 그 안을 뒤진다**.
_KIND_HEADERS = {
    "User-Agent": HEADERS["User-Agent"],
    "Referer": "https://kind.krx.co.kr/",
    "Accept": "text/html,application/xhtml+xml,*/*",
}

_KIND_PAGES = [
    ("루트", "https://kind.krx.co.kr/"),
    ("PC 메인", "https://kind.krx.co.kr/main.do"),
    ("모바일", "https://mkind.krx.co.kr/"),
    # 모바일 루트가 meta refresh로 여기를 가리킨다 — **확장자가 없다**(2026-09-11 실측).
    # requests는 meta refresh를 안 따라가므로 직접 넣어야 한다.
    ("모바일 메인", "https://mkind.krx.co.kr/main"),
]

# **확장자로 찾으면 안 된다.** 처음엔 `.do`만, 다음엔 `.do|.js|.json|.cmd`로
# 넓혔는데 둘 다 틀렸다 — 모바일 KIND는 `/main`처럼 **확장자 없는 경로**를 쓴다
# (2026-09-11 실측: meta refresh가 `url=/main`이었다). 그래서 확장자는 선택으로
# 두고, "슬래시로 시작하는 경로처럼 생긴 문자열"을 전부 잡는다.
_ENDPOINT_RE = re.compile(r"/[\w./-]{2,80}")
# 정적 리소스는 제외한다 — 이걸 안 빼면 이미지·CSS가 목록을 뒤덮는다.
_STATIC_EXT = (".css", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf")
_SCRIPT_SRC_RE = re.compile(r"""<script[^>]+src=['"]([^'"]+)['"]""", re.I)

# 자기주식 화면을 가리킬 만한 조각들. .js 안에서 이걸 찾는다.
_OWN_HINTS = ("tsstk", "ownstock", "own_stock", "자기주식", "자사주", "acqstk", "trtstk")

_JS_FETCH_LIMIT = 25


def _fetch_text(url: str) -> str | None:
    try:
        resp = requests.get(url, headers=_KIND_HEADERS, timeout=25)
        resp.raise_for_status()
    except Exception as exc:  # noqa: BLE001
        print(f"      x {url}: {exc}", flush=True)
        return None
    if not resp.encoding or resp.encoding.lower() == "iso-8859-1":
        resp.encoding = "utf-8"
    return resp.text or ""


def _clean_paths(paths: list[str]) -> set[str]:
    """정적 리소스·중복을 걷어낸 경로 집합. 확장자 유무는 따지지 않는다."""
    out: set[str] = set()
    for path in paths:
        lowered = path.lower()
        if lowered.endswith(_STATIC_EXT):
            continue
        if lowered.startswith("//") or "://" in lowered:
            continue
        out.add(path)
    return out


def _probe_kind() -> None:
    print("\n[E] KRX KIND — 페이지 + 스크립트(.js)에서 실제 경로 찾기", flush=True)

    endpoints: set[str] = set()
    scripts: set[str] = set()

    for label, url in _KIND_PAGES:
        text = _fetch_text(url)
        if text is None:
            continue
        print(f"  · {label}: {len(text):,}자", flush=True)
        # 짧으면 안내·리다이렉트 셸이다. 통째로 찍어 확정한다.
        if len(text) < 2500:
            print(f"      본문: {text[:1200]!r}", flush=True)

        endpoints.update(_clean_paths(_ENDPOINT_RE.findall(text)))
        for src in _SCRIPT_SRC_RE.findall(text):
            scripts.add(urljoin(url, src))
        # 확장자 없는 경로는 링크/폼에서도 나온다. 속성값을 따로 긁는다.
        for attr in re.findall(r"""(?:href|action|src|url)\s*[:=]\s*['"]([^'"]{2,120})['"]""", text, re.I):
            if attr.startswith("/") or attr.startswith("./") or attr.startswith("../"):
                endpoints.add(urljoin(url, attr).split("?")[0])

    print(f"  o 페이지에서 찾은 경로 {len(endpoints)}개, 스크립트 {len(scripts)}개", flush=True)

    # **여기가 핵심이다.** 데이터 주소는 대개 .js 안에 있다.
    hit_count = 0
    for script_url in sorted(scripts)[:_JS_FETCH_LIMIT]:
        text = _fetch_text(script_url)
        if text is None:
            continue
        found = _clean_paths(_ENDPOINT_RE.findall(text))
        hints = [h for h in _OWN_HINTS if h in text.lower()]
        if not hints and not found:
            continue
        print(f"  · {script_url.rsplit('/', 1)[-1]}: {len(text):,}자, 경로 {len(set(found))}개, 힌트={hints or '없음'}", flush=True)
        endpoints.update(found)
        for hint in hints:
            index = text.lower().find(hint)
            print(f"      '{hint}' 주변: {text[max(0, index-250):index+250]!r}", flush=True)
            hit_count += 1
            break

    # 확장자가 없으니 확장자별로 나누는 건 의미가 없다. 첫 경로 조각으로 묶는다.
    by_prefix: dict[str, list[str]] = {}
    for path in sorted(endpoints):
        parts = [p for p in path.split("/") if p]
        by_prefix.setdefault(parts[0] if parts else "/", []).append(path)
    for prefix, paths in sorted(by_prefix.items(), key=lambda kv: -len(kv[1]))[:15]:
        print(f"  o /{prefix} {len(paths)}개: {paths[:15]}", flush=True)

    own = sorted(p for p in endpoints if any(k in p.lower() for k in _OWN_HINTS))
    print(f"  o 자기주식 후보 경로: {own[:30]}", flush=True)
    if not endpoints:
        print("  - 아무 경로도 못 찾음 — 받은 게 전부 안내/리다이렉트 셸이라는 뜻", flush=True)


def _probe_dart_all_disclosures() -> None:
    """DART에 **최근 공시를 키워드 필터 없이 전부** 나열한다.

    지금까지 자기주식 공시를 '자기주식'·'자사주' 키워드로 걸러서 봤다. 그래서
    일별 신청/체결 내역이 다른 이름으로 올라오고 있었다면 통째로 놓쳤을 수 있다.
    이름을 짐작하지 말고 **있는 그대로 다 찍어 본다**.
    
    이 통로는 이미 된다는 게 확인돼 있다(list.json·document.xml 모두 지금 키로
    응답). KIND 주소를 계속 찍어 맞히는 것보다, 되는 통로에 원하는 게 있는지부터
    보는 게 순서다.
    """
    print("\n[G] DART 최근 공시 전체 (키워드 필터 없음)", flush=True)
    api_key = _api_key()
    if not api_key:
        print("  x DART_API_KEY 미설정", flush=True)
        return
    try:
        corp_codes = load_corp_codes()
    except Exception as exc:  # noqa: BLE001
        print(f"  x corp_code 로드 실패: {exc}", flush=True)
        return

    begin = (date.today() - timedelta(days=30)).strftime("%Y%m%d")
    for ticker, name in _SAMPLES:
        corp_code = corp_codes.get(ticker)
        if not corp_code:
            continue
        try:
            payload = _dart_get(
                "list",
                {
                    "crtfc_key": api_key,
                    "corp_code": corp_code,
                    "bgn_de": begin,
                    "end_de": date.today().strftime("%Y%m%d"),
                    "page_count": 100,
                },
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}: {exc}", flush=True)
            continue
        rows = payload.get("list") or []
        print(f"  o {name}({ticker}): 최근 30일 공시 {len(rows)}건", flush=True)
        for row in rows:
            print(f"      {row.get('rcept_dt')} | {row.get('report_nm')}", flush=True)


def main() -> int:
    load_dotenv()
    print("자사주 실제 매입량 소스 탐색", flush=True)
    _probe_dart_document()
    _probe_broker_windows()
    _probe_broker_parser()
    _probe_krx_broker_history()
    _probe_kind()
    _probe_kind_bundles()
    _probe_kind_pc_menu()
    _probe_acptno()
    _probe_dart_all_disclosures()
    # 탐색 프로브라 성패를 판정하지 않는다 — 출력을 읽고 다음 구현을 정하는 게 목적이다.
    print("\n탐색 완료. 위 출력으로 파싱 대상을 정한다.", flush=True)
    return 0




# ---------------------------------------------------------------------------
# [H] KIND SPA 번들 해부 — 메뉴에 없는 화면의 주소를 찾는 유일한 길
# ---------------------------------------------------------------------------
#
# 왜 [E]로는 부족한가. [E]는 **화면 HTML**만 긁었다. 그런데 신형 KIND는 SPA라서
# HTML은 빈 껍데기이고 라우트·API 주소가 전부 `.js` 번들 안에 있다. 실제로
# 사용자가 "메뉴에 자기주식이 아예 없다"고 확인해 줬다(2026-09-11) — 메뉴에
# 없는 화면이라 화면을 열어 요청을 관찰하는 길 자체가 막힌 것이고, 그렇다면
# **번들을 읽는 수밖에 없다**.
#
# 그리고 [E]가 힌트를 0건으로 본 데는 별도의 이유가 하나 더 있다:
# **번들의 한글은 `\uXXXX`로 이스케이프되어 있다.** 원문 그대로 '자기주식'을
# 찾으면 영원히 안 걸린다. 그래서 여기서는 먼저 이스케이프를 풀고 찾는다.
_KIND_ORIGIN = "https://kind.krx.co.kr"

# 번들에서 뽑을 것 세 가지. 확장자를 전제하지 않는다(2026-09-11 교훈).
_API_RE = re.compile(r"""['"`](/api/[\w./${}-]{2,90})['"`]""")
_DO_RE = re.compile(r"""['"`]([\w./-]{2,80}\.do)['"`]""")
_METHOD_RE = re.compile(r"""['"`](search[A-Za-z]{3,40})['"`]""")
_UNICODE_ESC_RE = re.compile(r"\\u([0-9a-fA-F]{4})")

# 자기주식 화면을 가리킬 조각. 한글은 이스케이프를 푼 뒤에 찾는다.
_OWN_HINTS_H = (
    "자기주식", "자사주", "신청내역", "체결내역",
    "tsstk", "ownstk", "ownstock", "acqu", "trtstk", "trust",
)

_BUNDLE_LIMIT = 80


def _unescape_js(text: str) -> str:
    """`\\uXXXX`를 실제 글자로. 이걸 안 하면 번들에서 한글이 영영 안 걸린다."""
    return _UNICODE_ESC_RE.sub(lambda m: chr(int(m.group(1), 16)), text)


def _collect_scripts(url: str) -> tuple[str, set[str]]:
    text = _fetch_text(url) or ""
    srcs = {urljoin(url, s) for s in _SCRIPT_SRC_RE.findall(text)}
    # SPA는 번들 안에서 청크를 또 부른다. 정적 경로로 보이는 .js도 후보로 넣는다.
    for path in re.findall(r"""['"`](/[\w./-]{2,90}\.js)['"`]""", text):
        srcs.add(urljoin(url, path))
    return text, srcs


def _probe_kind_bundles() -> None:
    print("\n[H] KIND SPA 번들 해부 — 메뉴에 없는 화면 주소 찾기", flush=True)

    scripts: set[str] = set()
    for label, url in _KIND_PAGES:
        text, srcs = _collect_scripts(url)
        print(f"  · {label}: {len(text):,}자, script {len(srcs)}개", flush=True)
        scripts |= srcs

    apis: set[str] = set()
    dos: set[str] = set()
    methods: set[str] = set()
    hit_shown = 0

    seen: set[str] = set()
    queue = sorted(scripts)
    while queue and len(seen) < _BUNDLE_LIMIT:
        script_url = queue.pop(0)
        if script_url in seen:
            continue
        seen.add(script_url)
        raw = _fetch_text(script_url)
        if raw is None:
            continue
        text = _unescape_js(raw)

        found_api = set(_API_RE.findall(text))
        found_do = set(_DO_RE.findall(text))
        found_method = set(_METHOD_RE.findall(text))
        apis |= found_api
        dos |= found_do
        methods |= found_method

        # 번들이 또 부르는 청크를 따라간다 — 라우트별 코드가 거기 있다.
        for chunk in re.findall(r"""['"`](/[\w./-]{2,90}\.js)['"`]""", raw):
            nxt = urljoin(script_url, chunk)
            if nxt not in seen:
                queue.append(nxt)

        hints = [h for h in _OWN_HINTS_H if h in text.lower() or h in text]
        if hints:
            print(
                f"  ! {script_url.rsplit('/', 1)[-1]} ({len(text):,}자) 힌트={hints}",
                flush=True,
            )
            for hint in hints[:3]:
                idx = text.find(hint)
                if idx < 0:
                    idx = text.lower().find(hint)
                print(f"      …{text[max(0, idx-400):idx+400]}…", flush=True)
                hit_shown += 1

    print(f"\n  o 번들 {len(seen)}개 확인", flush=True)
    print(f"  o /api 경로 {len(apis)}개: {sorted(apis)[:60]}", flush=True)
    print(f"  o .do 경로 {len(dos)}개: {sorted(dos)[:60]}", flush=True)
    print(f"  o method 후보 {len(methods)}개: {sorted(methods)[:60]}", flush=True)
    if not hit_shown:
        print("  - 자기주식 힌트 0건 — 번들이 라우트별로 쪼개져 있고 그 청크를 못 따라갔다는 뜻", flush=True)

    # 찾은 /api 경로를 실제로 두드려 본다. 어떤 게 JSON을 주는지가 다음 단계의 출발점.
    print("\n  — 찾은 /api 경로 실제 호출 —", flush=True)
    for path in sorted(apis)[:40]:
        if "$" in path or "{" in path:
            print(f"    ~ {path} (자리표시자 있음, 건너뜀)", flush=True)
            continue
        url = urljoin(_KIND_ORIGIN, path)
        try:
            resp = requests.get(url, headers=_KIND_HEADERS, timeout=20)
        except Exception as exc:  # noqa: BLE001
            print(f"    x {path}: {exc}", flush=True)
            continue
        body = (resp.text or "")[:200].replace("\n", " ")
        print(
            f"    {resp.status_code} {resp.headers.get('Content-Type', '?')[:40]} {path} → {body!r}",
            flush=True,
        )

# ---------------------------------------------------------------------------
# [I] PC KIND 정식 입구 — 메뉴 HTML에 전체 화면 목록이 있다
# ---------------------------------------------------------------------------
#
# [H]까지의 실측으로 갈래가 갈렸다(2026-09-11).
#
# - `kind.krx.co.kr/` 루트는 **UserAgent 분기 스크립트**만 준다(2,149자).
# - `main.do`를 파라미터 없이 부르면 **"페이지 오류"**다(1,472자). 404가 아니라
#   200이라 "살아 있다"고 착각하기 쉬운데, 실제로는 안내 페이지다.
# - 반면 **모바일(mkind)은 살아 있다** — `/main`이 29,682자를 주고 거기서
#   `/disclosures-today` 같은 라우트와 `/api/...` 11개가 나왔다.
#
# 그래서 PC KIND는 **파라미터를 줘야 여는 구형 JSP 앱**이라고 보는 게 맞다
# (`.do?method=...`). 이게 사실이라면 **메뉴 HTML에 전체 화면 목록이 그대로
# 들어 있다** — SPA와 달리 서버가 다 그려서 주기 때문이다. 그러면 메뉴에
# 노출되지 않는 자기주식 화면도 링크로는 남아 있을 가능성이 높다.
_PC_ENTRIES = [
    ("메인(초기화)", "https://kind.krx.co.kr/main.do?method=loadInitPage"),
    ("오늘의 공시", "https://kind.krx.co.kr/disclosure/todaydisclosure.do?method=searchTodayDisclosureMain"),
    ("공시 상세검색", "https://kind.krx.co.kr/disclosure/details.do?method=searchDetailsMain"),
    ("전체 통합검색", "https://kind.krx.co.kr/disclosure/searchtotalinfo.do?method=searchTotalInfoMain"),
    ("상장법인 상세", "https://kind.krx.co.kr/corpgeneral/corpList.do?method=loadInitPage"),
    # 모바일은 살아 있는 게 확인됐으니 라우트를 이어서 판다.
    ("모바일 오늘공시", "https://mkind.krx.co.kr/disclosures-today"),
]

# `.do` 링크와 붙어 있는 method 값을 짝지어 뽑는다. 구형 KIND는 이 둘이
# 한 세트라서 경로만 알아도 못 연다.
_DO_LINK_RE = re.compile(r"""([\w./-]+\.do)\?([^'"\s>]{0,200})""")
_PC_HINTS = ("자기주식", "자사주", "신청", "체결", "취득", "처분")


def _probe_kind_pc_menu() -> None:
    print("\n[I] PC KIND 정식 입구 — 메뉴 HTML에서 자기주식 화면 찾기", flush=True)

    all_links: dict[str, set[str]] = {}

    for label, url in _PC_ENTRIES:
        text = _fetch_text(url)
        if text is None:
            continue
        is_error = "페이지 오류" in text
        hits = [h for h in _PC_HINTS if h in text]
        print(
            f"  · {label}: {len(text):,}자 {'[페이지 오류]' if is_error else ''} 힌트={hits or '없음'}",
            flush=True,
        )
        if is_error:
            continue

        for path, query in _DO_LINK_RE.findall(text):
            all_links.setdefault(path, set()).add(query[:120])

        # 자기주식 관련 글자 주변을 통째로 찍는다 — 링크·onclick이 거기 붙어 있다.
        for hint in hits[:2]:
            idx = text.find(hint)
            print(f"      '{hint}' 주변: {text[max(0, idx-500):idx+500]!r}", flush=True)

    print(f"\n  o .do 링크 {len(all_links)}개", flush=True)
    for path, queries in sorted(all_links.items()):
        print(f"    - {path}  ← {sorted(queries)[:4]}", flush=True)

    own = {p: q for p, q in all_links.items() if any(k in p.lower() for k in _OWN_HINTS_H)}
    print(f"  o 자기주식으로 보이는 경로: {own or '없음'}", flush=True)

# ---------------------------------------------------------------------------
# [J] 접수번호(acptNo)에서 출발한다 — 사용자가 실제로 열리는 주소를 줬다
# ---------------------------------------------------------------------------
#
# 2026-09-11, 사용자가 이 주소에서 자기주식매매 내역이 보인다고 알려줬다:
#
#   kind.krx.co.kr/common/disclsviewer.do?method=searchInitInfo&acptNo=20260826000780
#
# 여기서 두 가지가 바로 읽힌다.
#
# 1. **PC KIND는 살아 있다.** 다만 `?method=`를 줘야 열린다 — `main.do`를
#    맨손으로 불러 '페이지 오류'를 받고 "막혔다"고 결론 낸 게 틀렸던 것이다.
# 2. **접수번호가 `YYYYMMDD`+일련번호 6자리다.** 20260826 + 000780.
#    이건 DART의 `rcept_no`와 **같은 형식**이다.
#
# 2번이 핵심이다. 형식만 같은 게 아니라 **같은 번호 체계라면**, 지금 쓰는
# DART_API_KEY로 `document.xml?rcept_no=...`를 불러 원문을 그대로 받을 수 있다
# (이 경로는 2026-09-10 프로브에서 이미 응답을 확인했다). 그러면 KIND를
# 뚫을 필요 자체가 없어진다.
#
# 그리고 앞선 "DART에는 없다"는 결론도 다시 봐야 한다. 그때는 필터 없이
# 목록을 받았다고 생각했지만, DART `list.json`에는 **공시유형(`pblntf_ty`)**이
# 있고 **`I`가 거래소공시**다. 기본 목록이 거래소공시를 빼고 준다면 자기주식
# 매매내역은 애초에 보이지 않았을 것이다. 그래서 여기서 `I`를 명시해 다시 묻는다.
#
# 날짜마다 훑는 방법(사용자 제안)은 마지막 수단으로 남긴다 — 일련번호가
# 6자리라 날짜당 최대 100만 번이라 그대로는 못 쓴다. **목록을 주는 경로를
# 찾는 게 먼저다.**
_USER_ACPT_NO = "20260826000780"


def _probe_acptno() -> None:
    print("\n[J] 접수번호에서 출발 — KIND acptNo가 DART rcept_no와 같은가", flush=True)

    key = _api_key()
    if not key:
        print("  - DART_API_KEY 없음 — 건너뜀", flush=True)
        return

    # J1. 사용자가 준 접수번호를 DART 원문 API에 그대로 넣어 본다.
    #     성공하면 KIND를 뚫을 필요가 없다.
    print(f"  · DART document.xml ← acptNo {_USER_ACPT_NO}", flush=True)
    try:
        resp = requests.get(
            _DOCUMENT_URL,
            params={"crtfc_key": key, "rcept_no": _USER_ACPT_NO},
            timeout=TIMEOUT,
        )
        ctype = resp.headers.get("Content-Type", "?")
        print(f"      {resp.status_code} {ctype} {len(resp.content):,}바이트", flush=True)
        if "xml" in ctype and len(resp.content) < 2000:
            # 에러는 XML 한 줄로 온다(status/message).
            print(f"      본문: {resp.text[:400]!r}", flush=True)
        else:
            with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                for name in zf.namelist():
                    raw = zf.read(name)
                    text = raw.decode("utf-8", errors="replace")
                    print(f"      · {name}: {len(text):,}자", flush=True)
                    for hint in ("자기주식", "체결", "신청", "수량"):
                        idx = text.find(hint)
                        if idx >= 0:
                            print(f"          '{hint}' 주변: {text[max(0, idx-200):idx+300]!r}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"      x {exc}", flush=True)

    # J2. 거래소공시(pblntf_ty=I)를 명시해서 목록을 다시 받는다.
    #     "DART에 없다"던 결론이 필터 탓이었는지 확인하는 자리다.
    corp_codes = load_corp_codes()
    begin = (date.today() - timedelta(days=30)).strftime("%Y%m%d")
    today = date.today().strftime("%Y%m%d")
    for code, name in _SAMPLES:
        corp = corp_codes.get(code)
        if not corp:
            print(f"  - {name}({code}): corp_code 없음", flush=True)
            continue
        for ty, label in (("I", "거래소공시"), (None, "전체")):
            params = {
                "crtfc_key": key,
                "corp_code": corp,
                "bgn_de": begin,
                "end_de": today,
                "page_count": 100,
            }
            if ty:
                params["pblntf_ty"] = ty
            try:
                payload = _dart_get("list", params)
            except Exception as exc:  # noqa: BLE001
                print(f"  x {name} {label}: {exc}", flush=True)
                continue
            rows = payload.get("list") or []
            print(f"  · {name} {label}: {payload.get('status')} {len(rows)}건", flush=True)
            for row in rows[:25]:
                print(f"      {row.get('rcept_no')} {row.get('rcept_dt')} | {row.get('report_nm')}", flush=True)

    # J3. KIND 뷰어 자체도 두드린다. 열리면 본문을 어디서 가져오는지가 보인다.
    viewer = (
        "https://kind.krx.co.kr/common/disclsviewer.do"
        f"?method=searchInitInfo&acptNo={_USER_ACPT_NO}"
    )
    text = _fetch_text(viewer)
    if text is None:
        return
    print(f"  · KIND 뷰어: {len(text):,}자 ('페이지 오류' {'있음' if '페이지 오류' in text else '없음'})", flush=True)
    for hint in ("자기주식", "acptNo", "docNo", "viewer", "searchContents"):
        idx = text.find(hint)
        if idx >= 0:
            print(f"      '{hint}' 주변: {text[max(0, idx-300):idx+300]!r}", flush=True)

if __name__ == "__main__":
    sys.exit(main())
