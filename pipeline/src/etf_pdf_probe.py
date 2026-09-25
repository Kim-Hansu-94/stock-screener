"""490590 **전체** 구성종목(PDF) 소스 탐색 프로브.

왜 또 프로브인가 (2026-09-25)
----------------------------
네이버 `etfTop10MajorConstituentAssets`로 자동 수집을 붙였는데, 사용자가 증권사 앱
화면을 보내 주면서 **그 목록이 반쪽짜리**임이 드러났다.

  · 네이버가 주는 10개는 **비중 순이 아니라 주식 수 순**이다.
  · 그래서 주가가 비싼 종목이 통째로 빠진다 — AMD($629)·MU($1,080)·META($778)·
    TSM($451)·AVGO($350)·MSFT($498). 이 여섯이 **ETF의 24.82%**다.
  · 네이버가 덮는 건 64.31%뿐이고, 실제 미국 개별주는 15종목 89.13%다.

비중 계산(`주식 수 × 주가`) 자체는 맞았다 — 사용자 실측과 대조하니 6종목 전부 같은
배율(≈0.52)로 일치했다. **틀린 건 계산이 아니라 목록이다.** 그래서 목록을 통째로 주는
소스를 찾는다.

찾는 것은 ETF의 **PDF(Portfolio Deposit File, 납입자산구성내역)**다 — 운용사가 매일
공시하는 전체 보유 내역이고, 증권사 앱 화면이 보여주는 것도 이것이다.

trstk.py에서 배운 것을 그대로 적용한다: **400과 404는 다르다**(400이면 주소는 맞고
조건만 모르는 것), 세션·Referer를 맞춘다, 천천히 두드린다.
"""

from __future__ import annotations

import json
from typing import Any

import requests

ETF_CODE = "490590"
ETF_ISU = "KR7490590003"  # 표준코드 추정 — 틀리면 응답이 비어서 바로 드러난다

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}
_TIMEOUT = 20


def _preview(payload: Any, limit: int = 700) -> str:
    text = json.dumps(payload, ensure_ascii=False) if not isinstance(payload, str) else payload
    return text[:limit] + ("..." if len(text) > limit else "")


def _rows(payload: Any) -> list[dict]:
    """응답 어디에 있든 '딕셔너리들의 리스트' 중 가장 긴 것. 감싸는 키를 고정하지 않는다."""
    best: list[dict] = []
    stack = [payload]
    while stack:
        node = stack.pop()
        if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
            if len(node) > len(best):
                best = node
        if isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return best


