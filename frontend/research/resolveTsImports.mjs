/**
 * Node로 `.ts`를 그대로 돌릴 때 **확장자 없는 상대 import**를 `.ts`로 이어주는 훅.
 *
 * 왜 필요한가
 * -----------
 * Node 22는 타입만 벗겨 `.ts`를 실행하지만 **확장자를 해석해 주지는 않는다**.
 * `backtestEtfStage.ts`가 지금까지 멀쩡했던 건 `etfEntryCheck.ts`가 런타임 import
 * 없이 타입만(`import type`) 가져오기 때문이다 — 타입 import는 통째로 지워지므로
 * 해석할 게 없다. 반면 `supportSignals.ts`는 `./calculations`에서 **함수**를
 * 가져오므로 실제로 파일을 찾아야 하고, 그대로 돌리면 ERR_MODULE_NOT_FOUND가 난다.
 *
 * 화면이 쓰는 소스를 프로브 사정으로 고치지 않으려고(`'./calculations.ts'`로 바꾸면
 * Next·SWC 쪽을 건드리는 셈이다) 해석만 여기서 거든다.
 *
 * 사용: node --import ./research/resolveTsImports.mjs research/<스크립트>.ts
 */

import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    // 확장자가 이미 있거나 패키지 이름이면 손대지 않는다.
    if (!specifier.startsWith('.') || /\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(specifier, context)
    }
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      // `./calculations` → `./calculations.ts`가 실제로 있으면 그걸로 잇는다.
      for (const ext of ['.ts', '.tsx', '/index.ts']) {
        const candidate = new URL(specifier + ext, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return nextResolve(specifier + ext, context)
        }
      }
      throw err
    }
  },
})
