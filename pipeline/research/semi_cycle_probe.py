"""국내 반도체 사이클을 **유니버스 밖 종목까지 직접 받아** 재고, 미국과의 동조를 잰다.

왜 필요한가
-----------
두 가지가 막혀 있었다.

1. **유니버스가 코스피뿐이라** 국내 반도체 소부장(원익IPS·리노공업·이오테크닉스·
   HPSP…)이 DB에 아예 없다. `backtestCycleMonthly.ts`의 국내 반도체가 4종목뿐이었던
   이유다. 사용자 지시: "유니버스에 없으면 이제라도 월봉이라도 가져와서 재분석해봐."
   → 여기서는 DB를 거치지 않고 **FinanceDataReader로 직접 받는다.** 읽기 전용이고
   저장도 안 하므로 파이프라인·용량에 영향이 없다.

2. **"국내 반도체도 결국 미국을 따라가지 않나"가 측정된 적이 없다.** 월봉 결과에서
   MU 2021-07(저점 14개월·-35.0%)과 SK하이닉스 2021-07(저점 17개월·-33.3%)이
   같은 달에 같은 깊이로 빠진 것이 **눈에 보였지만 그건 두 사례일 뿐**이다.
   눈으로 본 것을 숫자로 바꾼다.

무엇을 재나
-----------
1부 — 국내 반도체(코스닥 포함) 월봉 에피소드. `backtestCycleMonthly.ts`와 **같은 규칙**:
      12개월 고점 대비 -15% 이하인 달을 시작으로 24개월 추적.
2부 — 한·미 동조. 세 가지를 따로 본다. 하나만 보면 틀린 결론이 쉽게 나온다:
      (a) 월 수익률 상관계수 — **시차 -3~+3개월**까지 본다. 시차 0이 가장 높으면
          '같이 움직인다', +1~2가 높으면 '국내가 뒤따른다'는 뜻이다.
      (b) 하락 국면 겹침 — 미국 반도체 지수가 하락 국면일 때 국내도 그랬던 달의 비율.
          상관계수는 평상시 잡음에 희석되므로 **하락기만 따로** 봐야 한다.
      (c) 에피소드 시작 월 대조 — 미국이 빠지기 시작한 달 전후로 국내가 빠졌나.

한계
----
- **지수가 아니라 종목 동일가중 평균**을 쓴다(진짜 반도체 지수는 안 받아진다).
  종목 구성이 바뀌면 값이 흔들린다.
- 상관계수는 "같이 움직인다"까지만 말한다. **어느 쪽이 원인인지는 말하지 않는다.**
  시차가 +면 '국내가 뒤따랐다'로 읽히지만, 둘 다 같은 제3의 요인(메모리 가격·환율)을
  따를 수도 있다.
- 지금 살아 있는 종목만 받으므로 생존 편향이 있다.

실행: `.github/workflows/semi_cycle_probe.yml` (작업 컨테이너는 FDR·야후가 막혀 있다)
"""
from __future__ import annotations

import sys
import time
from datetime import date

import pandas as pd

# 코스피 + **코스닥 소부장**. 유니버스에 없는 종목을 일부러 넣는 것이 이 스크립트의 목적이다.
KR_SEMI: dict[str, str] = {
    "005930": "삼성전자", "000660": "SK하이닉스", "042700": "한미반도체",
    "000990": "DB하이텍", "108320": "LX세미콘",
    "240810": "원익IPS", "058470": "리노공업", "039030": "이오테크닉스",
    "403870": "HPSP", "095340": "ISC", "036930": "주성엔지니어링",
    "348210": "넥스틴", "140860": "파크시스템스", "357780": "솔브레인",
    "005290": "동진쎄미켐", "101490": "에스앤에스텍", "064760": "티씨케이",
    "089030": "테크윙", "131970": "두산테스나", "036540": "SFA반도체",
}
US_SEMI: list[str] = [
    "NVDA", "MU", "AMD", "AMAT", "LRCX", "KLAC", "INTC", "AVGO", "QCOM", "TXN",
    "ADI", "MRVL", "ON", "NXPI", "MCHP", "TER", "ENTG", "SWKS", "QRVO", "TSM",
]

YEARS = 10
GATE = 15.0          # 12개월 고점 대비 하락률 기준(%)
HIGH_W = 12
FORWARD_M = 24
COOLDOWN_M = 6


def monthly_from_daily(df: pd.DataFrame) -> pd.Series:
    """일봉 → 월말 종가. long_history._to_monthly와 같은 규칙(resample 'MS')."""
    s = df["Close"].copy()
    s.index = pd.to_datetime(s.index)
    return s.resample("MS").last().dropna()


