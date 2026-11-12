/**
 * `next/cache`와 `server-only`를 바꿔치기해, **화면이 쓰는 쿼리 함수를 그대로** Node에서 돌리게 한다.
 *
 * 왜 필요한가
 * -----------
 * `lib/queries/*`의 함수들은 본문 첫 줄이 `'use cache'`이고 `cacheLife`/`cacheTag`를 부른다.
 * `'use cache'`는 순수 JS에서 그냥 문자열 한 줄(무해한 no-op)이지만 `next/cache` import는
 * 실제 모듈이라, Next 밖에서 부르면 요청 컨텍스트가 없어 깨진다.
 *
 * 그래서 **쿼리 코드를 프로브에 복붙하지 않는다.** `getScorecardTrades`는 70줄,
 * `getPatternRecommendations`는 65줄이고 종목 중복 제거·피벗 앞구간 확보·월별 묶음 같은
 * 규칙이 그 안에 들어 있다. 복제하면 **"프로브는 이렇다는데 화면은 다르다"가 가능해진다** —
 * 이 저장소가 `opportunityScore.ts` ↔ `watchlist.py`에서 겪고 있는 그 동기화 지점을
 * 진단 때문에 새로 만드는 셈이다. 캐시만 무력화하고 본체는 손대지 않는 쪽을 택했다.
 *
 * 캐시를 끄는 건 진단에 오히려 맞다 — 캐시된 옛 값이 아니라 지금 DB를 읽는다.
 *
 * `server-only`도 같이 돌려놓는다. `lib/supabase.ts`가 그걸 import하는데 순수 Node에서는
 * **던지도록 만들어진 모듈**이다("This module cannot be imported from a Client Component").
 * 다만 그 패키지는 `exports`에 `react-server` 조건으로 **빈 파일(`empty.js`)을 직접 싣고
 * 있고** Next가 서버 쪽에서 쓰는 게 바로 그 파일이다. 그래서 가짜를 지어내지 않고
 * **그 `empty.js`로 보낸다** — Next가 하는 해석과 같다.
 *
 * 사용: node --import ./research/resolveTsImports.mjs \
 *            --import ./research/stubNextCache.mjs research/<스크립트>.ts
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = `
export const cacheLife = () => {}
export const cacheTag = () => {}
export const revalidateTag = () => {}
export const revalidatePath = () => {}
export const unstable_cache = (fn) => fn
`

const STUB_URL = `data:text/javascript,${encodeURIComponent(SRC)}`

const emptyFile = new URL('../node_modules/server-only/empty.js', import.meta.url)
const SERVER_ONLY_EMPTY = existsSync(fileURLToPath(emptyFile))
  ? emptyFile.href
  : 'data:text/javascript,'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/cache') {
      return { url: STUB_URL, format: 'module', shortCircuit: true }
    }
    if (specifier === 'server-only') {
      // 패키지가 react-server 조건으로 싣고 있는 빈 파일 — Next도 서버에서 이걸 쓴다.
      // `exports`가 './empty.js' 서브패스를 안 열어 둬서 이름으로는 못 가져오므로
      // 파일을 직접 가리킨다. 없으면 빈 모듈로 떨어진다(empty.js 자체가 빈 파일이다).
      return { url: SERVER_ONLY_EMPTY, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
