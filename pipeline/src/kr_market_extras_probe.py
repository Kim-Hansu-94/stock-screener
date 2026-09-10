"""국내 부가 데이터 3종의 소스가 실제로 살아 있는지 두드려 보는 진단.

`python -m src.kr_market_extras_probe` — Supabase 자격증명도, 저장도 없다.
소스별로 "받아졌는지 / 몇 건인지 / 값이 어떤 모양인지"만 찍는다.

작업 컨테이너는 네이버·DART 접속이 막혀 있어 거기서 확인할 수 없다. 그래서
universe_us.py의 Russell 3000 소스와 똑같이, Actions에서 1분 만에 확인하는
경로를 따로 둔다(`.github/workflows/kr_market_extras_probe.yml`).

**응답 키 이름이 예고 없이 바뀌는 내부 API가 섞여 있다.** 그래서 수집 코드는
키를 고정하지 않고 후보 중에서 찾는데(naver_api.find_first), 그게 실제로 맞았는지는
이 프로브의 출력으로만 알 수 있다 — 값이 None으로 나오면 후보 목록에 실제 키를
추가해야 한다는 뜻이다.
"""

from __future__ import annotations

import sys

from dotenv import load_dotenv

from . import buyback as buyback_mod
from . import consensus as consensus_mod
from . import investor_flow as flow_mod

# 삼성전자·SK하이닉스는 어떤 소스에도 반드시 있어야 하는 종목이다. 여기서 빈다면
# 그 종목이 특이한 게 아니라 소스가 막힌 것이다.
_SAMPLES = [("005930", "삼성전자"), ("000660", "SK하이닉스")]


def _probe_flow() -> bool:
    print("\n[1/3] 수급 (외국인·기관 순매매)", flush=True)
    ok = False
    for ticker, name in _SAMPLES:
        try:
            rows, source = flow_mod.fetch_investor_flow(ticker)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            continue
        latest = rows[0] if rows else {}
        print(
            f"  o {name}({ticker}): {len(rows)}행, 소스={source}, "
            f"최근={latest.get('date')} 종가={latest.get('close')} "
            f"외국인={latest.get('foreign_net_qty')} 기관={latest.get('institution_net_qty')}",
            flush=True,
        )
        ok = True
    return ok


def _probe_consensus() -> bool:
    print("\n[2/3] 목표주가 컨센서스", flush=True)
    ok = False
    for ticker, name in _SAMPLES:
        try:
            data, source = consensus_mod.fetch_consensus(ticker)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            # 왜 못 찾았는지(페이지가 막힌 건지·표 구조가 바뀐 건지)까지 찍는다.
            for line in consensus_mod.describe_sources(ticker):
                print(line, flush=True)
            continue
        print(
            f"  o {name}({ticker}): 소스={source}, 목표가={data['target_price']}, "
            f"의견={data['opinion']}, 리포트수={data['report_count']}",
            flush=True,
        )
        ok = True
    return ok


def _probe_buyback() -> bool:
    print("\n[3/3] 자사주 매입 (DART)", flush=True)
    try:
        corp_codes = buyback_mod.load_corp_codes()
    except Exception as exc:  # noqa: BLE001
        print(f"  x corp_code 목록: {exc}", flush=True)
        return False
    print(f"  o corp_code {len(corp_codes)}개 로드", flush=True)

    ok = False
    for ticker, name in _SAMPLES:
        corp_code = corp_codes.get(ticker)
        if not corp_code:
            print(f"  x {name}({ticker}): corp_code 없음", flush=True)
            continue
        try:
            row = buyback_mod.build_row(ticker, name, corp_code)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            continue
        if row is None:
            # 자사주를 안 사는 회사는 정상이다 — 소스가 죽은 것과 구분해서 찍는다.
            print(f"  - {name}({ticker}): 최근 2년 자기주식 공시 없음 (정상일 수 있음)", flush=True)
            ok = True
            continue
        print(
            f"  o {name}({ticker}): {row['latest_report']} ({row['latest_report_date']}), "
            f"공시 {row['disclosure_count']}건, 상세소스={row['detail_source']}, "
            f"금액진행률={row['amount_progress_pct']}, 기간진행률={row['period_progress_pct']}",
            flush=True,
        )
        if row["detail_error"]:
            print(f"      상세 API 실패 사유: {row['detail_error']}", flush=True)
        if row["amount_progress_pct"] is None and row["period_progress_pct"] is None:
            # 공시는 잡혔는데 진행률이 둘 다 비었다 = 상세 응답의 키 이름이 우리
            # 후보와 다르다는 뜻이다. 원본 키를 그대로 찍어 다음 수정 근거로 삼는다.
            for line in buyback_mod.describe_detail(corp_code):
                print(line, flush=True)
        ok = True
    return ok


def main() -> int:
    load_dotenv()
    print("국내 부가 데이터 소스 점검 (수급 · 컨센서스 · 자사주)", flush=True)
    results = [_probe_flow(), _probe_consensus(), _probe_buyback()]
    print(f"\n결과: {sum(results)}/3 소스 정상", flush=True)
    # 하나라도 죽어 있으면 실패로 끝낸다 — 초록불로 끝나면 "다 됐다"로 보인다.
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