def fetch_kr() -> dict[str, pd.Series]:
    import FinanceDataReader as fdr

    start = f"{date.today().year - YEARS}-01-01"
    out: dict[str, pd.Series] = {}
    for code, name in KR_SEMI.items():
        try:
            df = fdr.DataReader(code, start)
            if df is None or df.empty or "Close" not in df:
                print(f"  {code} {name}: 빈 응답", flush=True)
                continue
            m = monthly_from_daily(df)
            out[code] = m
            print(f"  {code} {name}: 월봉 {len(m)}개 ({m.index[0].date()}~{m.index[-1].date()})", flush=True)
        except Exception as exc:  # noqa: BLE001 — 한 종목 실패가 전체를 멈추면 안 된다
            print(f"  {code} {name}: 실패 {type(exc).__name__}: {exc}", flush=True)
        time.sleep(0.2)
    return out


def fetch_us() -> dict[str, pd.Series]:
    import yfinance as yf

    start = f"{date.today().year - YEARS}-01-01"
    out: dict[str, pd.Series] = {}
    raw = yf.download(US_SEMI, start=start, interval="1mo", progress=False, auto_adjust=True)
    if raw is None or raw.empty:
        print("  야후 응답이 비었다", flush=True)
        return out
    close = raw["Close"] if "Close" in raw else raw
    for t in US_SEMI:
        if t not in close:
            print(f"  {t}: 열 없음", flush=True)
            continue
        s = close[t].dropna()
        s.index = pd.to_datetime(s.index).to_period("M").to_timestamp()
        if len(s) < 24:
            print(f"  {t}: 월봉 {len(s)}개 — 너무 짧아 제외", flush=True)
            continue
        out[t] = s
        print(f"  {t}: 월봉 {len(s)}개", flush=True)
    return out


def episodes(series: pd.Series) -> list[dict]:
    c = series.to_list()
    months = [d.strftime("%Y-%m") for d in series.index]
    eps: list[dict] = []
    last = -10**9
    for i in range(HIGH_W, len(c) - FORWARD_M):
        hi = max(c[i - HIGH_W : i + 1])
        if hi <= 0 or (c[i] - hi) / hi * 100 > -GATE:
            continue
        if i - last < COOLDOWN_M:
            continue
        last = i
        start = c[i]
        fwd = c[i + 1 : i + 1 + FORWARD_M]
        tr = min(range(len(fwd)), key=lambda k: fwd[k])
        rec = next((k - tr for k in range(tr, len(fwd)) if fwd[k] >= start), None)
        eps.append({
            "month": months[i],
            "to_trough": tr + 1,
            "extra": (fwd[tr] - start) / start * 100,
            "hold12": (fwd[11] - start) / start * 100 if len(fwd) > 11 else float("nan"),
            "hold24": (fwd[23] - start) / start * 100 if len(fwd) > 23 else float("nan"),
            "recover": rec,
        })
    return eps


def _fmt_ep(e: dict) -> str:
    """에피소드 한 건을 한 덩어리로. f-string 안에 조건부 f-string을 중첩하면
    따옴표가 꼬여 읽지도 고치지도 못하게 된다(실제로 한 번 깨뜨렸다)."""
    tail = "미회복" if e["recover"] is None else f"회복 {e['recover']}개월"
    return f"{e['month']}(저점 {e['to_trough']}개월·{e['extra']:+.1f}%·{tail})"


def q(xs: list[float], p: float) -> float:
    if not xs:
        return float("nan")
    s = sorted(xs)
    return s[min(len(s) - 1, max(0, round((len(s) - 1) * p)))]


