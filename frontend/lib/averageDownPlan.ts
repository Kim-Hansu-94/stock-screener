/**
 * **추가 매수(물타기) 분할 계획** — "얼마에, 얼마씩" 을 미리 정해 두는 계산.
 *
 * 이 파일은 주가를 예측하지 않는다
 * --------------------------------
 * 목표가를 넣지 않는다. 넣을 수가 없다 — 이 저장소가 세 번(지지신호 5개 · 전환 신호
 * 7개 · 490590 A/B/C) 백테스트로 확인한 것은 **앞날을 가리키는 신호를 못 찾았다**는
 * 것이었고, 그 자리에 숫자를 지어 넣으면 근거 없는 확신을 화면에 띄우게 된다.
 *
 * 대신 **측정된 사실 하나** 위에 세운다(`research/backtestTurnSignals.ts`, 104,119건):
 *
 *   이미 15% 이상 빠진 종목을 추가 매수하면, 60거래일 안에 중간값 **-15%까지 더** 빠진다.
 *
 * 이건 신호가 아니라 **각오해야 할 기본값**이다. 그래서 계획은 "더 빠질 것"을 전제로
 * 짠다 — 지금 다 쓰지 않고, 아래로 갈수록 더 크게 산다. 분할매수가 예측이 아니라
 * 변동성 관리인 근거가 여기 있다.
 *
 * 쓰지 않기로 한 것
 * -----------------
 * **지지신호 충족 개수를 게이트로 쓰지 않는다.** 물타기 상황(이미 깊이 빠진 종목)에서
 * 충족 개수와 60거래일 성과 사이에 단조성이 없다는 것이 실측됐다(중앙값 0개 -0.43% ·
 * 1개 -1.47% · 2개 -2.57% · 3개 -1.79%, `supportSignals.ts` 참조). 개수를 조건으로
 * 걸면 근거 없는 숫자로 매수를 막거나 허락하게 된다. 지지신호는 **읽을 참고 자료**로
 * 화면에 남기고, 집행 여부는 가격만으로 정한다.
 *
 * 왜 가격 사다리인가
 * ------------------
 * 가격은 예측이 아니다. "1,000,000원이 되면 산다"는 맞고 틀리고가 없는 규칙이고,
 * 증권사 조건주문에 그대로 걸어 둘 수 있어 **사람이 그날의 기분으로 바꾸지 못한다.**
 * 물타기가 실패하는 전형적인 경로가 "더 빠지면 사야지" 하다가 막상 빠지면 무서워서
 * 못 사고, 오르면 조급해서 비싸게 사는 것이다.
 *
 * 차수별 하락률 [0%, -11%, -22%, -34%]
 *   측정된 중간값(-15%)을 2·3차가 **양옆에서 감싼다**. 4차는 그보다 뚜렷하게 나쁜
 *   경우를 맡는다. 중간값에 딱 맞춰 한 번에 사면 절반의 경우에 더 싼 값을 놓친다.
 *
 * 차수별 금액 비중 [18%, 20%, 25%, 37%]
 *   아래로 갈수록 키운다. 그래야 싸게 산 수량이 평단을 끌어내린다. 1차를 0으로 두지
 *   않는 이유는, 안 빠지고 올라가 버리면 예산이 통째로 노는 쪽도 손해이기 때문이다.
 *
 * **이 두 배열은 백테스트로 최적화한 값이 아니다.** 측정된 중간값 한 개를 기준으로
 * 고른 설계값이다 — 상수를 바꿔 성적을 맞추는 짓은 하지 않았다(그건 과최적화다).
 * 바꾸려면 근거를 적고 `averageDownPlan.test.ts`를 같이 고칠 것.
 */
import { computeAverageCost, DEFAULT_SELL_COST_PCT, type BuyLot } from './averageCost'
import type { Market } from './types'

/**
 * 사다리 한 칸. `offset`은 **현재가 대비 비율**이고 부호가 방향을 정한다.
 *   0보다 작으면 "그 가격까지 **떨어지면** 산다"(dip)
 *   0보다 크면   "그 가격까지 **올라오면** 산다"(rebound)
 *   0이면        지금 바로
 */
export interface LadderStep {
  offset: number
  weight: number
}

export type LadderStyle = 'dip' | 'rebound' | 'conviction' | 'cycle' | 'basing'

