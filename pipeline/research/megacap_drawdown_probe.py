"""초대형주(고점 시총 500조원 이상)가 **지금 하이닉스만큼 빠진 뒤** 얼마나 더 빠졌나.

왜 만들었나 (2026-11-13)
------------------------
`averageDownPlan.ts`의 깊은 사다리(4차 −30~−36%)는 **여러 종목을 섞은 표본**에서
왔다 — 이미 15% 빠진 전 종목 10만 건, 국내 반도체 20종목(대부분 중소형 장비주).
그런데 삼성·하이닉스만 따로 재면 추가 하락이 훨씬 얕았고(−30~−45%에서 중간값
−3.3%), 사용자가 "500조 이상 가는 대형주의 움직임으로 다시 정하라"고 했다.
초대형주는 중소형주와 다르게 움직인다는 가설을 직접 잰다.

조건은 결과를 보기 **전에** 정했다 (숫자를 끼워 맞추지 않으려고)
------------------------------------------------------------------
- 표본: 12개월 고점 시점의 추정 시총이 500조원 이상인 종목
- 질문: 고점 대비 −50~−66%(지금 하이닉스 −58% 언저리)에 처음 들어온 달에서
  그 뒤 4개월·12개월 안에 **한 번이라도** 찍은 최저가(월봉 저가)가 얼마나 더 아래였나
- 사다리: 4개월 창(사이트의 지정가 기한과 같다)의 추가 하락 분포에서
  2차 = 75%가 닿은 자리, 3차 = 절반이 닿은 자리, 4차 = 25%만 닿은 자리
- "설마 80만원까지 오겠냐": 806,000원은 현재가 1,254,000원 대비 −35.7%다.
  같은 깊이에서 그만큼 더 빠진 사례를 센다

과거 시총 추정의 한계
--------------------
과거 시총 = 지금의 유효 주식 수(시총 ÷ 주가) × 분할 조정 종가. 자사주를 많이 사들인
회사(애플·오라클)는 과거 주식 수가 더 많았으므로 **과소** 추정되고(표본에서 빠질 수
있다 — 보수적인 쪽), 주식을 찍어낸 회사는 **과대** 추정된다. 금융위기 때 주식을 몇
배로 늘린 씨티·AIG·뱅크오브아메리카는 과거 시총이 몇 배 부풀려지므로 아예 뺐다.
상장폐지된 회사(루슨트·노텔 등)는 야후에 없어 빠진다 — **생존 편향이 남는다.**
"""
from __future__ import annotations

import math
from datetime import date

import pandas as pd

THRESHOLD_KRW = 500e12          # 500조원
NOW_PRICE = 1_254_000           # 하이닉스 11/12 종가
STOP_PRICE = 806_000            # 사이트의 멈춤선(3월 저가)
STOP_PCT = STOP_PRICE / NOW_PRICE - 1   # −35.7%
BAND = (-0.66, -0.50)           # 지금 깊이(−58%) ±8%p
HIGH_W = 12
DEADLINE_M = 4                  # 사이트의 지정가 기한(오늘 + 4개월)
COOLDOWN_M = 12
START = "1995-01-01"

US = [
    # 지금의 초대형주
    "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "AVGO", "TSLA", "BRK-B", "ORCL",
    "JPM", "WMT", "LLY", "V", "MA", "NFLX", "XOM", "COST", "JNJ", "HD", "PG", "UNH",
    "ABBV", "KO", "CVX", "PLTR", "AMD", "MU", "TSM", "ASML", "NVO", "TM", "SAP",
    # 예전에 초대형주였던 종목 (생존 편향을 조금이라도 줄이려고)
    "CSCO", "INTC", "IBM", "GE", "PFE", "MRK", "WFC", "PYPL", "BABA", "TCEHY", "NOK", "VOD", "QCOM",
]
KR = {"005930.KS": "삼성전자", "000660.KS": "SK하이닉스"}
EXCLUDED = {"C": "씨티", "AIG": "AIG", "BAC": "뱅크오브아메리카"}