def main() -> None:
    print(f"국내 반도체 {len(KR_SEMI)}종목 · 미국 반도체 {len(US_SEMI)}종목 · {YEARS}년 월봉\n")
    print("국내 월봉 수집 (FinanceDataReader, 코스닥 포함)")
    kr = fetch_kr()
    print(f"\n미국 월봉 수집 (yfinance)")
    us = fetch_us()
    if not kr or not us:
        print("::error::한쪽 시장을 통째로 못 받았다 — 동조 분석 불가")
        raise SystemExit(1)

    # ── 1부 — 국내 반도체 에피소드 (코스닥 포함) ─────────────────────────
    print("\n" + "=" * 92)
    print("1부 — 국내 반도체 월봉 에피소드 (12개월 고점 대비 -15% 이하 → 24개월 추적)")
    print("=" * 92)
    all_eps: list[dict] = []
    for code, s in kr.items():
        eps = episodes(s)
        for e in eps:
            e["code"] = code
        all_eps.extend(eps)
        if eps:
            detail = " ".join(_fmt_ep(e) for e in eps)
            print(f"\n  {code} {KR_SEMI[code]} — {len(eps)}건: {detail}")
        else:
            print(f"\n  {code} {KR_SEMI[code]} — 0건")

    if all_eps:
        tt = [e["to_trough"] for e in all_eps]
        ex = [e["extra"] for e in all_eps]
        h12 = [e["hold12"] for e in all_eps if e["hold12"] == e["hold12"]]
        h24 = [e["hold24"] for e in all_eps if e["hold24"] == e["hold24"]]
        rec = [e["recover"] for e in all_eps if e["recover"] is not None]
        print(f"\n▶ 국내 반도체 합계 — {len(all_eps)}건 ({len({e['code'] for e in all_eps})}종목)")
        print(f"  저점까지 {q(tt,0.5):.0f}개월 (25%분위 {q(tt,0.25):.0f} · 75%분위 {q(tt,0.75):.0f})")
        print(f"  추가 하락폭 중간값 {q(ex,0.5):+.1f}% (25%분위 {q(ex,0.25):+.1f}%)")
        print(f"  그냥 들고: 12개월 {q(h12,0.5):+.1f}% · 24개월 {q(h24,0.5):+.1f}%")
        print(f"  저점 이후 회복 {len(rec)/len(all_eps)*100:.0f}% · 중간값 {q([float(r) for r in rec],0.5):.0f}개월")
        years: dict[str, int] = {}
        for e in all_eps:
            years[e["month"][:4]] = years.get(e["month"][:4], 0) + 1
        print(f"  시작 연도별: {' · '.join(f'{y} {n}' for y, n in sorted(years.items()))}")

    # ── 2부 — 한·미 동조 ────────────────────────────────────────────────
    print("\n" + "=" * 92)
    print("2부 — 국내 반도체는 미국을 따라가는가")
    print("=" * 92)
    kr_df = pd.DataFrame(kr).sort_index()
    us_df = pd.DataFrame(us).sort_index()
    kr_ret = kr_df.pct_change(fill_method=None)
    us_ret = us_df.pct_change(fill_method=None)
    # 동일가중 평균 = 지수 대용. 진짜 지수가 아니라는 것을 출력에도 적는다.
    kr_m = kr_ret.mean(axis=1).dropna()
    us_m = us_ret.mean(axis=1).dropna()
    both = pd.concat([kr_m.rename("kr"), us_m.rename("us")], axis=1).dropna()
    print(f"\n  겹치는 달 {len(both)}개 ({both.index[0].date()} ~ {both.index[-1].date()})")
    print("  ※ 동일가중 평균이지 진짜 반도체 지수가 아니다.")

    print("\n  (a) 월 수익률 상관계수 — 시차별")
    print("      시차 0 = 같은 달, +N = 국내가 N개월 뒤따름")
    best = None
    for lag in range(-3, 4):
        c = both["kr"].corr(both["us"].shift(lag))
        mark = ""
        if best is None or abs(c) > abs(best[1]):
            best = (lag, c)
        print(f"      시차 {lag:+d}개월: {c:+.3f}{mark}")
    print(f"      → 가장 높은 시차 {best[0]:+d}개월 ({best[1]:+.3f})")

    print("\n  (b) 하락 국면 겹침 — 평상시 잡음을 빼고 하락기만 본다")
    kr_idx = (1 + both["kr"]).cumprod()
    us_idx = (1 + both["us"]).cumprod()
    kr_dd = (kr_idx / kr_idx.rolling(HIGH_W, min_periods=3).max() - 1) * 100
    us_dd = (us_idx / us_idx.rolling(HIGH_W, min_periods=3).max() - 1) * 100
    d = pd.concat([kr_dd.rename("kr"), us_dd.rename("us")], axis=1).dropna()
    us_down = d[d["us"] <= -GATE]
    kr_down = d[d["kr"] <= -GATE]
    print(f"      미국이 -{GATE:.0f}% 이하였던 달 {len(us_down)}개 중 국내도 그랬던 달"
          f" {int((us_down['kr'] <= -GATE).sum())}개"
          f" ({(us_down['kr'] <= -GATE).mean()*100 if len(us_down) else float('nan'):.0f}%)")
    print(f"      국내가 -{GATE:.0f}% 이하였던 달 {len(kr_down)}개 중 미국도 그랬던 달"
          f" {int((kr_down['us'] <= -GATE).sum())}개"
          f" ({(kr_down['us'] <= -GATE).mean()*100 if len(kr_down) else float('nan'):.0f}%)")
    print(f"      하락률끼리의 상관계수 {d['kr'].corr(d['us']):+.3f}")

    print("\n  (c) 연도별 하락 국면 — 같은 해에 같이 빠졌나")
    tbl = d.copy()
    tbl["year"] = tbl.index.year
    for y, g in tbl.groupby("year"):
        print(f"      {y}: 국내 최저 {g['kr'].min():+.1f}% · 미국 최저 {g['us'].min():+.1f}%"
              f"   (국내 -15%이하 {int((g['kr']<=-GATE).sum())}개월 · 미국 {int((g['us']<=-GATE).sum())}개월)")

    print("\n" + "=" * 92)
    print("※ 상관계수는 '같이 움직인다'까지만 말한다 — 어느 쪽이 원인인지는 말하지 않는다.")
    print("※ 지금 살아 있는 종목만 받았으므로 생존 편향이 있다.")


if __name__ == "__main__":
    sys.exit(main())