/**
 * 두 가지 사다리를 **둘 다 코드에 둔다.** 어느 쪽이 맞는지는 데이터가 못 정해 주고
 * (아래 참조), 그렇다고 한쪽을 지우면 왜 그 모양인지 근거가 사라진다.
 *
 * ## `dip` — 측정이 뒷받침하는 기본값
 * "더 빠진다"를 전제로 아래로 갈수록 크게 산다. 근거는 `backtestTurnSignals.ts`의
 * 104,119건: **이미 15% 이상 빠진 종목을 추가 매수하면 60거래일 안에 중간값 -15%까지
 * 더 빠진다.** 2·3차가 그 중간값을 양옆에서 감싼다.
 *
 * ## `rebound` — 사용자가 고른 모양 (2026-11-11)
 * "지금이 바닥권이고 저점을 다지는 중이라, 반등에 크게 싣고 싶다"는 판단을 그대로
 * 옮긴 것이다. 1차를 키우고(25%), 아래쪽은 한 칸만 남기고(20%), **나머지 55%를
 * 현재가 위에** 둔다 — 반등이 확인되면 그때 크게 사는 모양이다.
 *
 * **이 모양은 측정이 뒷받침하지 않는다는 것을 분명히 해 둔다.** 같은 날 잰 두 가지가
 * 반대를 가리킨다: (1) 위의 -15% 기본값은 "지금이 바닥"이라는 전제와 어긋나고,
 * (2) `backtestTurnSignals.ts`가 "하락이 멈추고 상승 전환"을 잡는 트리거 후보 7개를
 * 재서 **전부 기준선을 못 넘었다**(20거래일에서 7개 중 5개가 기준선보다 나빴고,
 * 60일 1·2등이 20일 꼴찌권이었다). 즉 **반등 확인 매수에 측정된 우위가 없다.**
 * 그래도 이 모양을 넣는 이유는, 돈을 넣는 사람이 시장을 어떻게 보는지가 데이터로
 * 정해지지 않는 선택이고 **사용자가 그 선택을 했기 때문**이다. 바꿀 때도 같은
 * 원칙으로 — 성적을 맞추려고 숫자를 돌리지 말 것.
 *
 * ## `conviction` — "바닥권이다"를 데이터와 어긋나지 않게 실행하는 모양 (2026-11-12)
 *
 * 2026-11-12 측정이 `rebound`의 전제를 직접 반박했다. "저점 대비 X% 올라오고 저점이
 * D일 안 깨졌을 때 산다"는 격자를 한국(16칸)·미국(16칸) **32칸 전부** 재 보니
 * 하나도 기준선을 못 넘었고, **X가 커질수록(= 반등을 많이 확인할수록) 정확히 그만큼
 * 나빠졌다**(한국 -0.4%~-4.2%, 미국 -0.2%~-3.5%, 종목 A/B 분리에서도 32칸 모두 같은 부호).
 *
 * 여기서 나오는 결론이 이 모양의 근거다: **"지금이 바닥권"이라고 믿는다면 그 믿음의
 * 올바른 실행은 '지금 많이 사는 것'이지 '반등을 확인하고 사는 것'이 아니다.** 이미
 * 싸다고 보면서 +8%·+23% 확인을 기다리는 건, 자기가 싸다고 판단한 가격을 두고 더 비싸게
 * 사겠다는 뜻이라 전제와 앞뒤가 안 맞는다.
 *
 * 그래서 1차를 35%로 키우고(= 바닥권 확신을 금액으로 표현) 나머지를 전부 아래에 둔다.
 * 아래 간격이 -12/-24/-36%인 것은 같은 날 잰 **추가 하락폭 분포**에서 나왔다:
 * 국내 전체 중간값 -17.2%(25%분위 -30.1%), 국내 대형주 -11.5%, **미국 IT -30.1%
 * (25%분위 -45.3%)**. SK하이닉스는 대형 기술주라 두 분포 사이에 있고, 4차(-36%)가
 * 그 종목의 8개월 전 실제 바닥(807,000원 ≈ -37%)과 거의 같은 자리에 떨어진다.
 *
 * ## `cycle` — **지금 서 있는 깊이에서 직접 잰** 분포 (2026-11-12)
 *
 * 앞 세 모양의 간격은 전부 "고점 대비 -15% 지점에서 출발한" 측정에서 나왔다.
 * 그런데 물타기를 고민하는 사람은 보통 그보다 훨씬 깊이 빠진 자리에 서 있다
 * (SK하이닉스는 -56%였다). **출발점이 다른 숫자로 간격을 잡으면 사다리가 통째로
 * 어긋난다** — 그래서 깊이 구간별로 다시 쟀다(`pipeline/research/semi_cycle_probe.py`).
 *
 * 국내 반도체 20종목 10년, **이미 -45~-60% 빠져 있던 85개월**에서 그 뒤 24개월간:
 *
 *   추가 하락폭  중간값 -9.2% · 25%분위 -19.7% · 10%분위 -32.6% · 최악 -41.8%
 *
 * 차수 가격이 이 분위수 그대로다(-9 / -20 / -33%). 임의로 고른 간격이 아니라
 * **분포에서 읽어온 값**이고, 깊이가 깊을수록 추가 하락이 **작아진다**는 것도
 * 같은 측정에서 나왔다(-15~-30% 구간은 중간값 -27.6%인데 -45~-60%는 -9.2%다).
 *
 * 비중을 1차에 40%로 몰아 둔 것도 그 분포 때문이다 — 중간값이 -9.2%뿐이라
 * 아래에서 기다릴 이유가 약하다. 2~4차는 꼬리에 대한 보험이다.
 *
 * **반드시 같이 알아야 할 두 가지.**
 * (1) **삼성전자·SK하이닉스는 10년간 -45% 아래로 간 적이 0번이다.** 그래서
 *     -45~-60% 구간의 85개월은 전부 **소부장 15종목**이고, 그쪽이 대형주보다
 *     변동이 크다. 지금 SK하이닉스의 -56%는 **10년 데이터에 선례가 없다.**
 * (2) 같은 구간의 "24개월 +122.2% · 회복 100%"는 **생존 편향이 극심하다** —
 *     그만큼 빠지고도 지금까지 살아남은 종목만 세기 때문이다. 간격을 잡는 데는
 *     썼지만 수익률 기대치로는 쓰지 않았다.
 *
 * ## `basing` — **바닥이 이미 지났다고 칠 때** 잰 분포 (2026-11-12)
 *
 * 사용자 전제: "지금은 전례 없는 하락이니 저점은 이미 나왔다고 보고, 지금부터
 * 저점을 다지며 올라간다." 앞 네 모양은 전부 **'지금 깊이 빠진 자리'**를 묻는
 * 측정에서 나왔는데, 이 종목은 이미 **8개월 전 바닥(807,000원)에서 +58.6%
 * 올라온 자리(1,280,000원)**다. 질문 자체가 다르다.
 *
 * `semi_cycle_probe.py` **4부**가 그 질문을 쟀다 — 과거 사이클에서 **바닥을
 * 확정해 놓고**(±6개월 최저 + 직전 12개월 고점 대비 -30% 이하) 거기서 **+60%
 * 올라온 자리**에서 샀다면 그 뒤가 어땠나. 국내 반도체 20종목에서 50건이 나왔고,
 * **바닥에서 그 자리까지 걸린 기간의 중간값이 8개월** — 이 종목의 지금 자리와 같다.
 *
 *   되돌림(눌림)  중간값 -14.9% · 25%분위 -35.7% · 10%분위 -49.7% · 최악 -64.4%
 *   **바닥 재이탈(저점 아래로 복귀) 9/50건 = 18%**
 *
 * ### 그 분위수를 차수 가격으로 쓰는 것이 맞는지를 다시 쟀다 (5부)
 *
 * 처음엔 저 분위수를 그대로 옮겼다(-14 / -35 / -49%, 비중 35/30/20/15). 사용자가
 * 바로 물었다: **"바닥이라며 4차가 왜 -49%까지 가냐."** 의견으로 답할 일이 아니라
 * **같은 표본에 사다리를 되돌려 돌려 보면 되는 질문**이었고, 돌려 보니 그 지적이 맞았다.
 * (예산 100을 비중대로 나눠 두고 안 걸린 돈은 **현금 그대로**, 체결은 월봉 저가/고가로.)
 *
 *   24개월 뒤(32건)   앞에 싣고 꼬리 얕게 +51.6% > 지금 다 사기 +50.3% > 옛 basing +48.7%
 *   12개월 뒤(47건)   지금 다 사기 +35.5% > 3칸 앞싣기 +34.6% > ... > 옛 basing +23.2%
 *   대조군(-45% 아래 88개월)  지금 다 사기 +126.4% > ... > 옛 basing +80.6%
 *
 * **세 표본 전부에서 앞에 많이 싣는 쪽이 중간값이 높았다.** 이유는 단순하다 —
 * -49% 칸은 거의 안 걸려서 **예산의 27~40%가 끝까지 현금으로 놀았다**(옛 basing의
 * 예산집행 12개월 60% · 24개월 73%). 그 돈은 중간값 +50%짜리 상승을 통째로 놓친다.
 *
 * 그래서 지금 모양은 **0 / -9 / -18 / -30%, 비중 50/25/15/10**이다. 같은 측정에서
 * 1등이었던 모양이고, 예산집행이 87%로 올라간다(SK하이닉스 기준 못 쓰는 돈 56,000원).
 *
 * ### 그래도 분할로 두는 이유 — 중간값이 아니라 **나쁜 25%**를 산다
 *
 * 같은 표에서 한 번에 다 사기는 24개월 **25%분위 -9.9%**였고 옛 basing은 **+12.1%**,
 * 플러스로 끝난 비율도 69% vs 81%였다. **분할매수는 중간값을 조금 깎고 나쁜 경우를
 * 크게 들어올린다** — 그게 분할의 값어치이고, 그래서 1차를 50%로 키우되 100%로는
 * 가지 않았다. 지금 모양은 24개월 25%분위 -0.8%로 한 번에 사기(-9.9%)보다 낫다.
 *
 * ### 무엇을 포기했는지
 *
 * 4차가 896,000원이라 **8개월 전 바닥(807,000원) 아래는 더 이상 받지 않는다** —
 * 측정된 18%의 바닥 재이탈이 일어나면 그 구간에서는 아무것도 사지 않는다. 그 칸을
 * 두는 비용(노는 돈)이 효용보다 컸다는 것이 5부의 결론이고, **전제를 믿지 않는다면
 * `cycle`이나 `dip`을 고를 것.**
 *
 * ### 한계 — 순위의 소수점을 믿지 말 것
 *
 * 32~47건이고 구간이 서로 겹치며, 12개월과 24개월에서 **순위가 뒤집히는 모양이 있다**
 * (3칸 앞싣기 12개월 2등 → 24개월 7등). 이 저장소가 여러 번 본 잡음의 지문이다.
 * 그래서 받은 것은 **"앞에 싣고 꼬리를 얕게"라는 방향 하나**이지 특정 등수가 아니다.
 * 바닥 판정에 후견지명이 있어 "바닥이 맞았다면"까지만 말하는 숫자이고, 지금 살아
 * 있는 종목만 받았으므로 생존 편향도 있다.
 *
 * 두 모양의 성격 차이는 시나리오 표에 그대로 드러난다: `rebound`는 평단을 덜 낮추는
 * 대신 반등이 진짜일 때 주식 수가 많고, `dip`은 그 반대다. **어느 쪽이 "좋다"가
 * 아니라 어느 쪽에 걸겠느냐의 문제다.**
 */
