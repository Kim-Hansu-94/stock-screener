// capital-sigungu.json의 인천 폴리곤을 2026-07-01 개편에 맞춰 다시 그린다.
//
//   node frontend/lib/data/splitIncheon.mjs            # 미리보기만
//   node frontend/lib/data/splitIncheon.mjs --write    # 실제로 저장
//
// **왜 스크립트로 남기는가.** 지도 좌표 원본(2018 SGIS)을 만든 스크립트는
// "경계가 거의 안 바뀐다"는 이유로 저장하지 않았는데, 실제로는 바뀌었다.
// 이번 분할은 새 경계 데이터를 구한 게 아니라 **기존 폴리곤을 갈라낸 것**이라
// 규칙을 글로만 적어두면 나중에 맞는지 확인할 길이 없다. 그래서 규칙을
// 실행 가능한 형태로 남긴다.
//
// **중구는 서브패스 14개이고 내륙과 섬이 좌표로 깨끗하게 갈린다.**
// 실측(2026-10-27): 한 개(x 218.8~234.8)만 동구·미추홀구 bbox와 겹치는 내륙이고,
// 나머지 13개는 전부 x ≤ 218.2에 있는 영종도 일대 섬이다. 개편 내용이 정확히
// "중구 내륙 + 동구 → 제물포구 / 중구 도서 → 영종구"라 이 선이 곧 구 경계다.
//
// **서구(28260)는 손대지 않는다.** 검단구와 서해구가 한 덩어리(144점 패스 하나)로
// 들어 있어 가를 선이 데이터 안에 없다. 눈대중으로 가로선을 긋는 건 "조용히 틀린
// 값"을 만드는 짓이라 하지 않는다 — 그쪽은 realestateTrend.ts의
// SPLIT_REGION_CHILDREN이 둘을 합쳐 옛 폴리곤에 칠하는 방식으로 남겨둔다.
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = new URL('./capital-sigungu.json', import.meta.url)
const JUNG_GU = '28110' // 옛 인천 중구
const DONG_GU = '28140' // 옛 인천 동구
// 내륙 서브패스를 가르는 x 좌표. 내륙은 218.8부터, 가장 동쪽 섬은 218.2에서 끝난다.
const MAINLAND_MIN_X = 218.5

const subpaths = (d) => d.split(/(?=M)/).filter((s) => s.trim())
const pointsOf = (d) => {
  const nums = (d.match(/-?\d+\.?\d*/g) ?? []).map(Number)
  return nums.reduce((acc, _, i) => (i % 2 ? acc : [...acc, [nums[i], nums[i + 1]]]), [])
}
const maxX = (d) => Math.max(...pointsOf(d).map(([x]) => x))

/** 폴리곤 무게중심. 라벨을 가장 큰 조각 한가운데에 놓으려고 쓴다. */
function centroid(d) {
  const pts = pointsOf(d)
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < pts.length; i += 1) {
    const [x0, y0] = pts[i]
    const [x1, y1] = pts[(i + 1) % pts.length]
    const cross = x0 * y1 - x1 * y0
    a += cross
    cx += (x0 + x1) * cross
    cy += (y0 + y1) * cross
  }
  a /= 2
  // 면적이 0이면(점 몇 개짜리 섬) bbox 중앙으로 떨어뜨린다.
  if (!a) {
    const xs = pts.map(([x]) => x)
    const ys = pts.map(([, y]) => y)
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2]
  }
  return [cx / (6 * a), cy / (6 * a)]
}

const area = (d) => {
  const pts = pointsOf(d)
  return Math.abs(
    pts.reduce((sum, [x0, y0], i) => {
      const [x1, y1] = pts[(i + 1) % pts.length]
      return sum + (x0 * y1 - x1 * y0)
    }, 0) / 2,
  )
}

/** 점이 폴리곤 안에 있나 (광선 교차 홀짝). 서브패스 전부를 한 번에 센다. */
function contains(d, px, py) {
  let inside = false
  for (const sp of subpaths(d)) {
    const pts = pointsOf(sp)
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
      const [xi, yi] = pts[i]
      const [xj, yj] = pts[j]
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
    }
  }
  return inside
}

/**
 * 라벨 자리 — **겹치지 않는 자리 중 무게중심에서 가장 가까운 점**을 격자로 찾는다.
 *
 * 무게중심을 그냥 쓰면 안 된다. 제물포구는 항만을 낀 좁고 긴 띠라 무게중심이
 * 미추홀구 라벨과 거의 같은 높이에 떨어져서, 네 글자짜리 이름이 옆 라벨을 파고든다
 * (2026-10-27 실제로 그렇게 나왔다). 지도는 확대해도 글자와 도형이 같이 커지므로
 * **겹침은 배율과 무관하게 그대로 남는다** — 자리를 옮기는 수밖에 없다.
 *
 * 반대로 "다른 라벨에서 가장 먼 점"을 고르면 이번엔 영종구 라벨이 섬 서쪽 끝까지
 * 밀려난다. 그래서 겹침은 **통과/탈락**으로만 보고, 통과한 것 중에서는 무게중심에
 * 가장 가까운 자리를 고른다 — 평소엔 가운데, 부딪힐 때만 비켜난다.
 */
