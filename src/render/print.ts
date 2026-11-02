import { Schema } from 'effect'

import type { Segments2D } from '../core/geometry'
import { encodePng, makeCanvas } from './canvas'
import type { View } from './frame'
import { printPalette } from './palette'
import { paintPaper } from './paper'
import { buildFrame, composePlate, placePlant } from './plate'
import type { RenderStyle } from './renderStyle'
import type { Season } from './season'
import { type PlateOrientation, type Rect, plateMargins, printMark } from './sheet'

/**
 * The print: the plate rendered off screen at 300 dpi on a standard sheet,
 * with generous margins, an etcher's plate mark and pencilled
 * inscriptions, as a PNG that opens at its true size.
 *
 * It reuses the screen's painters unchanged: a print is the fitted view of
 * a much larger canvas, with `dpr` raised so the sheet is about 1100 CSS
 * pixels on its long side (so strokes, leaves and bark have the same
 * proportions as on screen) and `detail` raised to match, so the finest
 * bark and the stamens appear as they would under the loupe. The sheet is
 * painted in horizontal bands, each a few million pixels with a margin
 * for the blurs; the bands are copied into one canvas and encoded. It
 * runs in the print worker (see printClient.ts), or on the main thread,
 * yielding between bands, where there is no worker.
 *
 * Everything is a function of the geometry, the style, the season and the
 * size: the same link, style and size always give the same print, byte for
 * byte. The bands are part of that: each is painted translated by its top
 * row, and the float rounding of that shift reaches the anti-aliasing, so
 * other bands would give another file (6–7% of the pixels of an A3, nearly
 * all by one level). It is always ink on paper, whatever the page's theme.
 */

export const PrintSize = Schema.Literals(['A4', 'A3', 'A2'])
export type PrintSize = typeof PrintSize.Type

const DPI = 300
const MM_PER_INCH = 25.4
/** Sheet sizes, portrait, millimetres. */
const SHEETS: Record<PrintSize, readonly [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
}
/** The print's long side in CSS px: what `dpr` is measured against. */
const VIRTUAL_LONG_SIDE = 1100
/** Device pixels per band, at most. */
const BAND_PIXELS = 2_500_000
/** Room above and below each band for the blurs, px. */
const BAND_PAD = 64

/** Pixel size of a sheet at 300 dpi, portrait. */
export const printPixels = (size: PrintSize): { readonly width: number; readonly height: number } => {
  const [w, h] = SHEETS[size]
  return { width: Math.round((w / MM_PER_INCH) * DPI), height: Math.round((h / MM_PER_INCH) * DPI) }
}