export const LADDERS: Record<LadderStyle, readonly LadderStep[]> = {
  dip: [
    { offset: 0, weight: 0.18 },
    { offset: -0.11, weight: 0.2 },
    { offset: -0.22, weight: 0.25 },
    { offset: -0.34, weight: 0.37 },
  ],
  rebound: [
    { offset: 0, weight: 0.25 },
    { offset: -0.12, weight: 0.2 },
    { offset: 0.08, weight: 0.22 },
    { offset: 0.23, weight: 0.33 },
  ],
  conviction: [
    { offset: 0, weight: 0.35 },
    { offset: -0.12, weight: 0.25 },
    { offset: -0.24, weight: 0.2 },
    { offset: -0.36, weight: 0.2 },
  ],
  cycle: [
    { offset: 0, weight: 0.4 },
    { offset: -0.09, weight: 0.25 },
    { offset: -0.2, weight: 0.2 },
    { offset: -0.33, weight: 0.15 },
  ],
  basing: [
    { offset: 0, weight: 0.5 },
    { offset: -0.09, weight: 0.25 },
    { offset: -0.18, weight: 0.15 },
    { offset: -0.3, weight: 0.1 },
  ],
} as const

/**
 * 사다리 한 모양에 대해 화면이 말해야 할 전부. **사다리 바로 옆에** 둔다.
 *
 * 화면에만 적어 두면 새 모양을 추가할 때 옛 설명이 그대로 남아 **조용히 거짓말을
 * 한다** — 실제로 `cycle`·`basing`을 추가한 뒤 화면이 둘 다 `dip`의 근거("아래쪽을
 * -36%까지 비워 둘 근거")를 적고 있었고, 차수 가격만 바뀌어 있었다. 여기 두면
 * 새 모양을 `LADDERS`에 넣는 순간 타입이 설명을 함께 요구한다.
 *
 * - `label`    토글 버튼 글자
 * - `gist`     비교표의 "무엇이 다른가" 한 줄 — **이 모양이 무엇을 하는지**를
 *              통계 용어 없이 쓴다. 모양끼리 대비되게 쓸 것
 * - `basis`    `measured`(측정에서 나온 간격) / `judgement`(사람의 시장 판단)
 * - `headline` 계획 아래 근거 문단의 굵은 첫 구절
 * - `body`     그 뒤 설명 — 간격이 어느 측정에서 나왔는지
 * - `caveat`   **이 모양을 믿을 때 걸리는 한계.** 근거만 적고 한계를 빼면
 *              화면이 다섯 모양을 모두 "측정으로 뒷받침됨"으로 보이게 한다.
 *              실제로 `cycle`은 간격을 잰 85개월에 대형 메모리가 **0건**인데
 *              화면에는 그 말이 없었고, 사용자가 "지금이 역대급으로 빠진
 *              상황인데 그 뒤로 더 빠진 적이 있었다고?"라고 물어서야 드러났다
 *              (2026-11-13). 근거를 적는 자리에는 반드시 한계도 적는다.
 */
export interface LadderInfo {
  label: string
  gist: string
  basis: 'measured' | 'judgement'
  headline: string
  body: string
  caveat: string
}

/** 화면에 보이는 순서. 가장 최근에 측정으로 만든 것부터. */
export const LADDER_ORDER: readonly LadderStyle[] = [
  'basing',
  'cycle',
  'conviction',
  'rebound',
  'dip',
] as const

