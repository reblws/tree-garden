import { Schema } from 'effect'

/**
 * The camera on the plate: how far it is magnified and which point of it
 * sits in the middle of the view. Pure math, no DOM, so the Model, the
 * update function and the canvas all share it.
 *
 * Coordinates are **plate-normalised**: (0, 0) is the top-left corner of the
 * fitted plate and (1, 1) its bottom-right, each axis divided by its own
 * length. `zoom` 1 is the fitted view (the whole sheet), 2 is twice as big.
 * Because the fit is recomputed for every build and every canvas size, a
 * camera means "this part of the picture", which survives a resize, a
 * slider nudge or a change of style.
 *
 * Plate *pixels* (used by the painters) are device pixels of the fitted
 * view. `cameraView` maps them to screen pixels:
 * `screen = zoom * plate + (e, f)`.
 */
export const Camera = Schema.Struct({
  zoom: Schema.Number,
  /** The plate point at the centre of the view, 0..1 across. */
  x: Schema.Number,
  /** The plate point at the centre of the view, 0..1 down. */
  y: Schema.Number,
})
export type Camera = typeof Camera.Type

/** A discrete zoom action: a button, a key or a double-click. */
export const ZoomStep = Schema.Literals(['In', 'Out', 'Fit'])
export type ZoomStep = typeof ZoomStep.Type

/** A discrete pan action (arrow keys). */
export const PanStep = Schema.Literals(['Left', 'Right', 'Up', 'Down'])
export type PanStep = typeof PanStep.Type

export const MIN_ZOOM = 1
export const MAX_ZOOM = 32
/** Share of the view an arrow key moves it by. */
const PAN_STEP = 0.2

export const fitCamera: Camera = { zoom: 1, x: 0.5, y: 0.5 }

/** A rectangle in plate-normalised coordinates. */
export interface Rect {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export const SHEET: Rect = { minX: 0, minY: 0, maxX: 1, maxY: 1 }

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value

export const clampZoom = (zoom: number): number =>
  Number.isFinite(zoom) ? clamp(zoom, MIN_ZOOM, MAX_ZOOM) : MIN_ZOOM

export const isFit = (camera: Camera): boolean => camera.zoom <= MIN_ZOOM + 1e-9

export const cameraEquals = (a: Camera, b: Camera): boolean =>
  Math.abs(a.zoom - b.zoom) <= 1e-9 * b.zoom && Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9

/**
 * Keep the camera sensible: zoom within [MIN_ZOOM, MAX_ZOOM], the centre
 * over `focus` (the plant's box, so it can't be lost off the plate), and
 * the view inside the sheet. The sheet wins where they disagree. At zoom 1
 * this always gives the fitted camera. Idempotent.
 */
export const clampCamera = (camera: Camera, focus: Rect = SHEET): Camera => {
  const zoom = clampZoom(camera.zoom)
  const half = 0.5 / zoom
  const x = clamp(clamp(finite(camera.x), focus.minX, focus.maxX), half, 1 - half)
  const y = clamp(clamp(finite(camera.y), focus.minY, focus.maxY), half, 1 - half)
  return { zoom, x, y }
}

const finite = (value: number) => (Number.isFinite(value) ? value : 0.5)

/**
 * Magnify by `factor`, keeping the plate point under the view point
 * (`u`, `v`) (0..1 across and down the view) where it is: the zoom goes
 * towards the cursor. Not clamped, except for the zoom range.
 */
export const zoomAbout = (camera: Camera, factor: number, u: number, v: number): Camera => {
  const zoom = clampZoom(camera.zoom * factor)
  const shift = 1 / camera.zoom - 1 / zoom
  return { zoom, x: camera.x + (u - 0.5) * shift, y: camera.y + (v - 0.5) * shift }
}

/** Drag the plate by (`du`, `dv`), as shares of the view's width and
 *  height. Not clamped. */
export const panBy = (camera: Camera, du: number, dv: number): Camera => ({
  zoom: camera.zoom,
  x: camera.x - du / camera.zoom,
  y: camera.y - dv / camera.zoom,
})

/** Zoom in or out to the next power of two (100%, 200%, 400% …) about the
 *  centre of the view, or back to the fitted view. */
export const stepZoom = (camera: Camera, step: ZoomStep): Camera => {
  if (step === 'Fit') return fitCamera
  const octave = Math.log2(camera.zoom)
  const next = step === 'In' ? Math.floor(octave + 1e-6) + 1 : Math.ceil(octave - 1e-6) - 1
  return clampCamera({ ...camera, zoom: 2 ** next })
}

export const stepPan = (camera: Camera, step: PanStep): Camera => {
  const du = step === 'Left' ? PAN_STEP : step === 'Right' ? -PAN_STEP : 0
  const dv = step === 'Up' ? PAN_STEP : step === 'Down' ? -PAN_STEP : 0
  return clampCamera(panBy(camera, du, dv))
}

/** The affine map from plate pixels to screen pixels for a canvas of
 *  `width` × `height` device pixels: `screen = zoom * plate + (e, f)`. */
export interface CameraView {
  readonly zoom: number
  readonly e: number
  readonly f: number
}

export const cameraView = (camera: Camera, width: number, height: number): CameraView => ({
  zoom: camera.zoom,
  e: width * (0.5 - camera.x * camera.zoom),
  f: height * (0.5 - camera.y * camera.zoom),
})

/** The part of the plate on screen, in plate pixels. */
export const visibleRect = (camera: Camera, width: number, height: number): Rect => {
  const { zoom, e, f } = cameraView(camera, width, height)
  return { minX: -e / zoom, minY: -f / zoom, maxX: (width - e) / zoom, maxY: (height - f) / zoom }
}

/** The map that takes a picture painted at camera `from` to where it
 *  belongs at camera `to`: how a cached frame is stretched for a preview. */
export const relativeView = (from: Camera, to: Camera, width: number, height: number): CameraView => {
  const a = cameraView(from, width, height)
  const b = cameraView(to, width, height)
  const zoom = b.zoom / a.zoom
  return { zoom, e: b.e - zoom * a.e, f: b.f - zoom * a.f }
}

/**
 * How much bigger the paper's texture (grain, tooth, bleed) looks at a
 * zoom. Strokes, leaves and fibres are marks on the plate and grow with
 * the zoom, like a print under a loupe; the texture grows only gently
 * (×2 at 8×, ×3.2 at 32×), so it reads as paper rather than gravel.
 */
export const textureScale = (zoom: number): number => Math.cbrt(Math.max(1, zoom))

/** Ease between two cameras: the zoom geometrically, the centre in a
 *  straight line. `t` in 0..1. */
export const interpolateCamera = (from: Camera, to: Camera, t: number): Camera => ({
  zoom: from.zoom * (to.zoom / from.zoom) ** t,
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
})

/** "100%", "250%", "3200%". */
export const formatZoom = (zoom: number): string => `${Math.round(zoom * 100)}%`
