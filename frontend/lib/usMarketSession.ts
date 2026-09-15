// 미국장 스냅샷이 "확정 종가"인지 "장중 시세"인지 가려내는 순수 계산.
//
// 왜 필요한가: 2026-09-15까지 미국 지수는 **끝난 장의 종가만** 받아왔다
// (`market_indices.py`의 `_us_snapshot`이 오늘 봉을 빼고 조회했다). 그래서 화면에
// "장마감 기준"이라고 못박아도 늘 맞았다. 이제 지수 수집이 4시간마다 돌고 오늘 봉도
// 받으므로, 미국장이 열려 있는 시간(한국시간 22:30~05:00)에 도는 실행은 **아직 안 끝난
// 봉**을 가져온다 — 그걸 "마감 종가"라고 적으면 거짓말이 된다.
//
// DB에 따로 플래그를 두지 않고 여기서 판정한다. 스냅샷에 이미 두 값이 다 있기 때문이다:
//   date       = 그 봉의 미국 거래일
//   updated_at = 우리가 그 값을 저장한 시각
// 저장 시각이 그 거래일의 마감(16:00 ET)보다 이르면 아직 장중이었다는 뜻이다.
// 컬럼을 늘리면 Supabase 마이그레이션을 손으로 돌려야 하고, 안 돌리면 화면이 조용히
// 틀린 말을 하게 된다(CLAUDE.md "알려진 이슈" 참고) — 파생할 수 있으면 파생한다.

/** 미국 동부 표준시. 서머타임(EDT/EST)은 Intl이 알아서 처리한다 — 직접 계산하지 말 것. */
const US_MARKET_TZ = 'America/New_York'

/** 뉴욕증권거래소 정규장 마감(현지 16:00). 채권 시장도 대체로 같은 시각에 닫힌다. */
const US_CLOSE_HOUR = 16

/** 그 시점에 해당 표준시가 UTC보다 몇 밀리초 앞서 있는지 (서머타임 반영). */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs))
  const at = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  // hour12:false인데도 자정을 '24'로 주는 구현이 있어 24로 나눈 나머지를 쓴다.
  const asIfUtc = Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'))
  return asIfUtc - instantMs
}

/** `YYYY-MM-DD` 미국 거래일의 장 마감(16:00 ET) 시각을 UTC 밀리초로. 형식이 틀리면 NaN. */
export function usSessionCloseMs(tradingDate: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tradingDate)
  if (!m) return Number.NaN
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), US_CLOSE_HOUR)
  // 오프셋 자체가 시점에 따라 달라지므로(서머타임 경계) 한 번 추정하고 그 시점으로 다시 잰다.
  const first = wall - zoneOffsetMs(wall, US_MARKET_TZ)
  return wall - zoneOffsetMs(first, US_MARKET_TZ)
}

export type UsBarStatus = 'final' | 'intraday' | 'unknown'

/**
 * 이 스냅샷이 확정 종가인가, 아직 움직이는 장중 값인가.
 *
 * 판정할 수 없으면 `'unknown'`이다 — 모르는 것을 'final'로 밀면 화면이 "마감 종가"라고
 * 단정하게 되므로, 확신이 없으면 화면이 아무 주장도 하지 않게 둔다.
 */
export function usBarStatus(tradingDate: string, updatedAt: string): UsBarStatus {
  const closeMs = usSessionCloseMs(tradingDate)
  const savedMs = Date.parse(updatedAt)
  if (!Number.isFinite(closeMs) || !Number.isFinite(savedMs)) return 'unknown'
  return savedMs < closeMs ? 'intraday' : 'final'
}

/** 저장 시각을 한국시간 `9/16 02:14`로. 서버·클라이언트 어디서 그려도 같게 나오도록 표준시를 고정한다. */
export function formatKstDateTime(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))
  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${at('month')}/${at('day')} ${String(Number(at('hour')) % 24).padStart(2, '0')}:${at('minute')}`
}
