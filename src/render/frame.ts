import type { BranchTopology } from '../core/branching'
import type { Bounds, Segments2D } from '../core/geometry'
import type { CameraView } from './camera'
import type { Palette } from './palette'

/**
 * Where the camera is, for the painters (see camera.ts).
 *
 * Painters work in **plate pixels**, the device pixels of the fitted view,
 * and the compositor sets the context's transform to the view before
 * calling them, so the canvas rasterises every path at the current zoom:
 * strokes, leaves and fibres are vectors and stay crisp. A painter only
 * needs the view to cull what is off screen, to choose its level of detail
 * by on-screen size, and to keep textures at `texture` scale.
 */
export interface View extends CameraView {
  /** On-screen growth of paper texture (grain, tooth, bleed); see
   *  `textureScale` in camera.ts. 1 at the fitted view. */
  readonly texture: number
  /** How much detail the picture can hold, for level-of-detail choices:
   *  device pixels per CSS pixel of the fitted plate, over 2. It is the
   *  zoom on a 2× screen, half that on a 1× screen, and more for a print. */
  readonly detail: number
  /** The part of the plate on screen, in plate pixels. */
  readonly viewport: Bounds
}

/** Put the view on a context: from here on, draw in plate pixels. */
export const applyView = (context: CanvasRenderingContext2D, view: CameraView): void =>
  context.setTransform(view.zoom, 0, 0, view.zoom, view.e, view.f)

/** Whether the box around a segment from (ax, ay) to (bx, by), grown by
 *  `pad`, touches the viewport. All in plate pixels. */
export const isInView = (view: View, ax: number, ay: number, bx: number, by: number, pad: number): boolean => {
  const { minX, minY, maxX, maxY } = view.viewport
  return !(
    (ax > bx ? ax : bx) < minX - pad ||
    (ax < bx ? ax : bx) > maxX + pad ||
    (ay > by ? ay : by) < minY - pad ||
    (ay < by ? ay : by) > maxY + pad
  )
}

/** A matrix for a paper-texture pattern: anchored at the plate's origin
 *  and drawn at `texture` scale on screen, whatever the zoom. Use it as
 *  `pattern.setTransform(textureMatrix(view, inUserSpace).multiply(…))`:
 *  pass `inUserSpace` when the context's transform is the view. */
export const textureMatrix = (view: View, inUserSpace: boolean): DOMMatrix =>
  inUserSpace
    ? new DOMMatrix().scaleSelf(view.texture / view.zoom)
    : new DOMMatrix([view.texture, 0, 0, view.texture, view.e, view.f])

/**
 * Everything a painter needs to draw one frame: the geometry and its
 * topology, the current branch radii (which grow during playback), where
 * the plant sits on the plate, what part of the plate is on screen, and how
 * much of the plant is revealed.
 */
export interface Frame {
  readonly geometry: Segments2D
  readonly topology: BranchTopology
  /** Pipe-model radius per segment for what is visible now (0 = hidden). */
  readonly radius: Float32Array
  readonly palette: Palette
  readonly dpr: number
  /** Plate pixels per generator unit, and the offset of the origin: where
   *  the plant sits on the fitted plate. Independent of the camera. */
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
  /** The camera, as painters need it. */
  readonly view: View
  /** Stroke width in plate pixels for a pipe-model radius. */
  readonly width: (radius: number) => number
  /** Visible fraction of segment `i`: ≤ 0 hidden, ≥ 1 complete. */
  readonly visible: (i: number) => number
  /** Reveal by path distance (Grow) rather than drawing order (Trace). */
  readonly isGrow: boolean
  /** Playback is under way: this frame will be replaced in ~16 ms. */
  readonly isAnimating: boolean
  /** A playback frame of a very large tree: painters drop their costliest
   *  texture so the animation keeps up. The finished frame is never a
   *  draft. */
  readonly isDraft: boolean
}

export interface WidthScale {
  readonly tip: number
  readonly exponent: number
  readonly isUnbranched: boolean
}

/**
 * Map pipe-model radii (tips = 1) to device pixels. Tips are hairlines; the
 * trunk would be `tip * maxRadius` wide, which is absurd for big trees and
 * too slight for small ones, so the radii are raised to a power
 * (`r^k`, k ≤ 1.5) that lands the trunk on a width chosen for the sheet.
 * The order of thicknesses, and so the pipe model's taper, is kept.
 * Structures that never fork (Koch, Sierpinski) get one even pen width.
 */
export const widthScale = (
  maxRadius: number,
  scale: number,
  dpr: number,
  minDimension: number,
): WidthScale => {
  if (maxRadius <= 1.0001) {
    return { tip: clamp(scale * 0.06, 1.1 * dpr, 2.2 * dpr), exponent: 0, isUnbranched: true }
  }
  const tip = clamp(scale * 0.09, 0.5 * dpr, 1.15 * dpr)
  // The cap: a confident trunk for the size of the sheet.
  const cap = Math.max(tip * 2, Math.min(minDimension * 0.025, 26 * dpr))
  // Few-tipped plants may exaggerate the taper a little (up to r^1.5) so
  // the trunk still reads as a trunk.
  const trunk = Math.min(tip * maxRadius ** 1.5, cap)
  return { tip, exponent: Math.log(trunk / tip) / Math.log(maxRadius), isUnbranched: false }
}

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value