export const LADDER_INFO: Record<LadderStyle, LadderInfo> = {
  basing: {
    label: '저점다지기형',
    gist: '지금 예산의 절반을 사고, 아래 세 칸은 얕게만 둡니다 — 바닥은 이미 지났다고 보는 모양',
    basis: 'measured',
    headline: '바닥이 맞았던 과거에 사다리들을 되돌려 돌려서 고른 모양입니다',
    body:
      '— 과거 사이클에서 바닥을 확정해 놓고 거기서 +60% 올라온 자리에 사다리를 그대로 돌려 ' +
      '봤습니다. 아래로 깊게 깐 모양은 그 칸이 거의 안 걸려 예산의 27~40%가 현금으로 놀았고, ' +
      '세 표본 전부에서 앞에 많이 싣는 쪽이 중간값이 높았습니다(24개월 +51.6% vs 한 번에 사기 ' +
      '+50.3%). 그래도 한 번에 다 사지 않는 이유는 나쁜 25%입니다 — 한 번에 사기는 24개월 ' +
      '25%분위가 −9.9%인데 나눠 사면 −0.8%였습니다.',
    caveat:
      '꼬리가 얕아 구간 저가 아래는 받지 않습니다 — 거기서 더 내려가면 이 계획을 멈추고 더 ' +
      '깊은 사다리로 다시 짜야 합니다. 그리고 바닥 판정에 후견지명이 들어 있어 "바닥이 ' +
      '맞았다면"까지만 말하는 숫자입니다 — 이 종목이 정말 바닥을 지났는지는 위 안내가 따로 가립니다.',
  },
  cycle: {
    label: '사이클 실측형',
    gist: '지금 가장 많이 사고(예산의 40%), 아래 간격은 과거에 실제로 더 빠졌던 폭에 맞춥니다',
    basis: 'measured',
    headline: '지금 서 있는 깊이에서 직접 잰 분포입니다',
    body:
      '— 국내 반도체 20종목 10년 중 이미 고점 대비 −45~−60% 빠져 있던 85개월의 그 뒤 ' +
      '추가 하락폭: 중간값 −9.2% · 25%분위 −19.7% · 10%분위 −32.6%. 차수 가격이 이 분위수 ' +
      '그대로입니다. 깊이 빠져 있을수록 추가 하락이 오히려 작았기 때문에 1차가 가장 큽니다 ' +
      '(−15~−30% 구간은 중간값 −27.6%인데 −45~−60%는 −9.2%였습니다).',
    caveat:
      '간격을 잰 85개월에 삼성전자·SK하이닉스는 한 달도 없습니다 — 이 두 종목은 10년간 고점 ' +
      '대비 −45% 아래로 내려간 적이 0번이고, 그 85개월은 전부 변동이 더 큰 소부장 15종목' +
      '(ISC 13개월 · 주성엔지니어링 11 · 이오테크닉스 9 · 에스앤에스텍 9 · 테크윙 9 …)입니다. ' +
      '또 여기서 "추가 하락폭"은 그 뒤 24개월 안에 한 번이라도 찍은 최저가이지, 거기까지 ' +
      '빠져서 머물렀다는 뜻이 아닙니다 — 지정가가 체결될 자리를 고르는 데는 맞지만 ' +
      '"반드시 그만큼 더 빠진다"로 읽으면 안 됩니다. 같은 구간의 "24개월 +122% · 회복 100%"는 ' +
      '그만큼 빠지고도 지금까지 살아남은 종목만 세기 때문에 수익률 기대치로는 못 씁니다.',
  },
  conviction: {
    label: '바닥권 확신형',
    gist: '지금 많이 사고(예산의 35%), 아래 칸은 간격을 넓게 벌려 보험으로만 둡니다',
    basis: 'measured',
    headline: '"바닥권이다"는 판단을 1차를 키우는 것으로 표현하고, 확인을 기다려 더 비싸게 사지는 않습니다',
    body:
      '— 반등 확인 매수를 한국·미국 32칸으로 재서 전부 기준선을 못 넘었기 때문입니다. ' +
      '아래 간격은 실측 추가 하락폭 분포에서 왔습니다: 국내 전체 중간값 −17.2%(25%분위 −30.1%), ' +
      '미국 IT −30.1%(25%분위 −45.3%).',
    caveat:
      '아래 칸이 −12 / −24 / −36%로 넓게 벌어져 있어, 어중간하게 눌리면 2·3차가 걸리지 않고 ' +
      '예산이 현금으로 남습니다. 되돌려 돌려 보니 예산 집행률이 다섯 중 가장 낮은 편이었습니다(24개월 76%).',
  },
  rebound: {
    label: '반등에 싣기',
    gist: '지금 사고, 올라가는 것을 보면서 더 삽니다 — 예산의 절반 이상이 현재가보다 비싼 자리에 있습니다',
    basis: 'judgement',
    headline: '이 모양은 측정이 아니라 당신의 시장 판단에서 나왔습니다',
    body:
      '— "지금이 바닥권이고 저점을 다지는 중"이라고 보고 예산의 절반 이상을 현재가 위에 두는 ' +
      '구성입니다. 반대쪽 숫자도 알려 드립니다: 이미 15% 이상 빠진 종목을 추가 매수하면 ' +
      '60거래일 안에 중간값 15%만큼 더 빠졌고(104,119건), "반등 확인 후 매수" 트리거는 ' +
      '한국·미국 32칸 전부 기준선을 넘지 못했습니다. 그래서 아래쪽 한 칸은 보험으로 남겨 뒀습니다.',
    caveat:
      '현재가보다 비싼 두 칸은 주가가 거기까지 올라야 체결됩니다 — 안 오르면 예산의 절반 이상이 ' +
      '계속 현금으로 남습니다. 되돌려 돌려 본 다섯 중 24개월 중간값이 가장 낮았던 모양이기도 ' +
      '합니다(+39.7%, 1등이 +51.6%). 그래도 고를 만한 이유는 "앞으로 어떻게 될지"를 맞히는 ' +
      '신호를 이 저장소가 네 번 찾아보고 못 찾았다는 것 — 즉 측정이 당신의 판단을 꺾을 만큼 ' +
      '세지 않다는 데 있습니다.',
  },
  dip: {
    label: '더 빠질 때 싣기',
    gist: '지금은 조금만 사고(예산의 18%), 더 빠질수록 더 많이 삽니다 — 다섯 중 유일하게 마지막 칸이 가장 큽니다',
    basis: 'measured',
    headline: '이미 15% 이상 빠진 종목을 추가 매수하면 60거래일 안에 중간값 15%만큼 더 빠집니다',
    body:
      '(104,119건). 2·3차가 그 중간값을 양옆에서 감쌉니다. 예측이 아니라 각오해야 할 기본값입니다.',
    caveat:
      '그 −15%는 업종·깊이를 가리지 않은 평균입니다. 이미 깊이 빠진 종목만 따로 보면 추가 ' +
      '하락이 훨씬 작았으므로(사이클 실측형 참고) 이 모양은 다섯 중 가장 보수적인 쪽이고, ' +
      '그만큼 아래 칸이 안 걸려 현금이 남을 확률도 높습니다(되돌려 돌려 본 12개월 예산 집행 53%).',
  },
}

