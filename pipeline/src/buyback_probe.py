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
import sys
from datetime import date, timedelta
import zipfile

import pandas as pd
import requests
from dotenv import load_dotenv

from . import broker_flow
from .buyback import _api_key, _disclosure_list, load_corp_codes
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


def main() -> int:
    load_dotenv()
    print("자사주 실제 매입량 소스 탐색", flush=True)
    _probe_dart_document()
    _probe_broker_windows()
    _probe_broker_parser()
    _probe_krx_broker_history()
    # 탐색 프로브라 성패를 판정하지 않는다 — 출력을 읽고 다음 구현을 정하는 게 목적이다.
    print("\n탐색 완료. 위 출력으로 파싱 대상을 정한다.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
