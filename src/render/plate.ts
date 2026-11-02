import { type BranchTopology, PIPE_EXPONENT, growRadii, pipeRadii } from '../core/branching'
import type { Segments2D } from '../core/geometry'
import { GeometryStore } from '../engine/geometryStore'
import type { Rect } from './camera'
import { hasFoliage, paintFoliage } from './foliage'
import { type Frame, type View, applyView, isInView, strokeWidthOf, widthScale } from './frame'
import type { GpuInk } from './gpuInk'
import { paintGround } from './ground'
import { beginInk } from './inkBrush'
import { paintLines } from './linePen'
import type { Palette } from './palette'
import type { RenderStyle } from './renderStyle'
import type { RevealMode } from './revealMode'
import { paintSeal, sealImage } from './seal'
import type { Season } from './season'

/**
 * Painting a plate, shared by the on-screen `<tree-canvas>` and the print
 * export: where the plant sits on the sheet, the Frame the painters get,
 * and how the layers (paper, colour wash, ink, seal) are laid together.
 * Nothing here knows about the camera's gestures or the DOM's plate mark.
 */

/** Topology is computed once per geometry (usually by the generator's
 *  worker, along with it) and kept as long as it is. */
export const topologyOf = (geometry: Segments2D): BranchTopology => GeometryStore.topologyOf(geometry)

/** Room to keep clear around the plant, device pixels from each edge of
 *  the canvas. */