export const DEFAULT_LADDER_STYLE: LadderStyle = 'rebound'

/**
 * **시간 계획** — "그래서 몇 개월 뒤에 사야 하나"에 답하는 유일한 측정.
 *
 * 1~5부는 전부 **가격축**(얼마에 살까)이었다. 사용자가 물은 것은 **시간축**이었다:
 * "과거 사이클의 바닥 이후 흐름에 지금을 겹쳐서, 내가 언제 사는 게 좋을지."
 * `semi_cycle_probe.py` **6부**가 그걸 쟀다 — 과거 바닥들을 0개월에 맞춰 포개고
 * (국내 반도체 55건 · 미국 반도체 30건), 이 종목이 선 자리(바닥에서 8개월,
 * 807,000 → 1,280,000 = 1.59배)를 그 경로 위에 얹었다.
 *
 * 세 가지가 나왔다.
 *
 * 1. **지금 자리는 평균 경로 위다.** 8개월차 과거 중간값이 국내 1.45배 · 미국
 *    1.56배인데 지금이 1.59배다 — 늦지도 이르지도 않다.
 * 2. **앞으로 3개월쯤이 가장 쌌다**(국내 중간값 3개월 뒤, 25~75% 1~5개월 뒤).
 *    그 최저가가 지금보다 쌌던 경우는 **64%**, 쌀 때의 깊이는 중간값 **-16.1%**다.
 *    → 사다리의 -9%·-18% 칸이 노리는 자리가 정확히 여기다.
 * 3. **미루면 나빠진다.** 그 달에 사서 24개월차까지의 중간값이 국내 기준
 *    8개월차 +50.4% → 12개월차 +22.6% → 18개월차 +1.6% → 20개월차 -8.9%로
 *    **단조롭게 떨어진다**(미국도 +66.1% → +46.3% → +26.1% → +7.3%).
 *
 * 그래서 사다리에 **시한**이 붙는다: 눌림을 기다리되 **바닥에서 12개월차
 * (= 지금부터 4개월)**까지만 기다리고, 그때까지 안 걸린 돈은 그냥 집행한다.
 * 기다리는 것 자체가 비용이라는 것이 3번의 뜻이다.
 *
 * **이 숫자들은 "바닥이 이미 지났다"는 전제 위에 있다** — 바닥 판정에 후견지명이
 * 들어 있고(지나고 나서야 안다), 그래서 `basing` 사다리에서만 보여 준다.
 */
export interface CycleTimeline {
  /** 지금이 바닥에서 몇 개월차인가. */
  monthsAfterTrough: number
  /** 가장 쌌던 달이 몇 개월 뒤였나 — 중간값과 25~75% 구간. */
  dipMonthsAhead: number
  dipRangeAhead: readonly [number, number]
  /** 그 최저가가 지금보다 쌌던 비율(%). */
  dipProbabilityPct: number
  /** 쌀 때의 깊이 중간값(%). */
  dipDepthPct: number
  /** 이 개월 수가 지나면 남은 돈을 그냥 집행한다(= 바닥에서 12개월차). */
  deadlineMonthsAhead: number
  /** 바닥에서 N개월차에 사서 24개월차까지의 중간 수익률(%). */
  entryByMonth: readonly { readonly month: number; readonly kr: number; readonly us: number }[]
  /** 이 값들을 잰 날. 시간이 지나면 '8개월차'가 더는 지금이 아니다. */
  measuredOn: string
}

export const CYCLE_TIMELINE: CycleTimeline = {
  monthsAfterTrough: 8,
  measuredOn: '2026-11-12',
  dipMonthsAhead: 3,
  dipRangeAhead: [1, 5],
  dipProbabilityPct: 64,
  dipDepthPct: -16.1,
  deadlineMonthsAhead: 4,
  entryByMonth: [
    { month: 8, kr: 50.4, us: 66.1 },
    { month: 10, kr: 36.7, us: 58.1 },
    { month: 12, kr: 22.6, us: 46.3 },
    { month: 14, kr: 3.4, us: 45.6 },
    { month: 18, kr: 1.6, us: 26.1 },
    { month: 20, kr: -8.9, us: 7.3 },
  ],
} as const

export interface PlanInput {
  /** 지금 평단가(원). */
  avgCost: number
  /** 지금 보유 수량(주). */
  shares: number
  /** 현재가(원). */
  price: number
  /** 추가로 쓸 수 있는 금액(원). */
  budget: number
  market?: Market
  /** 사다리 모양. 생략하면 `DEFAULT_LADDER_STYLE`. */
  style?: LadderStyle
}

export interface Tranche {
  /** 1부터. */
  step: number
  /**
   * 집행 가격. `direction`이 'dip'이면 이 가격 **이하**로 내려올 때,
   * 'rebound'면 이 가격 **이상**으로 올라올 때 산다. 1차는 현재가(즉시).
   */
  triggerPrice: number
  direction: 'now' | 'dip' | 'rebound'
  /** 현재가 대비 비율. 음수면 아래, 양수면 위. */
  offsetPct: number
  qty: number
  cost: number
  /** 이 차수까지 집행했을 때의 평단가. */
  avgCostAfter: number
  /** 이 차수까지 집행했을 때의 본전 가격(매도비용 포함). */
  breakevenAfter: number
  /** 이 차수까지 쓰고 남는 예산. */
  budgetLeft: number
}

export interface AverageDownPlan {
  /** 어떤 사다리로 만든 계획인지 — 화면이 밝혀 적어야 한다. */
  style: LadderStyle
  tranches: Tranche[]
  /** 계획대로 다 사도 남는 돈(1주 값보다 적어 못 쓰는 잔액). */
  unusedBudget: number
  /** 더 사지 않는 가격 — 지금 평단. 이 위에서 사면 평단이 올라간다. */
  stopBuyingAbove: number
  /** 모든 차수를 집행한 뒤의 총 수량·평단(한 가지 경로 기준 — 위 주석 참조). */
  finalQty: number
  finalAvgCost: number
}

/** 사람이 조건주문에 그대로 넣을 수 있도록 '읽히는 자리'에서 끊는다. */
export function roundTrigger(price: number): number {
  if (!(price > 0)) return 0
  const step = Math.max(1, 10 ** (Math.floor(Math.log10(price)) - 2))
  return Math.floor(price / step) * step
}

