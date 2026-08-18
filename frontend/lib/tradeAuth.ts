import { timingSafeEqual } from 'node:crypto'

/**
 * 매매 기록 쓰기 잠금.
 *
 * 이 사이트는 로그인 없이 공개돼 있다. 조회는 그대로 열어두되, 매수/매도처럼
 * 기록을 바꾸는 요청은 PIN을 확인한다. PIN은 Vercel 환경변수(TRADE_PIN)에 두고
 * 브라우저는 한 번 입력한 값을 localStorage에 들고 있다가 헤더로 보낸다.
 *
 * 한계를 분명히 해두면: 이건 "URL을 우연히 아는 사람"을 막는 장치이지 제대로 된
 * 인증이 아니다. PIN을 아는 사람은 누구나 쓸 수 있다. 개인용 도구라 이 수준으로 둔다.
 */
export const TRADE_PIN_HEADER = 'x-trade-pin'

export type PinCheck = { ok: true } | { ok: false; status: number; error: string }

export function checkTradePin(request: Request): PinCheck {
  const expected = process.env.TRADE_PIN
  if (!expected) {
    return { ok: false, status: 500, error: 'TRADE_PIN 환경변수가 설정되지 않았습니다.' }
  }

  const given = request.headers.get(TRADE_PIN_HEADER) ?? ''
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  // 길이가 다르면 timingSafeEqual이 던지므로 먼저 걸러낸다. 길이 노출은 감수한다.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, status: 401, error: 'PIN이 올바르지 않습니다.' }
  }
  return { ok: true }
}