export interface Margins {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface Placement {
  /** Plate pixels per generator unit, and the origin's position. */
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
  /** The plant's box, plate-normalised (for the camera's clamp). */
  readonly focus: Rect
  /** The foot of the trunk, plate px, if the plant has one. */
  readonly root: { readonly x: number; readonly y: number } | undefined
  /** The plant's width on the plate, px. */
  readonly plantWidth: number
  /** Which way the crown's mass leans from the root: -1 left .. 1 right,
   *  as a share of the plant's width. */
  readonly lean: number
  /** Where the seal goes: its top-left corner and size, plate px. */
  readonly seal: { readonly x: number; readonly y: number; readonly size: number } | undefined
}

/** Share of the spare vertical room that goes below the plant: a plant
 *  rests low, with room for its ground; a figure with no ground (Koch,
 *  Sierpinski) is set at the optical centre, a little above the middle. */
const GROUND = 0.3
const OPTICAL_CENTRE = 0.54

/**
 * Fit the plant inside `margins` on a `width` × `height` canvas.
 *
 * Composition: vertically the plant rests low, with room for its ground;
 * an unbranched figure, which has no ground, sits at the optical centre.
 * Across, it is placed by its ink rather than its box: halfway between the
 * box's centre and the centre of its mass (segments weighted by length
 * and thickness), so a leaning crown keeps air on the side it reaches
 * towards; a plant that stands straight is set a little left of centre.
 * The seal balances the mass from the diagonally opposite lower corner.
 */
const placements = new WeakMap<Segments2D, { readonly key: string; readonly placement: Placement }>()

export const placePlant = (geometry: Segments2D, width: number, height: number, margins: Margins, sealSize: number): Placement => {
  const key = `${width}|${height}|${margins.left}|${margins.top}|${margins.right}|${margins.bottom}|${sealSize}`
  const cached = placements.get(geometry)
  if (cached?.key === key) return cached.placement
  const placement = computePlacement(geometry, width, height, margins, sealSize)
  placements.set(geometry, { key, placement })
  return placement
}

const computePlacement = (geometry: Segments2D, width: number, height: number, margins: Margins, sealSize: number): Placement => {
  const { minX, minY, maxX, maxY } = geometry.bounds
  const spanX = Math.max(maxX - minX, 1e-6)
  const spanY = Math.max(maxY - minY, 1e-6)
  const availW = Math.max(1, width - margins.left - margins.right)
  const availH = Math.max(1, height - margins.top - margins.bottom)
  const scale = Math.min(availW / spanX, availH / spanY)

  const topology = topologyOf(geometry)
  const isBranched = topology.maxRadius > 1.0001
  // The centre of the plant's ink.
  let mass = 0
  let massX = 0
  const { coords, count } = geometry
  const radius = topology.radius
  for (let i = 0; i < count; i++) {
    const o = i * 4
    const ax = coords[o] ?? 0
    const bx = coords[o + 2] ?? 0
    const w = Math.hypot(bx - ax, (coords[o + 3] ?? 0) - (coords[o + 1] ?? 0)) * (radius[i] ?? 1) ** 0.6
    mass += w
    massX += ((ax + bx) / 2) * w
  }
  const centreX = mass > 0 ? massX / mass : (minX + maxX) / 2
  const rootX = count > 0 ? coords[0] ?? 0 : 0
  const rootY = count > 0 ? coords[1] ?? 0 : 0
  const lean = isBranched ? Math.max(-1, Math.min(1, (centreX - rootX) / spanX)) : 0

  const cx = ((minX + maxX) / 2) * 0.5 + centreX * 0.5
  let offsetX = margins.left + availW / 2 - cx * scale
  if (isBranched && Math.abs(lean) < 0.06) offsetX -= availW * 0.035
  // Never past the margins.
  offsetX = Math.min(offsetX, width - margins.right - maxX * scale)
  offsetX = Math.max(offsetX, margins.left - minX * scale)
  const spareY = availH - spanY * scale
  const offsetY = height - margins.bottom - spareY * (isBranched ? GROUND : OPTICAL_CENTRE) + minY * scale

  const root = isBranched ? { x: offsetX + rootX * scale, y: offsetY - rootY * scale } : undefined
  // The seal: in the lower corner away from the mass, at about the height
  // of the ground, inset from the margins.
  let seal: Placement['seal']
  if (isBranched && root !== undefined) {
    const massOnPlate = offsetX + centreX * scale
    const sealOnRight = massOnPlate <= width / 2
    const inset = sealSize * 0.9
    const x = sealOnRight ? width - margins.right + inset * 0.6 - sealSize : margins.left - inset * 0.6
    const y = Math.min(root.y - sealSize * 1.6, height - margins.bottom - sealSize)
    seal = { x, y, size: sealSize }
  }
  return {
    scale,
    offsetX,
    offsetY,
    focus: {
      minX: (offsetX + minX * scale) / width,
      maxX: (offsetX + maxX * scale) / width,
      minY: (offsetY - maxY * scale) / height,
      maxY: (offsetY - minY * scale) / height,
    },
    root,
    plantWidth: spanX * scale,
    lean,
    seal,
  }
}

export interface FrameRequest {
  readonly geometry: Segments2D
  readonly palette: Palette
  readonly dpr: number
  readonly placement: Placement
  readonly view: View
  /** The canvas's shorter side, device px: sizes the trunk. */
  readonly minDimension: number
  readonly progress: number
  readonly mode: RevealMode
  /** Above this many segments, playback frames are drafts. */
  readonly draftSegments: number
  /** Reused for the growing radii; replaced if too short. */
  readonly scratch: Float32Array
}

/** The Frame for a request, and the scratch buffer it used. */
export const buildFrame = (request: FrameRequest): { readonly frame: Frame; readonly scratch: Float32Array } => {
  const { geometry, placement, dpr } = request
  const topology = topologyOf(geometry)
  const { scale, offsetX, offsetY } = placement

  // Widths come from the fitted plate, so zooming magnifies them.
  const widths = widthScale(topology.maxRadius, scale, dpr, request.minDimension)
  const strokeWidth = strokeWidthOf(widths)

  const { arrival, count } = geometry
  const isGrow = request.mode === 'Grow'
  const progress = Math.max(0, Math.min(1, request.progress))
  const threshold = progress * (isGrow ? geometry.maxArrival : count)
  const visible = isGrow ? (i: number) => threshold - (arrival[i] ?? 0) : (i: number) => threshold - i

  // While growing, branches thicken as the twigs they feed appear.
  let radius = topology.radius
  let scratch = request.scratch
  if (progress < 1) {
    if (scratch.length < count) scratch = new Float32Array(count)
    radius = scratch
    if (isGrow) growRadii(geometry, topology, PIPE_EXPONENT, radius, threshold)
    else pipeRadii(geometry, PIPE_EXPONENT, radius, Math.ceil(threshold))
  }

  return {
    frame: {
      geometry,
      topology,
      radius,
      palette: request.palette,
      dpr,
      scale,
      offsetX,
      offsetY,
      view: request.view,
      width: strokeWidth,
      visible,
      isGrow,
      isAnimating: progress < 1,
      isDraft: progress < 1 && count > request.draftSegments,
    },
    scratch,
  }
}

export interface Layers {
  readonly ink: HTMLCanvasElement
  readonly wash: HTMLCanvasElement
}

export interface Composition {
  readonly style: RenderStyle
  readonly season: Season
  readonly placement: Placement
  /** Lay the paper on `context` (identity transform). */
  readonly drawPaper: (context: CanvasRenderingContext2D) => void
  /** Clip `context` (identity transform) to where the painting may go. */
  readonly clip: (context: CanvasRenderingContext2D) => void
  /** Draw the twigs (and the Line style's pens) on the GPU; the screen
   *  only. Without it they are drawn on the canvas (the print). */
  readonly gpu?: GpuInk | undefined
}

/** Paint the wash and ink layers for `frame` and lay them, with the seal,
 *  on the paper in `target`, inside the clip. */
export const composePlate = (target: HTMLCanvasElement, layers: Layers, frame: Frame, composition: Composition): void => {
  const job = beginPlate(target, layers, frame, composition)
  while (!job.step(Number.POSITIVE_INFINITY)) {
    // At once.
  }
}

/**
 * `composePlate` as a job that can be spread over several tasks, so a big
 * repaint never blocks the page for long: each `step` works until
 * `deadline` (a `performance.now()` time), or through one indivisible
 * stage, and says whether the plate is done. The layers are the job's
 * until then (anything else painting with them must cancel it), and
 * `target` is only touched by the last step, in one go. The picture is
 * the same however the steps fall.
 */
export interface PlateJob {
  readonly step: (deadline: number) => boolean
}

export const beginPlate = (target: HTMLCanvasElement, layers: Layers, frame: Frame, composition: Composition): PlateJob => {
  const ink = layers.ink.getContext('2d')
  const out = target.getContext('2d')
  if (ink === null || out === null) return { step: () => true }
  const { view } = frame
  const { style, placement } = composition
  const isLine = style === 'Line'
  const isBranched = hasFoliage(frame)
  ink.setTransform(1, 0, 0, 1, 0, 0)
  ink.clearRect(0, 0, layers.ink.width, layers.ink.height)
  applyView(ink, view)
  if (isLine) {
    paintLines(ink, frame, composition.gpu)
    ink.setTransform(1, 0, 0, 1, 0, 0)
    return { step: () => (finishPlate(ink, out, layers, frame, composition, isBranched), true) }
  }
  const job = beginInk(ink, frame, composition.gpu)
  let isWalked = false
  let isSealReady = false
  let isInked = false
  return {
    step: deadline => {
      if (!isWalked) {
        isWalked = job.step(deadline)
        if (!isWalked || performance.now() > deadline) return false
      }
      if (!isSealReady) {
        // Made (and cached) at this zoom in a step of its own.
        const seal = visibleSeal(frame, composition)
        if (seal !== undefined) sealImage(seal.size * view.zoom)
        isSealReady = true
        if (performance.now() > deadline) return false
      }
      if (!isInked) {
        applyView(ink, view)
        job.finish()
        // The ground goes on after the tree, so the trunk stands in it
        // rather than on it.
        if (isBranched) paintGround(ink, frame, placement)
        ink.setTransform(1, 0, 0, 1, 0, 0)
        isInked = true
        if (performance.now() > deadline) return false
      }
      finishPlate(ink, out, layers, frame, composition, isBranched)
      return true
    },
  }
}

/** The foliage, then everything laid on the paper. */
const finishPlate = (
  ink: CanvasRenderingContext2D,
  out: CanvasRenderingContext2D,
  layers: Layers,
  frame: Frame,
  composition: Composition,
  isBranched: boolean,
): void => {
  const { view, palette } = frame
  const { style, placement } = composition
  const isLine = style === 'Line'
  const isWashed = (style === 'Leaf' || style === 'Blossom') && isBranched
  const wash = isWashed ? layers.wash.getContext('2d') : null
  if (wash !== null && (style === 'Leaf' || style === 'Blossom')) {
    wash.setTransform(1, 0, 0, 1, 0, 0)
    wash.clearRect(0, 0, layers.wash.width, layers.wash.height)
    applyView(wash, view)
    const foliage = paintFoliage(wash, frame, style, composition.season, placement)
    wash.setTransform(1, 0, 0, 1, 0, 0)
    if (foliage !== undefined) {
      // Leaves and flowers in front lift the ink of the twigs behind them.
      applyView(ink, view)
      ink.globalCompositeOperation = 'destination-out'
      ink.globalAlpha = foliage.strength
      ink.fill(foliage.occluders)
      ink.globalCompositeOperation = 'source-over'
      ink.globalAlpha = 1
      ink.setTransform(1, 0, 0, 1, 0, 0)
    }
  }

  out.setTransform(1, 0, 0, 1, 0, 0)
  out.globalCompositeOperation = 'source-over'
  out.globalAlpha = 1
  composition.drawPaper(out)
  out.save()
  composition.clip(out)
  // Soaking into the paper is a texture: it grows with the paper's grain,
  // not with the zoom.
  const soak = frame.dpr * view.texture
  if (wash !== null) {
    // The colour goes down first; ink over a glaze multiplies the same
    // either way, and on dark paper the ink must sit on top.
    out.globalCompositeOperation = palette.washBlend
    if (!frame.isAnimating) {
      out.filter = `blur(${(1.4 * soak).toFixed(2)}px)`
      out.globalAlpha = 0.45 * palette.washAlpha
      out.drawImage(layers.wash, 0, 0)
      out.filter = 'none'
    }
    out.globalAlpha = 0.8 * palette.washAlpha
    out.drawImage(layers.wash, 0, 0)
  }
  out.globalCompositeOperation = palette.blend
  if (!isLine && !frame.isDraft) {
    // Bleed: a soft halo of the same ink, as if it soaked into the fibres.
    out.filter = `blur(${(1.1 * soak).toFixed(2)}px)`
    out.globalAlpha = 0.4
    out.drawImage(layers.ink, 0, 0)
    out.filter = 'none'
  }
  out.globalAlpha = 1
  out.drawImage(layers.ink, 0, 0)
  out.globalCompositeOperation = 'source-over'
  // The seal, pressed last; a technical drawing doesn't get one.
  const seal = visibleSeal(frame, composition)
  if (seal !== undefined) {
    applyView(out, view)
    paintSeal(out, seal.x, seal.y, seal.size, view.zoom, palette.isDark)
    out.setTransform(1, 0, 0, 1, 0, 0)
  }
  out.restore()
  out.globalCompositeOperation = 'source-over'
}

/** The seal, if it is pressed on this plate and any of it is on screen:
 *  at a deep zoom its image is big to make, so it is only made where it
 *  shows. */
const visibleSeal = (frame: Frame, composition: Composition): Placement['seal'] => {
  const seal = composition.placement.seal
  if (composition.style === 'Line' || seal === undefined) return undefined
  return isInView(frame.view, seal.x, seal.y, seal.x + seal.size, seal.y + seal.size, seal.size * 0.1) ? seal : undefined
}