/**
 * 가격 사다리를 만든다.
 *
 * 수량은 **내림**한다 — 예산을 넘겨 사는 일이 없어야 한다. 그래서 마지막에 1주 값보다
 * 적은 잔액이 남고, 그 금액을 `unusedBudget`으로 그대로 드러낸다(조용히 어딘가에
 * 밀어 넣으면 계획과 실제가 어긋난다).
 */
export function buildAverageDownPlan(input: PlanInput): AverageDownPlan | null {
  const { avgCost, shares, price, budget } = input
  const market = input.market ?? 'KR'
  const style = input.style ?? DEFAULT_LADDER_STYLE
  if (!(avgCost > 0) || !(shares > 0) || !(price > 0) || !(budget > 0)) return null

  const lots: BuyLot[] = [{ price: avgCost, qty: shares }]
  const tranches: Tranche[] = []
  let spent = 0

  // **집행된 순서가 아니라 사다리에 적힌 순서대로** 쌓는다. 양방향 사다리에서는
  // 아래 차수와 위 차수 중 뭐가 먼저 걸릴지 알 수 없으므로, `avgCostAfter`는
  // "1차부터 이 차수까지 전부 샀다면"이라는 **한 가지 경로**의 값이다.
  // 실제 경로별 손익은 `evaluateScenario`가 따로 낸다.
  // 차수마다 주 수를 **내림**하면 끝에 쓸 수 없는 잔액이 남는다. 그 잔액을 그대로
  // 버리면 반등 사다리(비싼 가격에 사는 칸이 많다)에서 예산의 10%가 놀았다
  // (실측: 30,000,000원 중 3,060,000원). 그래서 **다음 차수로 넘긴다** — 비중은
  // 그대로 두고 자투리만 흘려보내는 것이라 설계 의도가 바뀌지 않는다.
  let carry = 0
  for (const [i, stepDef] of LADDERS[style].entries()) {
    const { offset, weight } = stepDef
    const trigger = roundTrigger(price * (1 + offset))
    if (!(trigger > 0)) continue
    // **평단 위에서는 사지 않는다.** 위쪽 차수는 반등을 쫓아 올라가므로 평단을 넘길
    // 수 있는데, 그 가격에 사면 평단이 **올라간다** — 이 계산기의 목적과 정반대다.
    // 건너뛴 몫은 `unusedBudget`으로 그대로 드러낸다(조용히 다른 차수로 밀어 넣으면
    // 사용자가 정한 비중이 아닌 계획이 된다).
    if (offset > 0 && trigger >= avgCost) continue
    const slice = budget * weight + carry
    const qty = Math.floor(slice / trigger)
    carry = slice - qty * trigger
    if (qty <= 0) continue
    const cost = qty * trigger
    spent += cost
    lots.push({ price: trigger, qty })
    // 평단·본전가는 기존 계산기를 그대로 쓴다 — 매도비용(KR 0.165%)까지 같은 규칙이다.
    // 세 번째 인자는 매도비용 **비율(%)** 이다 — 본전가가 평단보다 그만큼 위에 잡힌다.
    const agg = computeAverageCost(lots, trigger, DEFAULT_SELL_COST_PCT[market])
    if (!agg) continue
    tranches.push({
      step: i + 1,
      triggerPrice: trigger,
      direction: offset === 0 ? 'now' : offset < 0 ? 'dip' : 'rebound',
      offsetPct: offset,
      qty,
      cost,
      avgCostAfter: agg.avgCost,
      breakevenAfter: agg.breakevenPrice,
      budgetLeft: budget - spent,
    })
  }

  if (tranches.length === 0) return null
  const last = tranches[tranches.length - 1]
  return {
    style,
    tranches,
    unusedBudget: budget - spent,
    stopBuyingAbove: avgCost,
    finalQty: shares + tranches.reduce((a, t) => a + t.qty, 0),
    finalAvgCost: last.avgCostAfter,
  }
}

export interface ScenarioOutcome {
  label: string
  /** 1년 사이 **최저가** — 아래쪽(dip) 차수가 걸렸는지를 정한다. */
  lowPrice: number
  /** 1년 사이 **최고가** — 위쪽(rebound) 차수가 걸렸는지를 정한다. */
  highPrice: number
  /** 1년 뒤 **가격** — 손익을 정한다. */
  endPrice: number
  executedSteps: number
  /** 계획대로 샀을 때: 투입 원금·평가금액·손익(원). */
  planInvested: number
  planValue: number
  planPnl: number
  planPnlPct: number
  /** 아무것도 안 샀을 때(지금 그대로 보유). */
  holdInvested: number
  holdValue: number
  holdPnl: number
  holdPnlPct: number
  /** 지금 전액을 한 번에 샀을 때 — 나눠 사는 게 정말 나은지 비교하려고 같이 낸다. */
  allInPnl: number
}

/**
 * "1년 동안 이렇게 움직이면 얼마"를 계산한다. **확률은 붙이지 않는다** — 어느 시나리오가
 * 얼마나 그럴듯한지는 이 코드가 알 수 없고, 숫자를 붙이면 예측처럼 읽힌다.
 *
 * 최저가·최고가·끝 가격을 **따로** 받는다. 아래쪽 차수는 지나간 **최저가**로,
 * 위쪽 차수는 지나간 **최고가**로 걸리는지가 정해지고, 손익은 **끝 가격**으로 정해진다.
 * 하나로 뭉치면 "바닥을 찍고 회복한 경우"도 "반등했다가 되밀린 경우"도 표현할 수 없다.
 *
 * **순서는 모른다는 것을 알고 쓴다** — 같은 1년이라도 "먼저 빠졌다 오른" 경우와
 * "먼저 올랐다 빠진" 경우에 실제 집행 결과가 다를 수 있다. 여기서는 걸린 차수를
 * 전부 집행한 것으로 보므로, 양방향 사다리에서는 **가장 많이 산 경우**에 해당한다.
 */
export function evaluateScenario(
  input: PlanInput,
  plan: AverageDownPlan,
  label: string,
  lowPrice: number,
  highPrice: number,
  endPrice: number,
): ScenarioOutcome {
  const { avgCost, shares, price, budget } = input
  const executed = plan.tranches.filter((t) =>
    t.direction === 'rebound' ? highPrice >= t.triggerPrice : lowPrice <= t.triggerPrice,
  )
  const addQty = executed.reduce((a, t) => a + t.qty, 0)
  const addCost = executed.reduce((a, t) => a + t.cost, 0)

  const holdInvested = avgCost * shares
  const planInvested = holdInvested + addCost
  const planValue = (shares + addQty) * endPrice
  const holdValue = shares * endPrice

  // 지금 전액 투입 — 같은 예산으로 현재가에 살 수 있는 만큼.
  const allInQty = Math.floor(budget / price)
  const allInInvested = holdInvested + allInQty * price
  const allInPnl = (shares + allInQty) * endPrice - allInInvested

  return {
    label,
    lowPrice,
    highPrice,
    endPrice,
    executedSteps: executed.length,
    planInvested,
    planValue,
    planPnl: planValue - planInvested,
    planPnlPct: planInvested > 0 ? ((planValue - planInvested) / planInvested) * 100 : 0,
    holdInvested,
    holdValue,
    holdPnl: holdValue - holdInvested,
    holdPnlPct: holdInvested > 0 ? ((holdValue - holdInvested) / holdInvested) * 100 : 0,
    allInPnl,
  }
}

