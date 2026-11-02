import { Schema } from 'effect'

import type { Bounds } from '../core/geometry'
import type { Margins } from './plate'

/**
 * The sheet: which way it is turned, and where its plate mark and the
 * plant's margins go. Shared by the screen and the print, so the plate
 * you see is the plate you print.
 *
 * There are two sheets, both A-series: portrait, and landscape for
 * plants clearly wider than tall. On screen the sheet's paper edge is a
 * thin mat, but the plate mark inside it has exactly the print's
 * proportions (`MARK_RATIO`), and the plant keeps the same margins inside
 * the mark (`plateMargins`), so the composition is the same.
 */

export const PlateOrientation = Schema.Literals(['Portrait', 'Landscape'])
export type PlateOrientation = typeof PlateOrientation.Type

/** A plant at least this much wider than tall (width ÷ height of its
 *  box) goes on a landscape sheet. Koch's snowflake (1.15) does; every
 *  tree preset, and Sierpinski's sideways triangle (0.87), stays portrait.
 *  Below about 1.06 a portrait sheet holds the plant larger anyway. */
export const LANDSCAPE_AT = 1.1

/** Width ÷ height of a plant's box; 1 for a degenerate box. */
export const aspectOf = (bounds: Bounds): number => {
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (!(width > 0) || !(height > 0)) return 1
  return width / height
}

/**
 * Which way to turn the sheet for a plant of `aspect` (width ÷ height).
 * A function of the plant alone, so the same link always prints the same
 * way. The page keeps it from flickering by asking only when an edit is
 * committed (see `settleSheet` in ui/update.ts), never mid-drag.
 */
export const orientationOf = (aspect: number): PlateOrientation =>
  aspect >= LANDSCAPE_AT ? 'Landscape' : 'Portrait'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The print's plate mark on a `width` × `height` sheet, px: inset from
 *  the edges, deeper at the foot, where the inscriptions go. */
export const printMark = (width: number, height: number): Rect => {
  const short = Math.min(width, height)
  const side = Math.round(short * 0.095)
  const top = Math.round(short * 0.09)
  const foot = Math.round(short * 0.155)
  return { x: side, y: top, width: width - 2 * side, height: height - top - foot }
}

/**
 * Height ÷ width of the print's plate mark, for each orientation (the
 * same for A4, A3 and A2; sheet.test.ts checks it against `printMark`).
 * The view hands it to styles.css as `--mark-ratio`, which sizes the
 * on-screen sheet so its mark has these proportions.
 */
export const MARK_RATIO: Record<PlateOrientation, number> = {
  Portrait: 1.4447,
  Landscape: 0.6169,
}

/** Room kept clear inside the plate mark, as shares of its own sides:
 *  across by its width, down by its height, so a tall sheet keeps head
 *  room and a wide one keeps air at the sides. */
const SIDE = 0.07
const TOP = 0.065
const FOOT = 0.07

/** The plant's margins on a `width` × `height` canvas whose plate mark is
 *  `mark`, measured from the canvas edges (as `placePlant` takes them). */
export const plateMargins = (mark: Rect, width: number, height: number): Margins => {
  const side = mark.width * SIDE
  return {
    left: mark.x + side,
    right: width - mark.x - mark.width + side,
    top: mark.y + mark.height * TOP,
    bottom: height - mark.y - mark.height + mark.height * FOOT,
  }
}
