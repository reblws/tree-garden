import type { CameraView } from './camera'
import { textureScale } from './camera'
import { hash2, prng } from './noise'
import type { Palette } from './palette'

/**
 * A sheet of paper, painted once per canvas size, theme and camera into an
 * offscreen canvas: a flat tone, soft cloudiness, fine grain, a scatter of
 * fibres and a faint vignette. Everything is seeded, so the sheet is the
 * same on every visit.
 *
 * Under the camera, the cloudiness, fibres and vignette are features of
 * the sheet: they stay where they are on it and magnify with the zoom
 * (fibres keep a hair's width). The grain is the paper's texture: it stays
 * anchored to the sheet but grows only by `textureScale`, so it never
 * balloons into gravel.
 */

const GRAIN_TILE = 384
/** The relief tile: the bumps of cold-pressed paper, lit like the plate. */
const RELIEF_TILE = 512
const CLOUD_CELL_PX = 26
/** Fibres are seeded per square cell of the sheet this big (CSS px), so
 *  only the cells on screen need painting. */
const FIBRE_CELL_PX = 256
/** CSS px² of sheet per fibre. */
const FIBRE_AREA = 5200

const IDENTITY: CameraView = { zoom: 1, e: 0, f: 0 }

const grainTiles = new Map<string, HTMLCanvasElement>()

/** A tile of per-pixel grain: transparent with a speckle of ink-coloured
 *  and paper-coloured dots, tiled across the sheet. */
const grainTile = (palette: Palette): HTMLCanvasElement => {
  const key = palette.key
  const cached = grainTiles.get(key)
  if (cached !== undefined) return cached
  const tile = document.createElement('canvas')
  tile.width = GRAIN_TILE
  tile.height = GRAIN_TILE
  const context = tile.getContext('2d')
  if (context === null) return tile
  const image = context.createImageData(GRAIN_TILE, GRAIN_TILE)
  const data = image.data
  const [ir, ig, ib] = palette.inkRgb
  const [pr, pg, pb] = palette.highlightRgb
  for (let y = 0; y < GRAIN_TILE; y++) {
    for (let x = 0; x < GRAIN_TILE; x++) {
      const o = (y * GRAIN_TILE + x) * 4
      // Fine grain plus a slightly coarser tooth, both from the hash.
      const fine = hash2(x * 7919 + 13, y)
      const coarse = hash2((x >> 1) * 104729 + 7, y >> 1)
      const v = fine * 0.6 + coarse * 0.4
      if (v > 0.5) {
        data[o] = ir
        data[o + 1] = ig
        data[o + 2] = ib
        data[o + 3] = Math.round((v - 0.5) * 2 * palette.grain * 255)
      } else {
        data[o] = pr
        data[o + 1] = pg
        data[o + 2] = pb
        data[o + 3] = Math.round((0.5 - v) * 2 * palette.grain * 0.8 * 255)
      }
    }
  }
  context.putImageData(image, 0, 0)
  grainTiles.set(key, tile)
  return tile
}

const reliefTiles = new Map<string, HTMLCanvasElement>()

/**
 * Cold-pressed paper's tooth as relief: smooth bumps (two octaves of
 * wrapping value noise, about 2 and 0.8 CSS px across on the plate), shaded
 * by the same upper-left light as the branches, so the sheet has a surface
 * rather than only a speckle. Transparent, with light and dark at a few
 * percent.
 */