export interface PrintRequest {
  readonly geometry: Segments2D
  readonly style: RenderStyle
  readonly season: Season
  readonly size: PrintSize
  /** Which way the sheet is turned (sheet.ts `orientationOf`), as on
   *  screen. */
  readonly orientation: PlateOrientation
  /** Pencilled under the plate mark: left, centre, right. */
  readonly inscriptions: readonly [string, string, string]
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** One horizontal band of the sheet: the rows it delivers, `top` to
 *  `bottom`, and the rows it paints, `from` to `to`, with room for the
 *  blurs. */
export interface Band {
  readonly top: number
  readonly bottom: number
  readonly from: number
  readonly to: number
}

/** The bands a `width` × `height` sheet is painted in: each at most
 *  `BAND_PIXELS`, painted with `BAND_PAD` more above and below. */
export const printBands = (width: number, height: number): ReadonlyArray<Band> => {
  const bandHeight = Math.max(256, Math.min(height, Math.floor(BAND_PIXELS / width)))
  const bands: Array<Band> = []
  for (let top = 0; top < height; top += bandHeight) {
    const bottom = Math.min(height, top + bandHeight)
    bands.push({ top, bottom, from: Math.max(0, top - BAND_PAD), to: Math.min(height, bottom + BAND_PAD) })
  }
  return bands
}

/** The sheet's size in px, turned as asked. */
export const sheetPixels = (size: PrintSize, orientation: PlateOrientation): { readonly width: number; readonly height: number } => {
  const portrait = printPixels(size)
  return orientation === 'Landscape' ? { width: portrait.height, height: portrait.width } : portrait
}

/** How far the print has got: `done` of `total` steps, a step per band and
 *  a last one to finish and encode the sheet. */
export type PrintProgress = (done: number, total: number) => void

export interface PrintOptions {
  readonly onProgress?: PrintProgress
  /** Yield to the event loop between bands, so a page painting the print
   *  on its main thread stays responsive. A worker has nothing to yield
   *  to. Default true. */
  readonly yieldBetweenBands?: boolean
}

/**
 * Render the print and encode it as a PNG (with its resolution). Runs
 * wherever there are canvases: in the print worker on OffscreenCanvas
 * (print.worker.ts), or on the main thread when there is no worker (see
 * printClient.ts), with the same bytes either way.
 */
export const renderPrint = async (request: PrintRequest, options: PrintOptions = {}): Promise<Blob> => {
  const { geometry, style, season } = request
  const { onProgress, yieldBetweenBands = true } = options
  const { width, height } = sheetPixels(request.size, request.orientation)
  const dpr = Math.max(width, height) / VIRTUAL_LONG_SIDE
  const palette = printPalette()

  // The plate mark, and the plant inside it with the same margins as on
  // screen (sheet.ts).
  const short = Math.min(width, height)
  const plate = printMark(width, height)
  const placement = placePlant(geometry, width, height, plateMargins(plate, width, height), short * 0.026)

  const output = makeCanvas(width, height)
  const out = output.getContext('2d')
  if (out === null) throw new Error('No 2D context for the print')

  const bands = printBands(width, height)
  const total = bands.length + 1
  const paper = makeCanvas(1, 1)
  const target = makeCanvas(1, 1)
  const ink = makeCanvas(1, 1)
  const wash = makeCanvas(1, 1)
  let scratch: Float32Array = new Float32Array(0)
  for (const [index, { top, bottom, from, to }] of bands.entries()) {
    if (yieldBetweenBands) await nextTask()
    const h = to - from
    for (const canvas of [paper, target, ink, wash]) {
      canvas.width = width
      canvas.height = h
    }
    // This band, as a view of the sheet: plate px are print px.
    const view: View = {
      zoom: 1,
      e: 0,
      f: -from,
      texture: 1,
      detail: dpr / 2,
      viewport: { minX: 0, minY: from, maxX: width, maxY: to },
    }
    paintPaper(paper, palette, dpr, view, { width, height })
    const built = buildFrame({
      geometry,
      palette,
      dpr,
      placement,
      view,
      // Sized like the screen's trunk relative to the plant, whichever way
      // the sheet is turned.
      minDimension: Math.sqrt(plate.width * plate.height),
      progress: 1,
      mode: 'Grow',
      draftSegments: Number.POSITIVE_INFINITY,
      scratch,
    })
    scratch = built.scratch
    composePlate(target, { ink, wash }, built.frame, {
      style,
      season,
      placement,
      drawPaper: context => context.drawImage(paper, 0, 0),
      clip: context => {
        context.beginPath()
        context.rect(plate.x, plate.y - from, plate.width, plate.height)
        context.clip()
      },
    })
    out.drawImage(target, 0, top - from, width, bottom - top, 0, top, width, bottom - top)
    onProgress?.(index + 1, total)
  }
  for (const canvas of [paper, target, ink, wash]) {
    canvas.width = 1
    canvas.height = 1
  }

  if (yieldBetweenBands) await nextTask()
  drawPlateMark(out, plate, dpr)
  drawInscriptions(out, plate, dpr, request.inscriptions, palette.inkRgb, [242, 239, 232])

  const blob = await encodePng(output)
  output.width = 1
  output.height = 1
  const tagged = await withResolution(blob, DPI)
  onProgress?.(total, total)
  return tagged
}

/**
 * The plate mark, as the press leaves it: inside it the paper was pressed
 * flat against the plate and holds a faint plate tone; its edge is a
 * bevel, a fine shadow on the sides away from the light and a fine
 * highlight just outside.
 */
const drawPlateMark = (context: CanvasRenderingContext2D, plate: Rect, dpr: number) => {
  context.save()
  context.globalCompositeOperation = 'multiply'
  context.fillStyle = 'rgba(120, 112, 100, 0.035)'
  context.fillRect(plate.x, plate.y, plate.width, plate.height)
  context.globalCompositeOperation = 'source-over'
  const line = Math.max(1, 0.55 * dpr)
  // The bevel's highlight, just outside the edge.
  context.strokeStyle = 'rgba(255, 255, 252, 0.75)'
  context.lineWidth = line * 1.6
  context.strokeRect(plate.x - line * 1.4, plate.y - line * 1.4, plate.width + line * 2.8, plate.height + line * 2.8)
  // The edge itself, darker where it turns from the light.
  context.lineWidth = line
  context.strokeStyle = 'rgba(22, 21, 19, 0.22)'
  context.beginPath()
  context.moveTo(plate.x, plate.y + plate.height)
  context.lineTo(plate.x, plate.y)
  context.lineTo(plate.x + plate.width, plate.y)
  context.stroke()
  context.strokeStyle = 'rgba(22, 21, 19, 0.36)'
  context.beginPath()
  context.moveTo(plate.x + plate.width, plate.y)
  context.lineTo(plate.x + plate.width, plate.y + plate.height)
  context.lineTo(plate.x, plate.y + plate.height)
  context.stroke()
  context.restore()
}

/** Pencil under the plate mark: left, centre and right, in the page's
 *  italic serif at the colour of graphite on this paper. */
const drawInscriptions = (
  context: CanvasRenderingContext2D,
  plate: Rect,
  dpr: number,
  [left, centre, right]: readonly [string, string, string],
  ink: readonly [number, number, number],
  paper: readonly [number, number, number],
) => {
  const mix = (k: number) => Math.round((ink[k] ?? 0) * 0.5 + (paper[k] ?? 0) * 0.5)
  context.save()
  context.fillStyle = `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
  context.font = `italic ${(12.5 * dpr).toFixed(1)}px "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif`
  context.textBaseline = 'alphabetic'
  const y = plate.y + plate.height + 26 * dpr
  const inset = 2 * dpr
  context.textAlign = 'left'
  context.fillText(left, plate.x + inset, y)
  context.textAlign = 'center'
  context.fillText(centre, plate.x + plate.width / 2, y)
  context.textAlign = 'right'
  context.fillText(right, plate.x + plate.width - inset, y)
  context.restore()
}

/** The PNG with a pHYs chunk after its header, so it opens at `dpi`. */
export const withResolution = async (blob: Blob, dpi: number): Promise<Blob> => {
  // Signature (8) and IHDR (4 length + 4 type + 13 data + 4 CRC). Only
  // the header is read; the rest of the file is spliced in as a slice of
  // the Blob, not copied.
  const at = 8 + 25
  const head = new Uint8Array(await blob.slice(0, at).arrayBuffer())
  if (head.length < at || String.fromCharCode(...head.slice(12, 16)) !== 'IHDR') return blob
  const perMetre = Math.round(dpi / 0.0254)
  const chunk = new Uint8Array(4 + 4 + 9 + 4)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // "pHYs"
  view.setUint32(8, perMetre)
  view.setUint32(12, perMetre)
  chunk[16] = 1 // metres
  view.setUint32(17, crc32(chunk.subarray(4, 17)))
  return new Blob([head, chunk, blob.slice(at)], { type: 'image/png' })
}

let crcTable: Uint32Array | undefined

export const crc32 = (data: Uint8Array): number => {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) crc = (crcTable[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