const CHAR_W = 5.5 // fontSize와 같다(RealestateMap.tsx). 글자 하나 폭의 근사치.
const LINE_H = 6 // 글자 높이 + 약간의 여유

function labelPoint(d, name, others) {
  const halfW = (name.length * CHAR_W) / 2
  const pts = subpaths(d).flatMap(pointsOf)
  const xs = pts.map(([x]) => x)
  const ys = pts.map(([, y]) => y)
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const biggest = subpaths(d).reduce((a, b) => (area(a) > area(b) ? a : b))
  const [gx, gy] = centroid(biggest)

  const clear = (px, py) =>
    others.every(
      ([ox, oy, oName]) =>
        Math.abs(px - ox) >= halfW + (oName.length * CHAR_W) / 2 || Math.abs(py - oy) >= LINE_H,
    )

  const STEPS = 80
  let best = null
  for (let i = 1; i < STEPS; i += 1) {
    for (let j = 1; j < STEPS; j += 1) {
      const px = x0 + ((x1 - x0) * i) / STEPS
      const py = y0 + ((y1 - y0) * j) / STEPS
      if (!contains(d, px, py) || !clear(px, py)) continue
      const dist = Math.hypot(px - gx, py - gy)
      if (!best || dist < best.dist) best = { px, py, dist }
    }
  }
  // 어디에 놓아도 부딪히면 무게중심에 둔다 — 서울처럼 원래 빽빽한 곳의 기존 동작과 같다.
  const [fx, fy] = best ? [best.px, best.py] : [gx, gy]
  if (!best) console.warn(`  (${name}: 겹치지 않는 자리가 없어 무게중심에 둔다)`)
  return [Math.round(fx * 100) / 100, Math.round(fy * 100) / 100]
}

const data = JSON.parse(readFileSync(FILE, 'utf8'))
const byCode = Object.fromEntries(data.regions.map((r) => [r.region_code, r]))
const jung = byCode[JUNG_GU]
const dong = byCode[DONG_GU]
if (!jung || !dong) {
  console.error('옛 중구·동구가 이미 없다 — 이 스크립트는 한 번만 돌린다.')
  process.exit(1)
}

const parts = subpaths(jung.d)
const mainland = parts.filter((s) => maxX(s) >= MAINLAND_MIN_X)
const islands = parts.filter((s) => maxX(s) < MAINLAND_MIN_X)
if (mainland.length !== 1) {
  // 갈라지는 선이 하나가 아니면 전제가 깨진 것이다. 조용히 이상한 지도를 만드느니 멈춘다.
  console.error(`내륙 조각이 ${mainland.length}개다(1개여야 한다). MAINLAND_MIN_X를 다시 볼 것.`)
  process.exit(1)
}

const jemulpoD = mainland[0] + dong.d
const yeongjongD = islands.join('')
// 옛 중구·동구를 뺀 나머지 지역의 라벨 자리를 피해야 할 지점으로 넘긴다.
const otherLabels = data.regions
  .filter((r) => r.region_code !== JUNG_GU && r.region_code !== DONG_GU)
  .map((r) => [r.cx, r.cy, r.region_name.replace(/^(서울|인천)\s/, '')])
const [jx, jy] = labelPoint(jemulpoD, '제물포구', otherLabels)
const [yx, yy] = labelPoint(yeongjongD, '영종구', [...otherLabels, [jx, jy, '제물포구']])

const replacement = [
  { region_code: '28125', region_name: '인천 제물포구', d: jemulpoD, cx: jx, cy: jy },
  { region_code: '28155', region_name: '인천 영종구', d: yeongjongD, cx: yx, cy: yy },
]

console.log(`중구 서브패스 ${parts.length}개 → 내륙 ${mainland.length} · 섬 ${islands.length}`)
for (const r of replacement) {
  console.log(`  ${r.region_code} ${r.region_name}: ${r.d.length}자, 라벨 (${r.cx}, ${r.cy})`)
}

// 옛 중구 자리에 새 둘을 끼워 넣는다(순서를 지켜야 그리는 차례가 안 흐트러진다).
const out = data.regions.flatMap((r) => {
  if (r.region_code === JUNG_GU) return replacement
  if (r.region_code === DONG_GU) return []
  return [r]
})

if (process.argv.includes('--write')) {
  // 원본이 한 줄로 압축된 형식이라 그대로 맞춘다 — 들여쓰기를 넣으면 파일이
  // 몇 배로 불어나고 diff가 통째로 바뀌어 무엇이 달라졌는지 안 보인다.
  writeFileSync(FILE, JSON.stringify({ ...data, regions: out }))
  console.log(`저장 완료 — 지역 ${data.regions.length}개 → ${out.length}개`)
} else {
  console.log(`(미리보기) 지역 ${data.regions.length}개 → ${out.length}개. --write를 주면 저장한다.`)
}