/** 매도비용 비율(화면이 '약'이라고 밝히는 데 쓴다). */
export const SELL_COST_PCT = DEFAULT_SELL_COST_PCT

/**
 * 측정된 중간값만큼 더 빠지는 경우의 가격. 시나리오의 기준점이자, 2·3차 사다리가
 * 감싸고 있는 바로 그 값이다.
 */
export const MEDIAN_FURTHER_DROP = 0.15

/**
 * 화면에 띄울 기본 시나리오 다섯 개.
 *
 * **가격을 지어내지 않는다** — 전부 손에 있는 값에서 나온다: 현재가, 측정된 중간
 * 하락폭(-15%), 이 종목의 **실제 구간 저가**, 사용자의 평단, 그리고 **사다리 자신의
 * 마지막 위쪽 차수**(반등 시나리오의 기준점). 목표가나 컨센서스는 넣지 않는다
 * (이 라이브러리는 예측을 다루지 않는다).
 *
 * 확률은 붙이지 않는다. 어느 쪽이 얼마나 그럴듯한지 이 코드는 모르고, 숫자를 붙이면
 * 예측처럼 읽힌다. 다섯 개를 고른 기준은 **서로 다른 결론을 내는 경우**를 덮는 것이다:
 * 더 빠지는 경우 / 바닥을 재확인하는 경우 / 회복하는 경우 / 안 빠지고 오르는 경우 /
 * 반등만 하고 평단까지는 못 가는 경우.
 */
export function defaultScenarios(
  input: PlanInput,
  plan: AverageDownPlan,
  periodLow: number,
): ScenarioOutcome[] {
  const { price, avgCost } = input
  const medianDown = Math.round(price * (1 - MEDIAN_FURTHER_DROP))
  const low = periodLow > 0 && periodLow < price ? periodLow : medianDown
  // 사다리의 가장 높은 위쪽 차수 — 없으면(dip 사다리) 현재가.
  const topTrigger = plan.tranches.reduce(
    (hi, t) => (t.direction === 'rebound' && t.triggerPrice > hi ? t.triggerPrice : hi),
    price,
  )
  const S = (label: string, lo: number, hi: number, end: number) =>
    evaluateScenario(input, plan, label, lo, hi, end)
  return [
    S(`여기서 ${Math.round(MEDIAN_FURTHER_DROP * 100)}% 더 빠진 채로 끝`, medianDown, price, medianDown),
    S('구간 저가까지 갔다가 지금 가격 회복', low, price, price),
    S('구간 저가까지 갔다가 내 평단 회복', low, avgCost, avgCost),
    S('안 빠지고 바로 평단 회복', price, avgCost, avgCost),
    // 반등 사다리가 노리는 바로 그 경우 — 마지막 위쪽 차수까지 올라와서 거기서 멈춤.
    S('안 빠지고 반등해서 마지막 차수 가격에서 끝', price, topTrigger, topTrigger),
  ]
}

/**
 * **실행 계획** — 사다리와 시간 계획을 "오늘 뭘 하면 되는지"로 바꾼다.
 *
 * 왜 따로 만드나: 화면에 사다리(얼마에)와 타임라인(언제)이 따로 있으면, 둘을
 * 머릿속에서 합쳐야 비로소 행동이 나온다. 그 합치는 일을 사람에게 떠넘기면
 * 대개 **아무것도 안 하거나 그날 기분대로 산다** — 물타기가 실패하는 전형적인
 * 경로이고, 이 파일 맨 위가 '가격 사다리'를 고른 이유와 같은 문제다.
 *
 * 그래서 날짜가 박힌 단계로 바꾼다. 각 단계는 **그대로 증권사에 넣을 수 있는
 * 주문**이거나 **달력에 적을 수 있는 날**이거나 **취소 조건**이다.
 *
 * 새 판단을 넣지 않는다 — 전부 `buildAverageDownPlan`과 `CYCLE_TIMELINE`에서
 * 파생한다. 여기서 숫자를 새로 고르면 근거가 두 군데로 갈린다.
 */
export type ActionKind = 'now' | 'order' | 'deadline' | 'stop' | 'never'

export interface ActionStep {
  kind: ActionKind
  /** 한 줄 제목 — 행동을 그대로 쓴다("오늘 1차 11주 매수"). */
  title: string
  /** 왜 그렇게 하는지 한 줄. */
  why: string
  /** 'YYYY-MM-DD' — 날짜가 있는 단계만. */
  by?: string
}

