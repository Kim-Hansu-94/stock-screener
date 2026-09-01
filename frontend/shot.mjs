// 화면 확인용 스크린샷. 폭을 인자로 받고 가로 넘침 px을 같이 출력한다.
// 넘침이 0이 아니면 그 폭에서 페이지가 잘린 것이다(표가 있는 화면에서 자주 난다).
//
//   node shot.mjs <url> <out.png> [width=390]
//
// 브라우저는 이미지에 깔려 있는 것을 쓴다(PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers).
// playwright-core는 앱 런타임에 안 쓰이므로 package.json에는 넣지 않는다. 쓸 때만 설치:
//   npm install --no-save playwright-core
import { chromium } from 'playwright-core'

const [url, out, widthArg] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node shot.mjs <url> <out.png> [width]')
  process.exit(1)
}
const width = Number(widthArg ?? 390)

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const page = await browser.newPage({ viewport: { width, height: 900 } })
await page.goto(url, { waitUntil: 'networkidle' })

const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
)
await page.screenshot({ path: out, fullPage: true })
await browser.close()

console.log(`${out} @${width}px — 가로 넘침 ${overflow}px${overflow > 0 ? '  ⚠️ 잘림' : ''}`)
