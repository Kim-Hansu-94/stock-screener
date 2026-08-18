<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# DB 없이 화면 확인하기

작업용 컨테이너에는 Supabase 자격증명이 없다. 그래도 배포 전에 여기까지는 확인할 수 있으니
"환경에 키가 없어서 못 본다"고 넘기지 말 것.

```bash
# 빌드·타입체크 — 더미 값이면 프리렌더까지 통과한다 (키 없이 돌리면 여기서 멈춘다)
SUPABASE_URL="https://dummy.supabase.co" SUPABASE_SERVICE_KEY="dummy" npx next build

# 렌더 결과 눈으로 보기 — /dev/preview에 픽스처로 채운 컴포넌트 미리보기가 있다
SUPABASE_URL="https://dummy.supabase.co" SUPABASE_SERVICE_KEY="dummy" npx next dev -p 3111
# 그 다음 playwright-core로 스크린샷 (브라우저는 /opt/pw-browsers/chromium에 이미 있다)
```

`/dev/preview`는 production에서 notFound()로 막혀 있다. 새 컴포넌트를 만들면 여기에 케이스를
추가할 것 — **특히 "표본/값이 없을 때"와 "부호가 반대일 때"**. 이 둘은 실제 데이터로는 좀처럼
안 나와서 테스트·타입체크를 다 통과한 채로 배포되기 쉽다(실제로 그런 적 있음).

## 모바일 폭도 같이 볼 것

표를 만들면 폰에서 페이지 전체가 가로로 밀려 네비게이션까지 깨진다. `overflow-x-auto`만
걸면 부족하다 — 부모에 `min-w-0`이 없으면 컨테이너가 내용에 끌려 늘어난다. 열이 많은 표는
폰에서 카드로 갈아끼우는 게 답이다(`md:hidden` / `hidden md:block`).

스크린샷 스크립트는 폭을 인자로 받고, **가로 넘침 px을 같이 출력한다**. 0이 아니면 잘린 것이다.

```bash
node shot.mjs http://localhost:3111/dev/preview out.png 390   # 폰
node shot.mjs http://localhost:3111/dev/preview out.png 320   # 좁은 폰
node shot.mjs http://localhost:3111/dev/preview out.png 1000  # 데스크톱
```
