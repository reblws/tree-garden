import type { Segments2D } from '../core/geometry'
import { makeCanvas } from './canvas'
import { type Frame, clamp } from './frame'
import { hash2 } from './noise'

/**
 * A misty wash under a crowded crown. When hundreds of thousands of twigs
 * share the sheet, drawing each one, however faint, sums to a black mass.
 * A painter would lay the crown in as a wash of thinned ink and pick out a
 * few twigs over it. So: rasterise how much twig ink falls in each small
 * cell of the plate, blur it, and lay it down as a soft, cool wash that
 * saturates gently; the twigs over it are thinned (see inkBrush.ts).
 *
 * The grid is in plate pixels, so the wash is a mark on the plate: it
 * stays put under the camera and magnifies (softly) with the zoom. The
 * finished plant's wash is cached.
 */

/** Cell size, CSS px of the fitted plate. */
const CELL = 3
const MAX_CELLS = 360_000
/** Strongest the wash gets, as ink alpha. */
const MAX_ALPHA = 0.36

let cache: { geometry: Segments2D; key: string; canvas: HTMLCanvasElement; x: number; y: number; cell: number } | undefined

export const paintDensityWash = (context: CanvasRenderingContext2D, frame: Frame, crowding: number): void => {
  const { geometry, radius, dpr, scale, offsetX, offsetY, visible, palette } = frame
  const { minX, minY, maxX, maxY } = geometry.bounds
  const isFinished = !frame.isAnimating
  const key = `${palette.key}|${dpr}|${scale}|${offsetX}|${offsetY}`
  if (isFinished && cache !== undefined && cache.geometry === geometry && cache.key === key) {
    context.drawImage(cache.canvas, cache.x, cache.y, cache.canvas.width * cache.cell, cache.canvas.height * cache.cell)
    return
  }

  // The plant's box on the plate, with room for the blur.
  const pad = 4
  const left = offsetX + minX * scale
  const top = offsetY - maxY * scale
  const spanX = (maxX - minX) * scale
  const spanY = (maxY - minY) * scale
  let cell = CELL * dpr
  while ((spanX / cell + 2 * pad) * (spanY / cell + 2 * pad) > MAX_CELLS) cell *= 1.25
  const gw = Math.ceil(spanX / cell) + 2 * pad
  const gh = Math.ceil(spanY / cell) + 2 * pad
  const x0 = left - pad * cell
  const y0 = top - pad * cell
  const grid = new Float32Array(gw * gh)
  const coords = geometry.coords
  // Twig ink: length × width, with widths capped so a limb doesn't count as
  // a crowd.
  const cap = 2.2 * dpr
  for (let i = 0; i < geometry.count; i++) {
    const v = visible(i)
    if (v <= 0) continue
    const f = v < 1 ? v : 1
    const o = i * 4
    const ax = coords[o] ?? 0
    const ay = coords[o + 1] ?? 0
    const bx = ax + ((coords[o + 2] ?? 0) - ax) * f
    const by = ay + ((coords[o + 3] ?? 0) - ay) * f
    const mx = offsetX + ((ax + bx) / 2) * scale
    const my = offsetY - ((ay + by) / 2) * scale
    const gx = Math.floor((mx - x0) / cell)
    const gy = Math.floor((my - y0) / cell)
    if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue
    const w = frame.width(radius[i] ?? 0)
    grid[gy * gw + gx] = (grid[gy * gw + gx] ?? 0) + Math.hypot(bx - ax, by - ay) * scale * (w < cap ? w : cap)
  }
  const blurred = new Float32Array(gw * gh)
  for (let pass = 0; pass < 2; pass++) {
    boxBlur(grid, blurred, gw, gh, 2, 1, gw)
    boxBlur(blurred, grid, gh, gw, 2, gw, 1)
  }

  // Coverage → alpha, saturating softly, broken by a slow cloudiness so it
  // reads as mist rather than a blur.
  const canvas = makeCanvas(gw, gh)
  const target = canvas.getContext('2d')
  if (target === null) return
  const image = target.createImageData(gw, gh)
  const data = image.data
  const area = cell * cell
  const strength = clamp((crowding - 2.2) / 6, 0, 1) * 0.5 + 0.5
  const [r, g, b] = rgbOf(palette.inkTint(0.55, 1))
  // Cloudiness keyed to plate cells of 8 CSS px, so it is a feature of the
  // plate and doesn't depend on the grid's cell size.
  const cloudCell = 8 * dpr
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const coverage = (grid[y * gw + x] ?? 0) / area
      if (coverage <= 0.002) continue
      const px = (x0 + (x + 0.5) * cell) / cloudCell
      const py = (y0 + (y + 0.5) * cell) / cloudCell
      const cloud = 0.75 + 0.5 * valueNoise(px, py)
      const a = MAX_ALPHA * strength * (1 - Math.exp(-coverage * 1.6)) * cloud
      const o = (y * gw + x) * 4
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
      data[o + 3] = Math.round(clamp(a, 0, 1) * 255)
    }
  }
  target.putImageData(image, 0, 0)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(canvas, x0, y0, gw * cell, gh * cell)
  if (isFinished) cache = { geometry, key, canvas, x: x0, y: y0, cell }
}

/** Box blur of radius `radius` along one axis of a `lines` × `length` grid
 *  (stride `along` between neighbours, `across` between lines). */
const boxBlur = (
  from: Float32Array,
  to: Float32Array,
  length: number,
  lines: number,
  radius: number,
  along: number,
  across: number,
) => {
  const span = 2 * radius + 1
  for (let line = 0; line < lines; line++) {
    const base = line * across
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += from[base + clampIndex(k, length) * along] ?? 0
    for (let i = 0; i < length; i++) {
      to[base + i * along] = sum / span
      sum += (from[base + clampIndex(i + radius + 1, length) * along] ?? 0) - (from[base + clampIndex(i - radius, length) * along] ?? 0)
    }
  }
}

const clampIndex = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i)

const valueNoise = (x: number, y: number): number => {
  const i = Math.floor(x)
  const j = Math.floor(y)
  const fx = x - i
  const fy = y - j
  const u = fx * fx * (3 - 2 * fx)
  const v = fy * fy * (3 - 2 * fy)
  const a = hash2(i * 7919 + 17, j)
  const b = hash2((i + 1) * 7919 + 17, j)
  const c = hash2(i * 7919 + 17, j + 1)
  const d = hash2((i + 1) * 7919 + 17, j + 1)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

const rgbOf = (color: string): [number, number, number] => {
  const m = /rgba?\((\d+), (\d+), (\d+)/.exec(color)
  return m === null ? [20, 20, 20] : [Number(m[1]), Number(m[2]), Number(m[3])]
}
