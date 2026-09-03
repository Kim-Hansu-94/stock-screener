/**
 * 클라이언트에서 매매/감시목록 PIN을 물어보고 localStorage에 저장하는 공용 로직.
 * TradeButton(매수/매도)과 WatchlistActions(감시 종목 추가/삭제)가 같은 PIN을 쓴다 —
 * 한 번만 입력하면 두 기능 다 바로 쓸 수 있다.
 */
const PIN_KEY = 'treasure-map-trade-pin'

export function askPin(promptText = '매매 기록을 바꾸려면 PIN을 입력하세요.'): string | null {
  const saved = localStorage.getItem(PIN_KEY)
  if (saved) return saved
  const entered = window.prompt(promptText)
  if (!entered) return null
  localStorage.setItem(PIN_KEY, entered)
  return entered
}

export function clearPin(): void {
  localStorage.removeItem(PIN_KEY)
}