def probe_krx_pdf(session: requests.Session) -> None:
    """KRX 정보데이터시스템의 ETF 구성종목(PDF) 통계.

    CLAUDE.md 기록: `getJsonData.cmd`는 세션 없이 부르면 400 "LOGOUT"이 온다.
    그래서 화면을 먼저 열어 쿠키를 받고, Referer를 그 화면으로 맞춘다.
    """
    print(f"\n{'─' * 78}\n▶ KRX 정보데이터시스템 ETF PDF", flush=True)
    base = "https://data.krx.co.kr"
    try:
        warm = session.get(
            f"{base}/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201040104",
            headers=_UA, timeout=_TIMEOUT,
        )
        print(f"  세션 준비: status={warm.status_code} · 쿠키 {len(session.cookies)}개", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ 세션 준비 실패: {type(exc).__name__}: {exc}", flush=True)
        return

    # ETF 구성종목(PDF) 통계 bld 후보. 하나만 맞으면 된다.
    candidates = [
        "dbms/MDC/STAT/standard/MDCSTAT04601",
        "dbms/MDC/STAT/standard/MDCSTAT04701",
        "dbms/MDC/STAT/standard/MDCSTAT05001",
    ]
    url = f"{base}/comm/bldAttendant/getJsonData.cmd"
    headers = {
        **_UA,
        "Referer": f"{base}/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201040104",
        "X-Requested-With": "XMLHttpRequest",
    }
    for bld in candidates:
        data = {
            "bld": bld,
            "locale": "ko_KR",
            "isuCd": ETF_ISU,
            "isuCd2": ETF_ISU,
            "tboxisuCd_finder_secuprodisu1_0": f"{ETF_CODE}/RISE",
            "codeNmisuCd_finder_secuprodisu1_0": "RISE 미국AI밸류체인데일리고정커버드콜",
            "param1isuCd_finder_secuprodisu1_0": "",
            "trdDd": "",
            "share": "1",
            "money": "1",
            "csvxls_isNo": "false",
        }
        try:
            resp = session.post(url, data=data, headers=headers, timeout=_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{bld}] ✗ 요청 실패: {type(exc).__name__}: {exc}", flush=True)
            continue
        print(f"  [{bld}] status={resp.status_code} · {len(resp.text):,}자", flush=True)
        try:
            payload = resp.json()
        except ValueError:
            print(f"      JSON 아님: {_preview(resp.text, 200)}", flush=True)
            continue
        rows = _rows(payload)
        if rows:
            print(f"      ★ {len(rows)}행 — 첫 두 행:", flush=True)
            for row in rows[:2]:
                print(f"        {_preview(row, 400)}", flush=True)
        else:
            print(f"      행 없음: {_preview(payload, 300)}", flush=True)


def probe_naver_full(session: requests.Session) -> None:
    """네이버에 상위 10개 말고 **전체**를 주는 경로가 따로 있는지 본다.

    CLAUDE.md 원칙대로 네이버부터 확인한다 — 여기서 되면 새 소스를 붙일 필요가 없다.
    """
    print(f"\n{'─' * 78}\n▶ 네이버 — 전체 구성 경로가 따로 있는가", flush=True)
    for label, url in [
        ("etf/{code}/constituent", f"https://api.stock.naver.com/etf/{ETF_CODE}/constituent"),
        ("stock/{code}/etfPdf", f"https://m.stock.naver.com/api/stock/{ETF_CODE}/etfPdf"),
        ("stock/{code}/etfConstituent", f"https://m.stock.naver.com/api/stock/{ETF_CODE}/etfConstituent"),
    ]:
        try:
            resp = session.get(url, headers={**_UA, "Referer": "https://m.stock.naver.com/"}, timeout=_TIMEOUT)
        except Exception as exc:  # noqa: BLE001
            print(f"  [{label}] ✗ {type(exc).__name__}: {exc}", flush=True)
            continue
        print(f"  [{label}] status={resp.status_code} · {len(resp.text):,}자", flush=True)
        if resp.status_code == 400:
            print("      ⓘ 400 = 주소는 맞고 파라미터만 틀렸을 가능성", flush=True)
        if resp.status_code == 200:
            try:
                rows = _rows(resp.json())
                print(f"      ★ {len(rows)}행 · {_preview(rows[:2], 400) if rows else ''}", flush=True)
            except ValueError:
                print(f"      JSON 아님: {_preview(resp.text, 200)}", flush=True)



def probe_kis(session: requests.Session) -> None:
    """한국투자증권 KIS OpenAPI에 ETF 구성종목 경로가 있는지.

    **키가 이미 등록돼 있다**(미장 일봉·시총에 쓰는 그 키, `kis_auth.py`). 증권사
    앱이 보여주는 화면이 바로 이 계열의 데이터라, 전체 구성과 **비중까지** 줄
    가능성이 가장 높은 후보다.

    tr_id·경로는 **추측이므로 판정하지 않고 응답을 그대로 찍는다** — KIS는 틀린
    tr_id에 200 + `rt_cd != '0'` + 한글 사유를 주므로, 본문을 봐야 무엇이 틀렸는지
    알 수 있다(상태코드만 보면 전부 성공으로 보인다).
    """
    print(f"\n{'─' * 78}\n▶ 한국투자증권 KIS OpenAPI", flush=True)
    try:
        from .kis_auth import headers as kis_headers
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ 인증 모듈 로드 실패: {type(exc).__name__}: {exc}", flush=True)
        return

    base = "https://openapi.koreainvestment.com:9443"
    candidates = [
        # (설명, 경로, tr_id, 쿼리)
        (
            "ETF 구성종목시세",
            "/uapi/etfetn/v1/quotations/inquire-component-stock-price",
            "FHKST121600C0",
            {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ETF_CODE, "FID_COND_SCR_DIV_CODE": "11216"},
        ),
        (
            "ETF/ETN 현재가",
            "/uapi/etfetn/v1/quotations/inquire-price",
            "FHPST02400000",
            {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ETF_CODE},
        ),
        (
            "국내주식 현재가(대조용 — 키가 살아 있는지)",
            "/uapi/domestic-stock/v1/quotations/inquire-price",
            "FHKST01010100",
            {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": ETF_CODE},
        ),
    ]

    for label, path, tr_id, params in candidates:
        try:
            resp = session.get(
                f"{base}{path}", headers=kis_headers(tr_id), params=params, timeout=_TIMEOUT
            )
        except Exception as exc:  # noqa: BLE001
            print(f"  [{label}] ✗ {type(exc).__name__}: {exc}", flush=True)
            continue
        print(f"  [{label}] tr_id={tr_id} status={resp.status_code} · {len(resp.text):,}자", flush=True)
        try:
            payload = resp.json()
        except ValueError:
            print(f"      JSON 아님: {_preview(resp.text, 200)}", flush=True)
            continue
        # KIS는 실패도 200으로 주고 rt_cd/msg1에 사유를 담는다 — 그게 진짜 판정 근거다.
        print(f"      rt_cd={payload.get('rt_cd')} msg={payload.get('msg1')}", flush=True)
        rows = _rows(payload)
        if rows:
            print(f"      ★ {len(rows)}행 — 첫 두 행(키 이름을 봐야 비중 필드를 찾는다):", flush=True)
            for row in rows[:2]:
                print(f"        {_preview(row, 500)}", flush=True)
        else:
            print(f"      행 없음: {_preview(payload, 300)}", flush=True)


def main() -> None:
    print("490590 전체 구성종목(PDF) 소스 탐색")
    print("네이버 상위10개는 '주식 수 순'이라 비싼 종목이 빠진다 — 전체를 주는 곳을 찾는다.")
    session = requests.Session()
    probe_kis(session)
    probe_naver_full(session)
    probe_krx_pdf(session)
    print(
        f"\n{'─' * 78}\n"
        "판정 기준: 미국 개별주가 **15개 안팎** 나오고 AMD·MU·META·AVGO·MSFT가 있으면 성공이다\n"
        "  (사용자 실측: 15종목 89.13%). 9개만 나오면 네이버 상위10과 같은 반쪽이다.",
    )


if __name__ == "__main__":
    main()