/** 달을 더한다. 말일 넘침은 그 달 말일로 당긴다(3/31 + 1개월 = 4/30). */
export function addMonths(d: Date, months: number): Date {
  const day = d.getDate()
  const out = new Date(d.getFullYear(), d.getMonth() + months, 1)
  out.setDate(Math.min(day, new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()))
  return out
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * 바닥을 찍은 날로부터 지금까지 몇 개월인가. **상수로 두지 않는다** — 시간이
 * 지나는 것만으로 화면이 조용히 틀린 말을 하게 된다. 날짜를 모르면 측정 시점의
 * 값(`CYCLE_TIMELINE.monthsAfterTrough`)으로 떨어진다.
 */
export function monthsSince(troughDate: string | undefined, today: Date): number | null {
  if (!troughDate) return null
  const d = new Date(`${troughDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  const m = (today.getFullYear() - d.getFullYear()) * 12 + (today.getMonth() - d.getMonth())
  return Math.max(0, today.getDate() >= d.getDate() ? m : m - 1)
}

/**
 * **그 저가를 아직 "바닥"이라고 불러도 되는가.**
 *
 * `CYCLE_TIMELINE`과 `basing` 사다리는 전부 *"바닥을 지나 회복하는 중"*을 전제로 한다.
 * 그런데 구간 저가 **뒤에 고가를 찍고 다시 내려온** 종목이라면 그 저가는 이미 지나간
 * 바닥이고, 지금 자리는 "바닥에서 N개월차"가 아니라 **"새 고점에서 내려온 자리"**다.
 * 전혀 다른 상황인데 화면은 둘을 구분하지 못하고 있었다.
 *
 * 실제로 SK하이닉스가 그랬다(2026-11-12 사용자 지적, position_signals_probe 실측):
 *
 *   구간 저가 806,000 (2026-03-31) → 구간 고가 2,987,000 (2026-06-25) → 현재 1,251,000
 *
 * 저가에서 +55% 위인 건 맞지만 그 사이에 **+271% 올랐다가 −58% 빠진** 것이라
 * "바닥에서 8개월차 회복 중"은 이 종목을 전혀 설명하지 못한다. 그런데도 화면은
 * "늦지도 이르지도 않습니다"라고 적고 있었다 — **조용히 틀린 게 아니라 큰 소리로
 * 틀린 말**이었다.
 *
 * 날짜를 비교하면 가려낼 수 있으므로, 전제가 성립하는지를 화면이 직접 판정한다.
 */
export type TroughStatus = 'confirmed' | 'superseded' | 'unknown'

export function troughStatus(lowDate?: string, highDate?: string): TroughStatus {
  if (!lowDate || !highDate) return 'unknown'
  // 같은 날이면 가릴 수 없다 — 모르는 것을 '성립한다'로 밀지 않는다.
  if (lowDate === highDate) return 'unknown'
  return highDate > lowDate ? 'superseded' : 'confirmed'
}

export function buildActionPlan(
  plan: AverageDownPlan,
  today: Date,
  /** 구간 저가. 이걸 깨면 참고할 자리가 없어진다. */
  troughPrice: number,
  /** 그 저가를 찍은 날. 없으면 측정 시점의 개월 수를 쓴다. */
  troughDate?: string,
  /** 그 저가가 아직 '바닥'인지 — 뒤에 고가를 찍었으면 'superseded'다. */
  status: TroughStatus = 'confirmed',
  timeline: CycleTimeline = CYCLE_TIMELINE,
): ActionStep[] {
  const monthsAfter = monthsSince(troughDate, today) ?? timeline.monthsAfterTrough
  // 시한은 "바닥에서 12개월차"다 — 측정이 그 지점을 가리킨다. 지금이 이미 그보다
  // 뒤라면 더 기다릴 근거가 없으므로 0개월(= 오늘)이 된다.
  //
  // **전제가 깨진 종목에는 그 기준점이 없다.** 저가 뒤에 고가를 찍고 내려온
  // 자리라면 "바닥에서 12개월차"가 가리키는 날이 아무 의미가 없으므로, 측정에서
  // 날짜를 끌어오지 않고 **오늘부터 같은 기간**을 스스로 정한 기한으로 둔다.
  const deadlineMonths =
    status === 'confirmed'
      ? Math.max(0, timeline.monthsAfterTrough + timeline.deadlineMonthsAhead - monthsAfter)
      : timeline.deadlineMonthsAhead
  const w = (n: number) => Math.round(n).toLocaleString('ko-KR')
  const first = plan.tranches[0]
  const rest = plan.tranches.slice(1)
  const deadline = addMonths(today, deadlineMonths)
  const restCost = rest.reduce((a, t) => a + t.cost, 0)

  const steps: ActionStep[] = [
    {
      kind: 'now',
      title: `오늘 ${first.qty}주 매수 (${w(first.triggerPrice)}원 · ${w(first.cost)}원)`,
      why:
        status === 'confirmed'
          ? `바닥에서 ${monthsAfter}개월차인 지금이 과거 평균 경로 위이고, ` +
            `그 자리에서 산 경우가 더 미룬 경우보다 꾸준히 나았다. 미룰 근거가 측정에 없다.`
          : `이 종목은 구간 저가 뒤에 고가를 찍고 다시 내려온 자리라 "바닥을 지나 회복 중"이 ` +
            `아니다 — 지금 사는 근거는 측정이 아니라 당신의 판단이다. 1차를 절반으로 둔 것은 ` +
            `그 판단이 틀렸을 때를 위해 나머지를 남겨 두려는 것이다.`,
      by: iso(today),
    },
  ]

  if (rest.length > 0) {
    steps.push({
      kind: 'order',
      title:
        `나머지 ${w(restCost)}원은 지정가 예약주문으로 걸어 둔다 — ` +
        rest.map((t) => `${w(t.triggerPrice)}원 ${t.qty}주`).join(' · '),
      why:
        `걸어 두지 않으면 막상 빠졌을 때 무서워서 못 산다. 과거에 ${timeline.dipProbabilityPct}%는 ` +
        `${timeline.dipRangeAhead[0]}~${timeline.dipRangeAhead[1]}개월 안에 지금보다 싸졌고 ` +
        `그 깊이가 중간값 ${timeline.dipDepthPct}%였다 — 이 칸들이 그 자리다.`,
    })
    steps.push({
      kind: 'deadline',
      title: `${iso(deadline)}까지 안 걸린 칸은 그날 시세로 그냥 산다`,
      why:
        status === 'confirmed'
          ? `기다리는 것 자체가 비용이다. 같은 종목이라도 바닥에서 멀어질수록 남는 게 줄었다` +
            `(국내 ${timeline.entryByMonth[0].month}개월차 +${timeline.entryByMonth[0].kr}% → ` +
            `${timeline.entryByMonth[2].month}개월차 +${timeline.entryByMonth[2].kr}%).`
          : `이 날짜는 측정에서 나온 것이 아니라 **스스로 정한 기한**이다 — 이 종목은 ` +
            `"바닥 이후" 표본에 해당하지 않아 기준점이 없다. 그래도 기한을 두는 이유는, ` +
            `안 걸린 돈이 계획에서 조용히 사라지지 않게 하려는 것이다.`,
      by: iso(deadline),
    })
  }

  steps.push({
    kind: 'stop',
    title: `종가가 ${w(troughPrice)}원을 깨면 남은 주문을 취소하고 멈춘다`,
    why:
      `이 구간에서 실제로 찍었던 가장 낮은 가격이다. 그 아래로 내려가면 참고할 자리가 ` +
      `없어지므로 계획을 이어가지 말고, 더 깊은 사다리(사이클 실측형·더 빠질 때 싣기)로 ` +
      `다시 짜야 한다.`,
  })

  steps.push({
    kind: 'never',
    title: `${w(plan.stopBuyingAbove)}원(지금 평단) 위에서는 사지 않는다`,
    why: '그 위에서 사면 평단이 올라간다 — 물타기의 목적과 정반대다.',
  })

  return steps
}