def q(xs: list[float], p: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    k = (len(s) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def fetch(ticker: str):
    import yfinance as yf
    t = yf.Ticker(ticker)
    h = t.history(start=START, interval="1mo", auto_adjust=False)
    if h is None or h.empty:
        return None, None
    h = h[["High", "Low", "Close"]].dropna()
    h.index = pd.to_datetime(h.index).tz_localize(None).to_period("M").to_timestamp()
    h = h[~h.index.duplicated(keep="last")]
    # fast_info는 속성으로 읽는다. dict처럼 `.get("market_cap")`을 쓰면 키 이름이
    # 달라(camelCase) 조용히 None이 나온다 — 첫 실행에서 전 종목이 그렇게 빠졌다.
    fi = t.fast_info
    try:
        cap, last = fi.market_cap, fi.last_price
    except Exception:  # noqa: BLE001
        cap, last = None, None
    if not cap or not last:
        return h, None
    return h, cap / last   # 유효 주식 수


def main() -> None:
    import yfinance as yf

    fx = float(yf.Ticker("KRW=X").history(period="5d")["Close"].dropna().iloc[-1])
    thr_usd = THRESHOLD_KRW / fx
    print(f"원달러 {fx:,.0f} → 500조원 = ${thr_usd/1e9:,.0f}B")
    print(f"제외: {', '.join(f'{k}({v})' for k, v in EXCLUDED.items())} — 금융위기 증자로 과거 시총 추정 불가")
    print(f"하이닉스 현재가 {NOW_PRICE:,} · 멈춤선 {STOP_PRICE:,} = {STOP_PCT*100:+.1f}%\n")

    data: dict[str, tuple[pd.DataFrame, float, float, str]] = {}
    for tk in US + list(KR):
        try:
            h, sh = fetch(tk)
        except Exception as e:  # noqa: BLE001
            print(f"  {tk}: 실패 {type(e).__name__}: {e}")
            continue
        if h is None or len(h) < 30:
            print(f"  {tk}: 월봉 부족 ({0 if h is None else len(h)}개)")
            continue
        if sh is None:
            print(f"  {tk}: 시총을 못 읽음 — 과거 시총을 추정할 수 없어 제외")
            continue
        thr = THRESHOLD_KRW if tk in KR else thr_usd
        unit = "원" if tk in KR else "$"
        data[tk] = (h, sh, thr, unit)
    print(f"수집 {len(data)}종목\n")

    # 하이닉스 지금 깊이(종가 기준) 자기 점검
    if "000660.KS" in data:
        h = data["000660.KS"][0]
        c = h["Close"].to_list()
        hi = max(c[-HIGH_W:])
        print(f"하이닉스 12개월 최고 종가(월말) {hi:,.0f} → 최근 월말 {c[-1]:,.0f} = {(c[-1]/hi-1)*100:+.1f}%\n")

    eps: list[dict] = []
    for tk, (h, sh, thr, unit) in data.items():
        c, lo = h["Close"].to_list(), h["Low"].to_list()
        idx = list(h.index)
        last_i = -10**9
        for i in range(HIGH_W, len(c)):
            win = c[i - HIGH_W : i + 1]
            hi = max(win)
            hi_i = i - HIGH_W + win.index(hi)
            dd = c[i] / hi - 1
            if not (BAND[0] <= dd <= BAND[1]):
                continue
            if i - last_i < COOLDOWN_M:
                continue
            peak_cap = hi * sh
            if peak_cap < thr:
                continue
            last_i = i
            fwd = {}
            for m in (DEADLINE_M, 12):
                if i + m < len(c):
                    fwd[m] = min(lo[i + 1 : i + 1 + m]) / c[i] - 1
            ret = {m: (c[i + m] / c[i] - 1) if i + m < len(c) else None for m in (12, 24)}
            eps.append({
                "tk": tk, "month": idx[i].strftime("%Y-%m"), "peak": idx[hi_i].strftime("%Y-%m"),
                "dd": dd, "peak_cap": peak_cap, "cap_now": c[i] * sh, "thr": thr, "unit": unit,
                "f4": fwd.get(DEADLINE_M), "f12": fwd.get(12), "r12": ret[12], "r24": ret[24],
                "i": i, "c": c, "lo": lo,
            })

    print("=" * 100)
    print(f"고점 시총 500조원 이상 · 고점 대비 {BAND[1]*100:.0f}~{BAND[0]*100:.0f}% 에 처음 들어온 달 (같은 종목 {COOLDOWN_M}개월 쿨다운)")
    print("=" * 100)
    def cap(v, unit):
        return f"{v/1e12:,.0f}조원" if unit == "원" else f"${v/1e9:,.0f}B"
    def pct(v):
        return "   —  " if v is None else f"{v*100:+6.1f}%"
    print(f"{'종목':10s} {'진입월':8s} {'고점월':8s} {'깊이':>7s} {'고점시총':>10s} {'그때시총':>10s} | {'4개월내최저':>9s} {'12개월내최저':>10s} | {'12개월뒤':>8s} {'24개월뒤':>8s}")
    for e in sorted(eps, key=lambda e: e["month"]):
        print(f"{e['tk']:10s} {e['month']:8s} {e['peak']:8s} {e['dd']*100:+6.1f}% {cap(e['peak_cap'], e['unit']):>10s} {cap(e['cap_now'], e['unit']):>10s} | "
              f"{pct(e['f4']):>9s} {pct(e['f12']):>10s} | {pct(e['r12']):>8s} {pct(e['r24']):>8s}")

    def summary(name: str, rows: list[dict]) -> None:
        f4 = [e["f4"] for e in rows if e["f4"] is not None]
        f12 = [e["f12"] for e in rows if e["f12"] is not None]
        r12 = [e["r12"] for e in rows if e["r12"] is not None]
        r24 = [e["r24"] for e in rows if e["r24"] is not None]
        print(f"\n▶ {name}: {len(rows)}건 ({len({e['tk'] for e in rows})}종목)")
        if f4:
            print(f"  4개월 안 추가 하락:  75%가 닿음 {q(f4,.75)*100:+.1f}% · 절반 {q(f4,.5)*100:+.1f}% · 25%만 {q(f4,.25)*100:+.1f}% · 최악 {min(f4)*100:+.1f}%")
        if f12:
            print(f"  12개월 안 추가 하락: 75%가 닿음 {q(f12,.75)*100:+.1f}% · 절반 {q(f12,.5)*100:+.1f}% · 25%만 {q(f12,.25)*100:+.1f}% · 최악 {min(f12)*100:+.1f}%")
            hit = sum(1 for v in f12 if v <= STOP_PCT)
            hit4 = sum(1 for v in f4 if v <= STOP_PCT)
            print(f"  멈춤선({STOP_PCT*100:+.1f}%)까지 더 빠진 사례: 4개월 안 {hit4}/{len(f4)}건 · 12개월 안 {hit}/{len(f12)}건")
        if r12:
            print(f"  그냥 들고: 12개월 중간값 {q(r12,.5)*100:+.1f}% (플러스 {sum(r>0 for r in r12)}/{len(r12)}) · 24개월 중간값 {q(r24,.5)*100:+.1f}% (플러스 {sum(r>0 for r in r24)}/{len(r24)})" if r24 else
                  f"  그냥 들고: 12개월 중간값 {q(r12,.5)*100:+.1f}%")

    summary("전체", eps)
    tech = {"AAPL","MSFT","NVDA","GOOGL","AMZN","META","AVGO","TSLA","ORCL","NFLX","PLTR","AMD","MU","TSM","ASML","SAP","CSCO","INTC","IBM","PYPL","BABA","TCEHY","NOK","QCOM","005930.KS","000660.KS"}
    summary("기술주만", [e for e in eps if e["tk"] in tech])
    summary("2008년 이후만 (닷컴 제외)", [e for e in eps if e["month"] >= "2008-01"])

    # ── 사다리 도출 (규칙은 위 docstring대로, 결과 보기 전에 정함) ──
    f4 = [e["f4"] for e in eps if e["f4"] is not None]
    if len(f4) >= 5:
        r2, r3, r4 = q(f4, .75), q(f4, .5), q(f4, .25)
        r4 = max(r4, STOP_PCT + 0.01)   # 멈춤선 아래에 칸을 두지 않는다
        print("\n" + "=" * 100)
        print("사다리 (4개월 창 분포에서 도출)")
        print("=" * 100)
        for name, off in (("2차 (75%가 닿음)", r2), ("3차 (절반이 닿음)", r3), ("4차 (25%만 닿음)", r4)):
            print(f"  {name}: {off*100:+.1f}% → {NOW_PRICE*(1+off):,.0f}원")

        # ── 사이트 규칙 그대로 되돌려 돌리기 ──
        # 1차 진입월 종가, 2~4차 지정가(월봉 저가로 체결 판정), 종가가 멈춤선(−35.7%)을
        # 깨면 남은 주문 취소(현금 그대로), 4개월째 말까지 안 걸린 칸은 그 달 종가로 산다.
        offs = [0.0, r2, r3, r4]
        weights = {
            "한 번에 다 사기": [1, 0, 0, 0],
            "균등 25/25/25/25": [.25, .25, .25, .25],
            "앞에 싣기 40/25/20/15": [.40, .25, .20, .15],
            "절반 먼저 50/25/15/10": [.50, .25, .15, .10],
            "뒤에 싣기 15/20/25/40": [.15, .20, .25, .40],
        }
        print("\n  사이트 규칙으로 되돌려 돌린 성적 (예산 100, 안 쓴 돈은 이자 0)")
        for H in (12, 24):
            print(f"\n  [{H}개월 뒤]")
            for wname, ws in weights.items():
                res = []
                for e in eps:
                    i, c, lo = e["i"], e["c"], e["lo"]
                    if i + max(H, DEADLINE_M) >= len(c):
                        continue
                    p0 = c[i]
                    stop = p0 * (1 + STOP_PCT)
                    shares, cash = ws[0] / p0, 1 - ws[0]
                    open_ = [(p0 * (1 + o), w) for o, w in zip(offs[1:], ws[1:]) if w > 0]
                    stopped = False
                    for m in range(1, DEADLINE_M + 1):
                        if stopped:
                            break
                        still = []
                        for px, w in open_:
                            if lo[i + m] <= px:
                                shares += w / px
                                cash -= w
                            else:
                                still.append((px, w))
                        open_ = still
                        if c[i + m] < stop:
                            stopped = True
                            open_ = []
                    if not stopped:
                        for _, w in open_:
                            shares += w / c[i + DEADLINE_M]
                            cash -= w
                    res.append(shares * c[i + H] + cash - 1)
                if res:
                    print(f"    {wname:22s} 중간값 {q(res,.5)*100:+7.1f}% · 나쁜 25% {q(res,.25)*100:+7.1f}% · 최악 {min(res)*100:+7.1f}% · 플러스 {sum(r>0 for r in res)}/{len(res)}")

    print("\n※ 상장폐지 종목은 야후에 없어 빠진다(생존 편향). 과거 시총은 추정치다.")


if __name__ == "__main__":
    main()
