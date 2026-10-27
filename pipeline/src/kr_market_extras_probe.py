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

from . import consensus as consensus_mod
from . import investor_flow as flow_mod

# 삼성전자·SK하이닉스는 어떤 소스에도 반드시 있어야 하는 종목이다. 여기서 빈다면
# 그 종목이 특이한 게 아니라 소스가 막힌 것이다.
_SAMPLES = [("005930", "삼성전자"), ("000660", "SK하이닉스")]


def _probe_flow() -> tuple[bool, dict[str, float]]:
    """(정상 여부, 종목별 최신 종가). 종가는 컨센서스 검산에 쓴다."""
    print("\n[1/2] 수급 (외국인·기관 순매매)", flush=True)
    ok = False
    closes: dict[str, float] = {}
    for ticker, name in _SAMPLES:
        try:
            rows, source = flow_mod.fetch_investor_flow(ticker)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            continue
        latest = rows[0] if rows else {}
        if latest.get("close"):
            closes[ticker] = float(latest["close"])
        print(
            f"  o {name}({ticker}): {len(rows)}행, 소스={source}, "
            f"최근={latest.get('date')} 종가={latest.get('close')} "
            f"외국인={latest.get('foreign_net_qty')} 기관={latest.get('institution_net_qty')}",
            flush=True,
        )
        ok = True
    return ok, closes


# 현재가 대비 배수는 **참고로만 찍고 판정에는 안 쓴다**(2026-10-27 변경).
#
# 예전엔 2.0배를 넘으면 "엉뚱한 칸을 읽었다"로 보고 빨간불을 켰다. 그런데 배수는
# 파싱이 맞았는지와 아무 상관이 없는 숫자다 — 주가가 빠지면 목표가가 그대로여도
# 배수는 커진다. 실제로 삼성전자 492,500원(2.31배) · SK하이닉스 3,248,636원
# (2.52배)이 **둘 다 맞는 값인데** 빨간불이 떴고, 그대로 두면 매번 빨간 프로브가
# 돼서 아무도 안 보게 된다(못 잡는 것보다 나쁘다).
#
# 지금은 같은 페이지의 **개별 증권사 목표가**와 대조한다(`broker_targets`).
# 평균이 그 최소~최대 범위 밖이면 그건 평균이 아니라 다른 칸이다 — 셀 오독을
# 정확히 겨냥하면서 멀쩡한 값에는 절대 안 울린다.
_RATIO_NOTE_HIGH = 2.0  # 이 위면 "많이 빠졌거나 확인해 볼 만하다"고 한 줄 덧붙인다


def _probe_consensus(closes: dict[str, float]) -> bool:
    print("\n[2/2] 목표주가 컨센서스", flush=True)
    ok = True
    for ticker, name in _SAMPLES:
        try:
            data, source = consensus_mod.fetch_consensus(ticker)
        except Exception as exc:  # noqa: BLE001
            print(f"  x {name}({ticker}): {exc}", flush=True)
            for line in consensus_mod.describe_sources(ticker):
                print(line, flush=True)
            ok = False
            continue

        # 표 구조는 성공했을 때도 찍는다. "숫자이고 범위 안"이라는 이유로 엉뚱한
        # 칸을 통과시킨 적이 있어(488,409원 / 의견 '목표주가원'), 값만 봐서는
        # 맞았는지 알 수 없다. 진단 도구이므로 요청 한 번 더 쓰는 편이 낫다.
        for line in consensus_mod.describe_sources(ticker):
            print(line, flush=True)

        close = closes.get(ticker)
        target = data["target_price"]
        ratio = target / close if close else None

        # 검산: 같은 페이지의 증권사별 목표가 범위 안에 평균이 들어오는가.
        brokers = consensus_mod.broker_targets(ticker)
        if brokers:
            low, high = min(brokers), max(brokers)
            suspicious = not (low <= target <= high)
            verdict = (
                f"증권사 {len(brokers)}곳 {low:,.0f}~{high:,.0f} 범위 안"
                if not suspicious
                else f"증권사 {len(brokers)}곳 {low:,.0f}~{high:,.0f} 범위 **밖**"
            )
        else:
            # 못 뽑았으면 "검산 실패"가 아니라 "검산 못 함"이다 — 빨간불을 켜지 않는다.
            suspicious = False
            verdict = "증권사별 목표가를 못 뽑아 검산 생략"

        mark = "!" if suspicious else "o"
        print(
            f"  {mark} {name}({ticker}): 소스={source}, 목표가={target}, "
            f"현재가={close}, 배수={ratio and round(ratio, 2)}, "
            f"의견={data['opinion']}, 리포트수={data['report_count']}",
            flush=True,
        )
        print(f"      검산: {verdict}", flush=True)
        if suspicious:
            print("      → 평균이 개별 목표가 범위를 벗어난다. 다른 칸을 읽고 있다.", flush=True)
            ok = False
        elif ratio is not None and ratio > _RATIO_NOTE_HIGH:
            # 판정은 안 하되 눈에는 띄게 — 주가가 많이 빠졌다는 신호일 수 있다.
            print(
                f"      (참고: 목표가가 현재가의 {ratio:.2f}배다. 값 자체는 검산을 통과했으니"
                " 파싱 문제가 아니라 주가가 많이 빠졌다는 뜻이다.)",
                flush=True,
            )
        # 라벨 문자열이 그대로 값으로 들어왔다면 헤더 칸을 읽은 것이다 — 값의
        # 범위로는 절대 못 잡는 종류의 오류라 따로 본다.
        if data["opinion"] and any(bad in data["opinion"] for bad in ("목표주가", "투자의견", "추정기관")):
            print(f"      → 투자의견이 헤더 텍스트다({data['opinion']!r}). 파싱이 틀렸다.", flush=True)
            ok = False
    return ok


def main() -> int:
    load_dotenv()
    print("국내 부가 데이터 소스 점검 (수급 · 컨센서스)", flush=True)
    flow_ok, closes = _probe_flow()
    results = [flow_ok, _probe_consensus(closes)]
    print(f"\n결과: {sum(results)}/2 소스 정상", flush=True)
    # 하나라도 죽어 있으면 실패로 끝낸다 — 초록불로 끝나면 "다 됐다"로 보인다.
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
