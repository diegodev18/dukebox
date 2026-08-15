#!/usr/bin/env node
/**
 * Rasterize Duke-in-the-box app icons from brand/duke.svg.
 *
 * The shipped dock icon is brand/app-icon.png (space-black, padded, relief).
 * Prefer `pnpm exec tauri icon ../../brand/app-icon.png` from apps/desktop
 * after replacing that PNG, rather than re-running this compositor.
 *
 * Requires @resvg/resvg-js and pngjs (dev one-off, not a repo dependency).
 * Usage: node brand/render-icons.mjs
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { Resvg } = require('@resvg/resvg-js')
const { PNG } = require('pngjs')

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const duke = readFileSync(join(root, 'brand/duke.svg'), 'utf8')
const outDir = join(root, 'apps/desktop/src-tauri/icons')
mkdirSync(outDir, { recursive: true })
mkdirSync(join(root, 'brand'), { recursive: true })

const BOX = [0x3b, 0x52, 0xdb, 0xff]
const SIZE = 1024
const RADIUS = 228
const PAD = 90

const cropped = duke
  .replace('viewBox="0 0 1254 1254"', 'viewBox="275 268 707 707"')
  .replace(/\s+width="1254"\s+height="1254"/, '')

const inner = SIZE - PAD * 2
const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${inner}" height="${inner}" viewBox="275 268 707 707">${cropped.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</svg>`

const dukePng = PNG.sync.read(
  Buffer.from(new Resvg(wrapped, { fitTo: { mode: 'width', value: inner } }).render().asPng()),
)

function roundedMask(size, radius) {
  const png = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = inRoundRect(x + 0.5, y + 0.5, size, radius)
      const i = (y * size + x) << 2
      png.data[i] = BOX[0]
      png.data[i + 1] = BOX[1]
      png.data[i + 2] = BOX[2]
      png.data[i + 3] = inside ? 255 : 0
    }
  }
  return png
}

function inRoundRect(x, y, size, r) {
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

const canvas = roundedMask(SIZE, RADIUS)
for (let y = 0; y < inner; y++) {
  for (let x = 0; x < inner; x++) {
    const si = (y * inner + x) << 2
    const a = dukePng.data[si + 3]
    if (a < 8) continue
    const dx = x + PAD
    const dy = y + PAD
    const di = (dy * SIZE + dx) << 2
    if (canvas.data[di + 3] < 8) continue
    const alpha = a / 255
    canvas.data[di] = Math.round(dukePng.data[si] * alpha + canvas.data[di] * (1 - alpha))
    canvas.data[di + 1] = Math.round(
      dukePng.data[si + 1] * alpha + canvas.data[di + 1] * (1 - alpha),
    )
    canvas.data[di + 2] = Math.round(
      dukePng.data[si + 2] * alpha + canvas.data[di + 2] * (1 - alpha),
    )
    canvas.data[di + 3] = 255
  }
}

const master = PNG.sync.write(canvas)
writeFileSync(join(root, 'brand/app-icon.png'), master)
writeFileSync(join(outDir, 'icon.png'), master)

function sample(png, x, y) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(SIZE - 1, x0 + 1)
  const y1 = Math.min(SIZE - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const out = [0, 0, 0, 0]
  for (const [ix, iy, w] of [
    [x0, y0, (1 - fx) * (1 - fy)],
    [x1, y0, fx * (1 - fy)],
    [x0, y1, (1 - fx) * fy],
    [x1, y1, fx * fy],
  ]) {
    const i = (iy * SIZE + ix) << 2
    for (let c = 0; c < 4; c++) out[c] += png.data[i + c] * w
  }
  return out.map((v) => Math.round(v))
}

function scale(png, size) {
  const out = new PNG({ width: size, height: size })
  const step = SIZE / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = sample(png, (x + 0.5) * step - 0.5, (y + 0.5) * step - 0.5)
      const di = (y * size + x) << 2
      out.data[di] = r
      out.data[di + 1] = g
      out.data[di + 2] = b
      out.data[di + 3] = a
    }
  }
  return out
}

for (const [name, size] of [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
]) {
  writeFileSync(join(outDir, name), PNG.sync.write(scale(canvas, size)))
}

// OG image — Duke on a quiet surface, for GitHub / README embeds.
const ogW = 1280
const ogH = 640
const og = new PNG({ width: ogW, height: ogH })
for (let i = 0; i < og.data.length; i += 4) {
  og.data[i] = 250
  og.data[i + 1] = 250
  og.data[i + 2] = 249
  og.data[i + 3] = 255
}
const hero = 360
const heroPng = PNG.sync.read(
  Buffer.from(new Resvg(wrapped, { fitTo: { mode: 'width', value: hero } }).render().asPng()),
)
const ox = Math.floor((ogW - hero) / 2)
const oy = Math.floor((ogH - hero) / 2)
for (let y = 0; y < hero; y++) {
  for (let x = 0; x < hero; x++) {
    const si = (y * hero + x) << 2
    const a = heroPng.data[si + 3] / 255
    if (a < 0.03) continue
    const di = ((y + oy) * ogW + (x + ox)) << 2
    og.data[di] = Math.round(heroPng.data[si] * a + og.data[di] * (1 - a))
    og.data[di + 1] = Math.round(heroPng.data[si + 1] * a + og.data[di + 1] * (1 - a))
    og.data[di + 2] = Math.round(heroPng.data[si + 2] * a + og.data[di + 2] * (1 - a))
  }
}
writeFileSync(join(root, 'brand/og.png'), PNG.sync.write(og))

console.log('wrote brand/app-icon.png, brand/og.png, and tauri png sizes')

try {
  execFileSync('iconutil', ['-h'], { stdio: 'ignore' })
} catch {
  console.log('iconutil not available; skip icns (run `tauri icon brand/app-icon.png`)')
}