const reliefTile = (palette: Palette): HTMLCanvasElement => {
  const cached = reliefTiles.get(palette.key)
  if (cached !== undefined) return cached
  const n = RELIEF_TILE
  const tile = document.createElement('canvas')
  tile.width = n
  tile.height = n
  const context = tile.getContext('2d')
  if (context === null) return tile
  const height = new Float32Array(n * n)
  const octave = (cell: number, weight: number, seed: number) => {
    const cells = n / cell
    const lattice = (i: number, j: number) => hash2((((i % cells) + cells) % cells) * 7919 + seed, ((j % cells) + cells) % cells)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const gx = x / cell
        const gy = y / cell
        const i = Math.floor(gx)
        const j = Math.floor(gy)
        let fx = gx - i
        let fy = gy - j
        fx = fx * fx * (3 - 2 * fx)
        fy = fy * fy * (3 - 2 * fy)
        const a = lattice(i, j)
        const b = lattice(i + 1, j)
        const c = lattice(i, j + 1)
        const d = lattice(i + 1, j + 1)
        height[y * n + x] = (height[y * n + x] ?? 0) + (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy) * weight
      }
    }
  }
  octave(8, 1, 11)
  octave(4, 0.55, 23)
  octave(2, 0.2, 37)
  const image = context.createImageData(n, n)
  const data = image.data
  const [ir, ig, ib] = palette.inkRgb
  const [hr, hg, hb] = palette.highlightRgb
  const strength = palette.isDark ? 0.04 : 0.052
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      // Slope towards the light (upper left): lit faces brighten, the far
      // sides of the bumps fall into shade.
      const h = height[y * n + x] ?? 0
      const left = height[y * n + ((x + n - 1) % n)] ?? 0
      const up = height[((y + n - 1) % n) * n + x] ?? 0
      const slope = (left - h) * 0.6 + (up - h) * 0.8
      const v = Math.max(-1, Math.min(1, slope * 2.2))
      const o = (y * n + x) * 4
      if (v < 0) {
        data[o] = hr
        data[o + 1] = hg
        data[o + 2] = hb
        data[o + 3] = Math.round(-v * strength * 1.3 * 255)
      } else {
        data[o] = ir
        data[o + 1] = ig
        data[o + 2] = ib
        data[o + 3] = Math.round(v * strength * 255)
      }
    }
  }
  context.putImageData(image, 0, 0)
  reliefTiles.set(palette.key, tile)
  return tile
}

