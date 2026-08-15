#!/usr/bin/env node
/**
 * Compose the macOS dock icon from brand/duke.svg.
 *
 * Full-bleed space-black field, original Duke drawing, then a squircle
 * alpha mask so the dock matches neighboring apps (the system will not
 * remask a custom-shaped icon). Then: `tauri icon brand/app-icon.png`.
 *
 * Requires @resvg/resvg-js and pngjs (dev one-off).
 * Usage: node brand/render-icons.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Resvg } = require('@resvg/resvg-js')
const { PNG } = require('pngjs')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dukeSvg = readFileSync(join(root, 'brand/duke.svg'), 'utf8')
const SIZE = 1024
const PAD = 168
const inner = SIZE - PAD * 2

const wrapped = dukeSvg
  .replace('viewBox="0 0 1254 1254"', 'viewBox="275 268 707 707"')
  .replace(/\s+width="1254"\s+height="1254"/, '')
const dukeInner = `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}" viewBox="275 268 707 707">${wrapped.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</svg>`
const dukePng = PNG.sync.read(
  Buffer.from(new Resvg(dukeInner, { fitTo: { mode: 'width', value: inner } }).render().asPng()),
)

const png = new PNG({ width: SIZE, height: SIZE })
const data = png.data
const cx = (SIZE - 1) / 2
const cy = (SIZE - 1) / 2
const maxR = Math.hypot(cx, cy)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) << 2
    const t = Math.hypot(x - cx, y - cy) / maxR
    data[i] = Math.round(18 - t * 11)
    data[i + 1] = Math.round(24 - t * 15)
    data[i + 2] = Math.round(38 - t * 23)
    data[i + 3] = 255
  }
}

function hash(x, y) {
  let n = (x * 374761393 + y * 668265263) | 0
  n = (n ^ (n >>> 13)) * 1274126177
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (hash(x, y) <= 0.9984) continue
    const i = (y * SIZE + x) << 2
    const b = 140 + Math.floor(hash(y, x) * 80)
    data[i] = data[i + 1] = data[i + 2] = b
  }
}

const lift = -4
for (let y = 0; y < inner; y++) {
  for (let x = 0; x < inner; x++) {
    const si = (y * inner + x) << 2
    const a = dukePng.data[si + 3] / 255
    if (a < 0.02) continue
    const dx = x + PAD
    const dy = y + PAD + lift
    if (dx < 0 || dy < 0 || dx >= SIZE || dy >= SIZE) continue
    const di = (dy * SIZE + dx) << 2
    data[di] = Math.round(dukePng.data[si] * a + data[di] * (1 - a))
    data[di + 1] = Math.round(dukePng.data[si + 1] * a + data[di + 1] * (1 - a))
    data[di + 2] = Math.round(dukePng.data[si + 2] * a + data[di + 2] * (1 - a))
  }
}

const N = 5
function coverage(px, py) {
  let hit = 0
  const offs = [-0.3, -0.1, 0.1, 0.3]
  for (const ox of offs) {
    for (const oy of offs) {
      const nx = ((px + ox) / SIZE) * 2 - 1
      const ny = ((py + oy) / SIZE) * 2 - 1
      if (Math.pow(Math.abs(nx), N) + Math.pow(Math.abs(ny), N) <= 1) hit++
    }
  }
  return hit / (offs.length * offs.length)
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const c = coverage(x + 0.5, y + 0.5)
    const i = (y * SIZE + x) << 2
    if (c <= 0) {
      data[i] = data[i + 1] = data[i + 2] = 0
      data[i + 3] = 0
    } else if (c < 1) {
      data[i + 3] = Math.round(data[i + 3] * c)
    }
  }
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) << 2
    if (data[i + 3] < 8) continue
    const nx = (x / SIZE) * 2 - 1
    const ny = (y / SIZE) * 2 - 1
    const r = Math.pow(Math.abs(nx), N) + Math.pow(Math.abs(ny), N)
    if (r > 0.86 && r <= 1 && ny < -0.15) {
      const k = (1 - (r - 0.86) / 0.14) * 0.22 * (0.5 - ny)
      data[i] = Math.min(255, Math.round(data[i] + 40 * k))
      data[i + 1] = Math.min(255, Math.round(data[i + 1] + 44 * k))
      data[i + 2] = Math.min(255, Math.round(data[i + 2] + 50 * k))
    }
  }
}

writeFileSync(join(root, 'brand/app-icon.png'), PNG.sync.write(png))
console.log('wrote brand/app-icon.png')
