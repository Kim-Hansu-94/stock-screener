import { connect } from 'node:tls'
import { connection } from 'next/server'

// 임시 진단 — 국토부 API(apis.data.go.kr)가 "이 서버"에서 열리는지 재본다.
//
// 배경: 부동산 수집이 GitHub Actions 실행 서버 중 일부에서만 국토부에 연결이 안 된다
// (같은 순간 12개 중 2개가 `TimeoutError`, 나머지는 0.3초에 연결 — 2026-09-29 실측).
// IP에 따라 갈리는 것이라 GitHub 서버로는 고칠 수 없다. 그래서 고정된 다른 곳(Vercel 서울)에서
// 붙는지 먼저 재본다. 추측으로 수집기를 옮기지 않으려는 것이다.
//
// 이 함수가 실제로 어느 지역·어느 IP에서 돌았는지도 같이 돌려준다 — "서울에서 재봤다"는
// 주장이 맞는지 결과만 보고 확인할 수 있어야 한다. API 키는 쓰지 않는다(TCP+TLS 연결만 잰다).
// 원인이 가려지면 이 라우트와 vercel.json의 regions는 지울 것.

const TARGET = 'apis.data.go.kr'
const CONTROLS = ['opendart.fss.or.kr', 'm.stock.naver.com']
const TRIES = 5
const TIMEOUT_MS = 8000

type Attempt = { ok: boolean; ms: number; error?: string }

function tryConnect(host: string): Promise<Attempt> {
  const start = Date.now()
  return new Promise((resolve) => {
    const socket = connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS })
    const done = (a: Attempt) => {
      socket.destroy()
      resolve(a)
    }
    socket.once('secureConnect', () => done({ ok: true, ms: Date.now() - start }))
    socket.once('timeout', () => done({ ok: false, ms: Date.now() - start, error: 'timeout' }))
    socket.once('error', (e) => done({ ok: false, ms: Date.now() - start, error: e.message }))
  })
}

async function probeHost(host: string) {
  const attempts: Attempt[] = []
  for (let i = 0; i < TRIES; i++) attempts.push(await tryConnect(host))
  const ok = attempts.filter((a) => a.ok)
  return {
    host,
    success: `${ok.length}/${TRIES}`,
    avgMs: ok.length ? Math.round(ok.reduce((s, a) => s + a.ms, 0) / ok.length) : null,
    firstError: attempts.find((a) => !a.ok)?.error ?? null,
  }
}

async function egressIp(): Promise<string> {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(5000) })
    return (await res.text()).trim()
  } catch (e) {
    return `확인 실패: ${e instanceof Error ? e.message : String(e)}`
  }
}

export async function GET() {
  // 요청 시점에 실행되게 강제한다 — 빌드 때 한 번 재고 굳으면 진단이 아니다.
  await connection()

  const [ip, target, ...controls] = await Promise.all([
    egressIp(),
    probeHost(TARGET),
    ...CONTROLS.map(probeHost),
  ])

  return Response.json(
    {
      at: new Date().toISOString(),
      // Vercel이 이 함수를 실제로 돌린 지역 (예: icn1 = 서울, iad1 = 워싱턴)
      vercelRegion: process.env.VERCEL_REGION ?? null,
      egressIp: ip,
      target,
      controls,
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