export const paintPaper = (
  target: HTMLCanvasElement,
  palette: Palette,
  dpr: number,
  view: CameraView = IDENTITY,
  /** The whole sheet's size in plate px, when `target` holds only part of
   *  it (a band of a print). Defaults to the target's size. */
  sheet: { readonly width: number; readonly height: number } = target,
): void => {
  const context = target.getContext('2d')
  if (context === null) return
  const { width, height } = target
  const { zoom, e, f } = view
  // Grain is drawn in device pixels; past 2 device pixels per CSS pixel (a
  // print) it is scaled up, so it keeps its size on the sheet.
  const texture = textureScale(zoom) * Math.max(1, dpr / 2)
  // The part of the sheet on screen, in plate pixels.
  const left = -e / zoom
  const top = -f / zoom
  const right = (width - e) / zoom
  const bottom = (height - f) / zoom

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalCompositeOperation = 'source-over'
  context.globalAlpha = 1
  context.fillStyle = palette.paper
  context.fillRect(0, 0, width, height)

  // Cloudiness: a coarse grid of hashed values, upscaled with smoothing.
  const cell = CLOUD_CELL_PX * dpr
  const clouds = cloudsFor(sheet.width, sheet.height, cell, palette)
  context.setTransform(zoom, 0, 0, zoom, e, f)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(clouds, -cell, -cell, clouds.width * cell, clouds.height * cell)

  // Grain, tiled from the sheet's corner at texture scale.
  const pattern = context.createPattern(grainTile(palette), 'repeat')
  if (pattern !== null) {
    pattern.setTransform(new DOMMatrix([texture, 0, 0, texture, e, f]))
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = pattern
    context.fillRect(0, 0, width, height)
  }

  // The paper's relief, at the same texture scale.
  const relief = context.createPattern(reliefTile(palette), 'repeat')
  if (relief !== null) {
    relief.setTransform(new DOMMatrix([texture, 0, 0, texture, e, f]))
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.fillStyle = relief
    context.fillRect(0, 0, width, height)
  }

  // Fibres: short, slightly curved hairs pressed into the sheet, seeded per
  // cell of the sheet. Their width stays a hair's: plate width × texture
  // scale ÷ zoom, so `texture` times the fitted width on screen.
  context.setTransform(zoom, 0, 0, zoom, e, f)
  context.lineCap = 'round'
  const fibreCell = FIBRE_CELL_PX * dpr
  const longest = 30 * dpr
  const perCell = (FIBRE_CELL_PX * FIBRE_CELL_PX) / FIBRE_AREA
  const thin = textureScale(zoom) / zoom
  for (let cy = Math.floor((top - longest) / fibreCell); cy * fibreCell <= bottom + longest; cy++) {
    if ((cy + 1) * fibreCell < 0 || cy * fibreCell > sheet.height) continue
    for (let cx = Math.floor((left - longest) / fibreCell); cx * fibreCell <= right + longest; cx++) {
      if ((cx + 1) * fibreCell < 0 || cx * fibreCell > sheet.width) continue
      const random = prng(0x7ee5 ^ Math.imul(cx + 0x51, 0x9e3779b1) ^ Math.imul(cy + 0x3b, 0x85ebca6b))
      const count = Math.floor(perCell + random())
      for (let i = 0; i < count; i++) {
        const x = (cx + random()) * fibreCell
        const y = (cy + random()) * fibreCell
        const length = (4 + random() ** 2 * 26) * dpr
        const angle = random() * Math.PI * 2
        const bend = (random() - 0.5) * length * 0.6
        const dx = Math.cos(angle) * length
        const dy = Math.sin(angle) * length
        const isDark = random() < 0.55
        const alpha = (isDark ? 0.035 : 0.12) + random() * 0.04
        const lineWidth = (0.4 + random() * 0.6) * dpr * thin
        if (x + longest < left || x - longest > right || y + longest < top || y - longest > bottom) continue
        context.strokeStyle = isDark ? palette.ink : palette.highlight
        context.globalAlpha = alpha
        context.lineWidth = lineWidth
        context.beginPath()
        context.moveTo(x, y)
        context.quadraticCurveTo(x + dx / 2 - (dy / length) * bend, y + dy / 2 + (dx / length) * bend, x + dx, y + dy)
        context.stroke()
      }
    }
  }
  context.globalAlpha = 1

  // Vignette: the sheet darkens (or, on dark paper, lightens) a touch at
  // the edges, like a print under glass.
  const radius = Math.hypot(sheet.width, sheet.height) / 2
  const vignette = context.createRadialGradient(
    sheet.width / 2,
    sheet.height * 0.46,
    radius * 0.35,
    sheet.width / 2,
    sheet.height / 2,
    radius * 1.05,
  )
  vignette.addColorStop(0, palette.withInkAlpha(0))
  vignette.addColorStop(1, palette.withInkAlpha(palette.vignette))
  context.fillStyle = vignette
  context.fillRect(left, top, right - left, bottom - top)
  context.setTransform(1, 0, 0, 1, 0, 0)
}

let clouds: { key: string; canvas: HTMLCanvasElement } | undefined

/** The cloudiness at one texel per cell, kept for the last size. */
const cloudsFor = (width: number, height: number, cell: number, palette: Palette): HTMLCanvasElement => {
  const cw = Math.ceil(width / cell) + 2
  const ch = Math.ceil(height / cell) + 2
  const key = `${cw}x${ch}|${palette.key}`
  if (clouds?.key === key) return clouds.canvas
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const context = canvas.getContext('2d')
  if (context !== null) {
    const image = context.createImageData(cw, ch)
    const [ir, ig, ib] = palette.inkRgb
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const o = (y * cw + x) * 4
        const v = hash2(x * 31337 + 1, y) * 0.65 + hash2((x >> 2) * 7907 + 3, y >> 2) * 0.35
        image.data[o] = ir
        image.data[o + 1] = ig
        image.data[o + 2] = ib
        image.data[o + 3] = Math.round(v * palette.cloud * 255)
      }
    }
    context.putImageData(image, 0, 0)
  }
  clouds = { key, canvas }
  return canvas
}
