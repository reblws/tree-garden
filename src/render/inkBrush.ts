import { litSide, shade } from '../core/shading'
import { makeCanvas } from './canvas'
import { CollinearPen } from './collinearPen'
import { paintDensityWash } from './densityWash'
import { type Frame, clamp, isInView, textureMatrix } from './frame'
import { type GpuInk, layGpuFrame } from './gpuInk'
import { FbmCurve, NoiseCurve, hash2 } from './noise'
import { TONE_CLASSES, WIDTH_CLASS, aerial, coolness, inkDensity, radiusFor, toneClassOf, widthLawOf, widthScaleOf } from './twigPlan'

/**
 * Ink-brush painter (sumi-e). The tree is painted the way a person would
 * paint it: as stroke chains (see core/branching.ts), each one a single
 * tapering brush mark from its fork to its tip.
 *
 * - Strokes wider than a couple of pixels become filled outlines whose
 *   edges wander with seeded noise and whose width follows the pipe-model
 *   radius, so the trunk swells at the base and thins at every fork.
 * - Each body is an opaque tone of ink combined with the others by
 *   `palette.union` (keep the denser), so a branch flows out of its limb
 *   without a seam; the branch starts in its parent's tone, flares a little
 *   into a collar, and eases into its own tone.
 * - Tone is aerial perspective: higher-order and receding branches
 *   (`chainOrder`, `chainRecession`) are lighter and cooler, as thinned
 *   sumi ink turns blue-grey.
 * - Bark (see `piece`): a cylinder lit from the upper left, suggested the
 *   ink-wash way, by a darker band inside the shadow edge and ink lifted on
 *   the lit side; fissures that run with the stroke and weave, thicker on
 *   the shadow side, so the texture itself models the form; lenticels on
 *   young, smooth branches; a wet rim just inside the edges; and dry-brush
 *   "flying white" on the lit side and towards the end of the stroke.
 *   Detail emerges with the zoom: three octaves of fissures and a fine
 *   octave of edge roughness fade in as there are pixels to hold them.
 * - Everything narrower is drawn as continuous polylines grouped by width
 *   and tone: one stroke call per class, so hundreds of thousands of twigs
 *   stay cheap. Where twigs crowd, they are thinned to a wash and laid over
 *   a soft density field (densityWash.ts), so dense crowns read as mist.
 *   On screen the twigs are drawn on the GPU (gpuInk.ts), which makes the
 *   same decisions from the same thresholds (twigPlan.ts); the Canvas2D
 *   polylines remain for the print and when WebGL2 isn't there, with
 *   straight runs merged into single lines (collinearPen.ts).
 *
 * All noise is a hash of the chain index and the distance along the chain
 * in plate units, so marks never flicker, swim or crawl under the camera.
 *
 * Zoom: everything is built in plate pixels and drawn under the view's
 * transform, so a stroke is the same mark at any zoom, only rasterised
 * bigger. What changes with the zoom is detail, never the marks: outlines
 * get more points, finer bark fades in, twigs wide enough on screen become
 * brush outlines in their own tone, and whatever is off screen is culled.
 */

/** Strokes at least this many pixels wide on screen get the full brush. */
const BRUSH_MIN_WIDTH = 2
/** Bark (shading, fissures, rim, dry brush) from this width, CSS px. */
const BARK_MIN_CSS = 3.2
/** Sample spacing along a brush stroke, CSS pixels on the fitted plate. */
const SAMPLE_STEP = 3.5
/** Upper bound on brush samples per frame for limbs (strokes that are a
 *  brush on the fitted plate), and separately for twigs promoted to brush
 *  strokes when zoomed in, so a crowd of twigs can never starve the limbs.
 *  Past them strokes fall back to polylines. Keeps pathological inputs
 *  interactive. */
const SAMPLE_BUDGET = 120_000
const PROMOTE_BUDGET = 60_000
/** When a paint is spread over tasks (`beginInk`), a limb is left for the
 *  next task once less than this much of the current one remains, ms. */
const LIMB_HEADROOM = 8
/** Upper bound on the extra samples taken when zoomed in (see `upsample`).
 *  Past it strokes keep their plate-resolution outline. */
const FINE_BUDGET = 400_000

/**
 * Bark fissures, coarse to fine. Sizes in CSS pixels of the fitted plate:
 * `spacing` between tracks across the stroke, `width` of a fissure, `dash`
 * the wavelength of its breaks, `weave` of its wander. `from`/`full`: the
 * detail level (≈ zoom on a 2× screen) where it starts to show and where it
 * is at full strength.
 */
const OCTAVES = [
  { spacing: 2.6, width: 0.85, dash: 15, weave: 24, from: 0, full: 0, alpha: 0.72, maxTracks: 16 },
  { spacing: 1.1, width: 0.3, dash: 6.5, weave: 10, from: 1.6, full: 3.5, alpha: 0.6, maxTracks: 40 },
  { spacing: 0.5, width: 0.12, dash: 2.6, weave: 4, from: 5, full: 10, alpha: 0.5, maxTracks: 90 },
] as const

// Scratch buffers, grown on demand and reused across frames. The `x/y/w/s`
// buffers hold a stroke's samples at plate resolution (one every
// SAMPLE_STEP on the fitted plate); the `f*` buffers hold the part of it on
// screen, resampled to keep one sample every SAMPLE_STEP on screen.
let xs = new Float64Array(1024)
let ys = new Float64Array(1024)
let ws = new Float64Array(1024)
let ss = new Float64Array(1024)
let scratch = new Float64Array(1024)
let fx = new Float64Array(1024)
let fy = new Float64Array(1024)
let fw = new Float64Array(1024)
let fs = new Float64Array(1024)
let lx = new Float64Array(1024)
let ly = new Float64Array(1024)
let rx = new Float64Array(1024)
let ry = new Float64Array(1024)
let hl = new Float64Array(1024)
let hr = new Float64Array(1024)
let zs = new Float64Array(1024)
let tx = new Float64Array(1024)
let ty = new Float64Array(1024)
let lit = new Float64Array(1024)
let tr = new Float64Array(1024)
let bu = new Float64Array(1024)
let scratchAway = new Float64Array(1024)
// A fissure's run of points: centre, normal, width.
let qx = new Float64Array(1024)
let qy = new Float64Array(1024)
let qnx = new Float64Array(1024)
let qny = new Float64Array(1024)
let qw = new Float64Array(1024)
let ql = new Float64Array(1024)

/** Grow the plate-resolution buffers, keeping what they hold: they are
 *  grown while a chain is being sampled into them. */
const ensure = (n: number) => {
  if (n <= xs.length) return
  const size = Math.max(n, xs.length * 2)
  const grow = (from: Float64Array) => {
    const to = new Float64Array(size)
    to.set(from)
    return to
  }
  xs = grow(xs)
  ys = grow(ys)
  ws = grow(ws)
  ss = grow(ss)
  scratch = new Float64Array(size)
}

const ensureFine = (n: number) => {
  if (n <= fx.length) return
  const size = Math.max(n, fx.length * 2)
  fx = new Float64Array(size)
  fy = new Float64Array(size)
  fw = new Float64Array(size)
  fs = new Float64Array(size)
  lx = new Float64Array(size)
  ly = new Float64Array(size)
  rx = new Float64Array(size)
  ry = new Float64Array(size)
  hl = new Float64Array(size)
  hr = new Float64Array(size)
  zs = new Float64Array(size)
  tx = new Float64Array(size)
  ty = new Float64Array(size)
  lit = new Float64Array(size)
  tr = new Float64Array(size)
  bu = new Float64Array(size)
  scratchAway = new Float64Array(size)
  qx = new Float64Array(size)
  qy = new Float64Array(size)
  qnx = new Float64Array(size)
  qny = new Float64Array(size)
  qw = new Float64Array(size)
  ql = new Float64Array(size)
}

// Noise walkers for the bark loops: each keeps its lattice cell, so the
// several samples a stroke takes per cell don't hash again. Reset to a
// curve's seed before each walk; the values are noise1's and fbm1's.
const pressureCurve = new NoiseCurve(0)
const leftCurve = new FbmCurve(0)
const rightCurve = new FbmCurve(0)
const leftFine = new NoiseCurve(0)
const rightFine = new NoiseCurve(0)
const bandBroad = new NoiseCurve(0)
const bandFine = new NoiseCurve(0)
const trackRank = new NoiseCurve(0)
const trackDash = new NoiseCurve(0)
const trackWeave = new FbmCurve(0)
const dryZone = new NoiseCurve(0)
const hairDash = new NoiseCurve(0)

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** The body of a brush stroke is a wash, lighter than a line of the same
 *  width: its bark, shading and rim (see `piece`) carry the darks, as the
 *  texture strokes (cun) do over a wash in a Chinese painting of a tree. */
const bodyDensity = (cssWidth: number): number => 0.62 + 0.1 * widthScaleOf(cssWidth)

/**
 * Paint the ink of `frame`. With `gpu` (and WebGL2 up), the twigs are drawn
 * on the GPU and laid in where their polylines would have been stroked.
 */
/**
 * Paint the ink of `frame` as a job that can be spread over several tasks:
 * `step` walks the chains (building brush outlines, the bulk of the work)
 * until `deadline` (a `performance.now()` time) and says whether it is
 * done; `finish` then lays everything down. Nothing but the density wash
 * touches `context` before `finish`, and the result is the same however
 * the steps fall. With `gpu` (and WebGL2 up), the twigs are drawn on the GPU
 * and laid in where their polylines would have been stroked.
 */
export const beginInk = (context: CanvasRenderingContext2D, frame: Frame, gpu?: GpuInk): InkJob => {
  const { geometry, topology, radius, dpr, scale, offsetX, offsetY, visible, view, palette } = frame
  const { coords, parent } = geometry
  const { chainSegments, chainStart, chainCount, mainChild, chainOrder, chainRecession, chainParent } = topology
  const zoom = view.zoom
  // Drafts keep the brush for the limbs only and leave out the bark.
  // `brushMin` is in plate pixels and doesn't depend on the zoom: what is a
  // brush stroke on the fitted plate stays one, with the same texture.
  const brushMin = BRUSH_MIN_WIDTH * dpr * (frame.isDraft ? 1.75 : 1)
  // Zoomed in, twigs that are now wide on screen are promoted from
  // polylines to brush outlines too, keeping their twig tone. Not in
  // drafts: on a big tree that can be every twig on screen.
  const promoteMin = frame.isDraft ? Number.POSITIVE_INFINITY : brushMin / zoom
  const step = SAMPLE_STEP * dpr
  const isZoomed = zoom > 1 + 1e-6
  // The width tests as radius thresholds (w(r) >= w ⟺ r >= radiusFor(w)),
  // which the GPU makes too, on the same float32 radii.
  const law = widthLawOf(frame.width)
  const brushRadius = radiusFor(law, brushMin)
  const promoteRadius = isZoomed ? radiusFor(law, promoteMin) : Number.POSITIVE_INFINITY
  const isGpu = gpu !== undefined && gpu.isAvailable()
  // Chain positions (see twigPlan.packSegmentMeta) from which the brush and
  // promotion budgets were spent: the GPU needs them to agree.
  let coarseCut = Number.POSITIVE_INFINITY
  let promoteCut = Number.POSITIVE_INFINITY
  // Room around a segment for the widest stroke there is, for culling.
  const cullPad = frame.width(topology.maxRadius) * 2 + 4 * dpr

  // Twigs dense enough to blacken a crown are diluted to an ink wash. The
  // area is the plant's on the fitted plate, so the tone keeps at any zoom.
  const { minX, minY, maxX, maxY } = geometry.bounds
  const area = Math.max(1, ((maxX - minX) * scale) / dpr) * Math.max(1, ((maxY - minY) * scale) / dpr)
  const crowding = (6 * geometry.count) / area
  // Past this crowding the crown is laid in as a wash first, so the twigs
  // over it can be thinned further without the crown losing its mass.
  const isMisty = crowding > 2.2
  const dilution = clamp(1 / Math.sqrt(1 + crowding), isMisty ? 0.17 : 0.3, 1)
  // The mist first: brush bodies keep the darker of their tone and it.
  if (isMisty) paintDensityWash(context, frame, crowding)

  const level = {
    detail: view.detail,
    texture: view.texture,
    zoom,
    octaves: OCTAVES.map(o => (o.full <= o.from ? 1 : smoothstep(o.from, o.full, view.detail))),
    edgeFine: smoothstep(2, 6, view.detail),
    lenticels: smoothstep(0.8, 2.5, view.detail),
    ridges: smoothstep(1.4, 3, view.detail),
    // The wet rim is the ink's, not the branch's: it keeps about its width
    // on paper as you zoom, and lies just inside the edge.
    rim: (1.05 * dpr * view.texture) / zoom,
  }

  // Each chain's tone, kept so a branch can start in its parent's.
  const density = new Float32Array(chainCount)
  const cool = new Float32Array(chainCount)

  context.lineCap = 'round'
  context.lineJoin = 'round'

  // Polyline paths by tone class and on-screen width class.
  const thin: Array<Array<Path2D | undefined>> = Array.from({ length: TONE_CLASSES }, () => [])
  const budget = { coarse: SAMPLE_BUDGET, promote: PROMOTE_BUDGET, fine: FINE_BUDGET }
  const brushes: Array<Brush> = []
  /** Promoted twigs without marks, by tone (see `promote`). */
  const batched = new Map<number, Path2D>()

  const pen = new CollinearPen()

  const walkChain = (c: number): void => {
    const begin = chainStart[c] ?? 0
    const end = chainStart[c + 1] ?? 0
    const first = chainSegments[begin] ?? 0
    if (visible(first) <= 0) return
    // On the GPU, a chain that is all twig is drawn there entirely. (Its
    // tone is never needed: a chain with a brush stroke or a promoted twig
    // has a parent with one too, being at least as wide.)
    if (isGpu) {
      const r = radius[first] ?? 0
      if ((r < brushRadius || budget.coarse <= 0) && (r < promoteRadius || budget.promote <= 0)) return
    }
    const order = chainOrder[c] ?? 0
    const recession = chainRecession[c] ?? 0
    const airy = aerial(order, recession)
    const chainCool = coolness(order, recession)
    const toneClass = toneClassOf(recession)
    cool[c] = chainCool
    const up = chainParent[c] ?? -1

    // Where the chain leaves its parent: how deep inside the parent's body
    // it starts, so its rim and bark begin where it emerges.
    const p = parent[first] ?? -1
    let join: Join | undefined
    if (p >= 0 && up >= 0) {
      const parentWidth = frame.width(radius[p] ?? 0)
      const po = p * 4
      const fo = first * 4
      const pdx = (coords[po + 2] ?? 0) - (coords[po] ?? 0)
      const pdy = (coords[po + 3] ?? 0) - (coords[po + 1] ?? 0)
      const cdx = (coords[fo + 2] ?? 0) - (coords[fo] ?? 0)
      const cdy = (coords[fo + 3] ?? 0) - (coords[fo + 1] ?? 0)
      const sin = Math.abs(pdx * cdy - pdy * cdx) / (Math.hypot(pdx, pdy) * Math.hypot(cdx, cdy) || 1)
      join = {
        parentHalf: parentWidth / 2,
        // A little short of where it clears the parent's edge, so its bark
        // is under way where it shows.
        inside: Math.min((parentWidth / 2) / Math.max(sin, 0.3), parentWidth * 1.6) * 0.75,
        density: density[up] ?? 0.8,
        cool: cool[up] ?? 0,
      }
    }

    /** A twig of chain `c` wide enough on screen to be a brush stroke, in
     *  the samples buffers: painted in its twig's tone. Returns the
     *  emptied sample count. */
    const promote = (count: number, width: number, total: number, isStart: boolean): number => {
      if (count >= 2) {
        const d = inkDensity(width / dpr) * airy * dilution
        const isModelled = width * zoom >= 9 * dpr
        // Its parent's tone at its foot, if that shows.
        const from = isStart && join !== undefined && Math.abs(join.density - d) + Math.abs(join.cool - chainCool) * 0.5 > 0.04 ? join : undefined
        // Plain twigs are batched by tone: one fill for many.
        let body: Path2D | undefined
        if (!isModelled && from === undefined) {
          const key = Math.round(d * 64) * 32 + Math.round(chainCool * 16)
          body = batched.get(key)
          if (body === undefined) {
            body = new Path2D()
            batched.set(key, body)
          }
        }
        const brush = brushStroke(c, count, width, frame, budget, level, {
          isRoot: false,
          isTextured: false,
          isModelled,
          density: d,
          cool: chainCool,
          total,
          join: isStart ? join : undefined,
          joinTone: from !== undefined,
          body,
        })
        if (brush !== undefined && body === undefined) brushes.push(brush)
      }
      return 0
    }

    // 1. Walk the visible, wide part of the chain into samples. This part
    //    is walked whole, on screen or not, so its smoothing and texture
    //    don't depend on the view; only its outline is culled.
    let n = 0
    let k = begin
    let length = 0
    let maxWidth = 0
    for (; k < end; k++) {
      const segment = chainSegments[k] ?? 0
      const v = visible(segment)
      if (v <= 0) break
      if ((radius[segment] ?? 0) < brushRadius || budget.coarse <= 0) break
      const w0 = frame.width(radius[segment] ?? 0)
      const next = mainChild[segment] ?? -1
      const isLast = v < 1 || next < 0 || visible(next) <= 0
      const w1 = isLast ? w0 * (v < 1 ? 0.25 : 0.45) : frame.width(radius[next] ?? 0)
      const o = segment * 4
      const fraction = v < 1 ? v : 1
      const x0 = offsetX + (coords[o] ?? 0) * scale
      const y0 = offsetY - (coords[o + 1] ?? 0) * scale
      const x1 = x0 + ((coords[o + 2] ?? 0) - (coords[o] ?? 0)) * scale * fraction
      const y1 = y0 - ((coords[o + 3] ?? 0) - (coords[o + 1] ?? 0)) * scale * fraction
      const before = n
      n = appendSamples(n, x0, y0, x1, y1, w0, w1, length, step)
      length = ss[n - 1] ?? length
      if (w0 > maxWidth) maxWidth = w0
      // Only what will be drawn counts against the budget: zoomed in, most
      // of the tree is walked (so its texture stays put) but culled.
      if (!isZoomed || isInView(view, x0, y0, x1, y1, w0 * 2 + 4 * dpr)) {
        budget.coarse -= n - before
        if (budget.coarse <= 0 && coarseCut === Number.POSITIVE_INFINITY) coarseCut = k + 1
      }
      if (isLast) {
        k++
        break
      }
    }

    // The chain's own tone: dense for limbs, lighter for thin strokes and
    // for anything further out or further back.
    const startWidth = n >= 2 ? maxWidth : frame.width(radius[first] ?? 0)
    const thinMix = smoothstep(2, 6, startWidth / dpr)
    density[c] = (n >= 2 ? bodyDensity(startWidth / dpr) : inkDensity(startWidth / dpr)) * airy * (dilution + (1 - dilution) * thinMix)

    if (n >= 2) {
      const isRoot = (parent[first] ?? -1) < 0
      const brush = brushStroke(c, n, maxWidth, frame, budget, level, {
        isRoot,
        isTextured: !frame.isDraft && maxWidth / dpr >= BARK_MIN_CSS,
        isModelled: false,
        joinTone: true,
        body: undefined,
        density: density[c] ?? 0.8,
        cool: chainCool,
        total: length,
        join,
      })
      if (brush !== undefined) brushes.push(brush)
    }

    // 2. The rest of the chain: polylines grouped by width class, or, when
    //    zoomed in far enough, brush strokes of their own. The distance
    //    along the chain is kept so their texture stays put. On the GPU
    //    only the promoted twigs are walked: once the chain is too thin to
    //    promote (it only narrows), the rest is the GPU's.
    let lastClass = -1
    let arc = length
    let runWidth = 0
    let runStart = 0
    let runIsStart = false
    const twigs = thin[toneClass] as Array<Path2D | undefined>
    n = 0
    for (; k < end; k++) {
      const segment = chainSegments[k] ?? 0
      const v = visible(segment)
      if (v <= 0) break
      const r = radius[segment] ?? 0
      if (isGpu && (r < promoteRadius || budget.promote <= 0)) break
      const fraction = v < 1 ? v : 1
      const o = segment * 4
      const ax = coords[o] ?? 0
      const ay = coords[o + 1] ?? 0
      const x0 = offsetX + ax * scale
      const y0 = offsetY - ay * scale
      const x1 = offsetX + (ax + ((coords[o + 2] ?? 0) - ax) * fraction) * scale
      const y1 = offsetY - (ay + ((coords[o + 3] ?? 0) - ay) * fraction) * scale
      // Off screen even at the widest: skip it before working out its width.
      if (isZoomed && !isInView(view, x0, y0, x1, y1, cullPad)) {
        if (n > 0) {
          n = promote(n, runWidth, arc - runStart, runIsStart)
          runWidth = 0
        }
        arc += Math.hypot(x1 - x0, y1 - y0)
        if (lastClass !== -1) pen.end()
        lastClass = -1
        if (v < 1) break
        continue
      }
      const w0 = frame.width(r)
      if (r >= promoteRadius && budget.promote > 0 && isInView(view, x0, y0, x1, y1, w0 * 2 + 4 * dpr)) {
        const next = mainChild[segment] ?? -1
        const isLast = v < 1 || next < 0 || visible(next) <= 0
        const w1 = isLast ? w0 * (v < 1 ? 0.25 : 0.45) : frame.width(radius[next] ?? 0)
        if (n === 0) {
          runStart = arc
          runIsStart = k === begin
        }
        const before = n
        n = appendSamples(n, x0, y0, x1, y1, w0, w1, arc, step)
        budget.promote -= n - before
        if (budget.promote <= 0 && promoteCut === Number.POSITIVE_INFINITY) promoteCut = k + 1
        arc = ss[n - 1] ?? arc
        if (w0 > runWidth) runWidth = w0
        if (lastClass !== -1) pen.end()
        lastClass = -1
        if (isLast) n = promote(n, runWidth, arc - runStart, runIsStart)
        if (v < 1) break
        continue
      }
      if (n > 0) {
        n = promote(n, runWidth, arc - runStart, runIsStart)
        runWidth = 0
      }
      const w = w0 * (v < 1 ? 0.7 : 1)
      if (isZoomed) {
        arc += Math.hypot(x1 - x0, y1 - y0)
        if (!isInView(view, x0, y0, x1, y1, w)) {
          if (lastClass !== -1) pen.end()
          lastClass = -1
          if (v < 1) break
          continue
        }
      }
      if (isGpu) {
        // A twig on screen that isn't promoted: the GPU draws it.
        if (v < 1) break
        continue
      }
      const widthClass = Math.max(1, Math.round((w * zoom) / (WIDTH_CLASS * dpr)))
      const path = (twigs[widthClass] ??= new Path2D())
      if (widthClass !== lastClass) {
        pen.moveTo(path, x0, y0)
        lastClass = widthClass
      }
      pen.lineTo(x0, y0, x1, y1)
      if (v < 1) break
    }
    pen.end()
    if (n > 0) promote(n, runWidth, arc - runStart, runIsStart)
  }

  let next = 0
  const walk = (deadline: number): boolean => {
    let ran = 0
    while (next < chainCount) {
      // A limb (a chain that starts as a brush stroke) can take a while:
      // start one in a fresh task rather than at the end of a busy one.
      if (ran++ > 0 && (radius[chainSegments[chainStart[next] ?? 0] ?? 0] ?? 0) >= brushRadius && performance.now() > deadline - LIMB_HEADROOM) break
      const spent = budget.coarse + budget.promote
      walkChain(next++)
      // Look at the clock after every brush stroke (they can take a while)
      // and every few twigs.
      if ((budget.coarse + budget.promote !== spent || (next & 15) === 0) && performance.now() > deadline) break
    }
    return next >= chainCount
  }

  const finish = (): boolean => {
    context.lineCap = 'round'
    context.lineJoin = 'round'

    // Twigs first, light and fine; the brush strokes go on top. Where
    // thousands of twigs crowd each square inch they are laid in as a wash of
    // diluted ink rather than a solid black mass.
    if (isGpu) {
      const image = gpu.twigs(
        frame,
        {
          law,
          brushRadius,
          promoteRadius,
          coarseCut,
          promoteCut,
          maxTwigWidth: twigCeiling(frame, brushMin, promoteMin, isZoomed, coarseCut, promoteCut),
          dilution,
        },
        context.canvas.width,
        context.canvas.height,
      )
      // The GPU failed (its context lost, an allocation refused): the twig
      // chains were never walked here, so stop; the caller paints the ink
      // again on the canvas alone.
      if (image === undefined) return false
      layGpuFrame(context, image)
    }
    for (let t = 0; t < TONE_CLASSES; t++) {
      const recession = t / (TONE_CLASSES - 1)
      const twigs = thin[t] as Array<Path2D | undefined>
      for (let widthClass = 1; widthClass < twigs.length; widthClass++) {
        const path = twigs[widthClass]
        if (path === undefined) continue
        const w = (widthClass * WIDTH_CLASS * dpr) / zoom
        context.lineWidth = w
        context.strokeStyle = palette.inkTint(coolness(2, recession), 1)
        context.globalAlpha = inkDensity(w / dpr) * aerial(2, recession) * dilution
        context.stroke(path)
      }
    }

    // Promoted twigs without marks, a fill per tone; they are thinner than
    // any brush stroke, so they go first.
    context.globalAlpha = 1
    context.globalCompositeOperation = palette.union
    for (const [key, path] of batched) {
      context.fillStyle = palette.tone(Math.floor(key / 32) / 64, (key % 32) / 16)
      context.fill(path)
    }
    context.globalCompositeOperation = 'source-over'

    // Brush strokes, finest first so a limb lies over the twigs at its fork.
    const tooth = context.createPattern(toothTile(), 'repeat')
    const toothSpace = textureMatrix(view, true)
    brushes.sort((a, b) => a.width - b.width)
    for (const brush of brushes) {
      context.globalAlpha = 1
      context.globalCompositeOperation = palette.union
      const tone = palette.tone(brush.density, brush.cool)
      const { join } = brush
      if (join !== undefined) {
        // The branch starts in its parent's tone and eases into its own.
        const gradient = context.createLinearGradient(join.x0, join.y0, join.x1, join.y1)
        gradient.addColorStop(0, palette.tone(join.density, join.cool))
        gradient.addColorStop(0.35, palette.tone(join.density, join.cool))
        gradient.addColorStop(1, tone)
        context.fillStyle = gradient
      } else {
        context.fillStyle = tone
      }
      context.fill(brush.body)
      const marks = brush.marks
      if (marks === undefined) continue
      // Marks are made with the stroke's own ink: a pale, diluted stroke
      // gets pale marks.
      const strength = Math.min(1, brush.density / 0.7)
      // Shade and bark are darks, light and dry brush are lights. On light
      // paper darks add ink and lights lift it; in the dark theme the "ink"
      // is a pale chalk, so the two swap: darks lift chalk, lights add it.
      const darks: GlobalCompositeOperation = palette.isDark ? 'destination-out' : 'source-over'
      const lights: GlobalCompositeOperation = palette.isDark ? 'source-over' : 'destination-out'
      const ink = palette.inkTint(brush.cool * 0.6, 1)
      context.fillStyle = ink
      context.strokeStyle = ink
      context.globalCompositeOperation = darks
      // Volume: a broad half-shadow, then the core shadow inside it.
      context.globalAlpha = 0.15 * strength
      context.fill(marks.shadeBroad)
      context.globalAlpha = 0.2 * strength
      context.fill(marks.shadeCore)
      // Wet edge: ink gathered where the stroke's water front dried.
      context.globalAlpha = (palette.isDark ? 0.3 : 0.5) * strength ** 2
      context.lineWidth = level.rim
      context.stroke(marks.rim)
      // Bark.
      marks.fissures.forEach((path, k) => {
        if (path === undefined || (level.octaves[k] ?? 0) <= 0) return
        context.globalAlpha = (OCTAVES[k]?.alpha ?? 0.4) * (level.octaves[k] ?? 0) * strength
        context.fill(path)
      })
      if (marks.lenticels !== undefined) {
        context.globalAlpha = 0.38 * level.lenticels * strength
        context.fill(marks.lenticels)
      }
      // Light: ink lifted on the lit side and the lips of the fissures
      // catching the light.
      context.globalCompositeOperation = lights
      context.globalAlpha = palette.isDark ? 0.06 : 0.075
      context.fill(marks.light)
      context.fill(marks.lightCore)
      context.fill(marks.lightInner)
      if (marks.ridges !== undefined) {
        context.globalAlpha = 0.2 * level.ridges
        context.fill(marks.ridges)
      }
      // Dry brush: the paper itself, whatever the theme, lifted through the
      // paper's tooth, its grains dragged out along the stroke.
      if (marks.dry !== undefined && tooth !== null) {
        tooth.setTransform(toothSpace.rotate(brush.angle).scaleSelf(2.4 * dpr, 0.6 * dpr))
        context.fillStyle = tooth
        context.globalCompositeOperation = 'destination-out'
        context.globalAlpha = 0.78
        context.fill(marks.dry)
        context.fillStyle = ink
      }
      context.globalCompositeOperation = 'source-over'
    }
    context.globalAlpha = 1
    return true
  }

  return { step: walk, finish }
}

/** A paint of the ink spread over tasks: see `beginInk`. */
export interface InkJob {
  readonly step: (deadline: number) => boolean
  /** Lay it all down. False if the GPU failed on the way: the layer is
   *  then incomplete, and should be painted again without it. */
  readonly finish: () => boolean
}

/** Paint the ink of `frame` at once. */
export const paintInk = (context: CanvasRenderingContext2D, frame: Frame, gpu?: GpuInk): void => {
  const job = beginInk(context, frame, gpu)
  job.step(Number.POSITIVE_INFINITY)
  if (job.finish()) return
  // The GPU failed: again, on the canvas alone.
  clearLayer(context)
  const again = beginInk(context, frame)
  again.step(Number.POSITIVE_INFINITY)
  again.finish()
}

/** Clear the layer `context` paints on, keeping the view on it. */
export const clearLayer = (context: CanvasRenderingContext2D): void => {
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)
  context.restore()
}

/** The widest twig that can be on screen, plate px: narrower than a brush
 *  stroke and, zoomed in, than a promoted twig, unless a budget ran out. */
const twigCeiling = (frame: Frame, brushMin: number, promoteMin: number, isZoomed: boolean, coarseCut: number, promoteCut: number): number => {
  const widest = frame.width(frame.topology.maxRadius)
  if (Number.isFinite(coarseCut)) return widest
  if (isZoomed && Number.isFinite(promoteMin) && !Number.isFinite(promoteCut)) return Math.min(widest, brushMin, promoteMin)
  return Math.min(widest, brushMin)
}

/** Append samples for a straight piece from (x0, y0) to (x1, y1) to the
 *  plate-resolution buffers, starting the stroke at distance `s0` if it is
 *  empty. Returns the new sample count. */
const appendSamples = (
  n: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w0: number,
  w1: number,
  s0: number,
  step: number,
): number => {
  const segmentLength = Math.hypot(x1 - x0, y1 - y0)
  const pieces = Math.max(1, Math.ceil(segmentLength / step))
  ensure(n + pieces + 2)
  let count = n
  if (count === 0) {
    xs[0] = x0
    ys[0] = y0
    ws[0] = w0
    ss[0] = s0
    count = 1
  }
  const start = ss[count - 1] ?? s0
  for (let p = 1; p <= pieces; p++) {
    const t = p / pieces
    xs[count] = x0 + (x1 - x0) * t
    ys[count] = y0 + (y1 - y0) * t
    ws[count] = w0 + (w1 - w0) * t
    ss[count] = start + segmentLength * t
    count++
  }
  return count
}

const TOOTH_TILE = 128
const TOOTH_CELL = 3
let tooth: HTMLCanvasElement | undefined

/** The paper's tooth as an alpha mask: where a dry brush touches only the
 *  peaks of the paper, ink is lifted in grains rather than clean lines. */
export const toothTile = (): HTMLCanvasElement => {
  if (tooth !== undefined) return tooth
  tooth = makeCanvas(TOOTH_TILE, TOOTH_TILE)
  const context = tooth.getContext('2d')
  if (context === null) return tooth
  const image = context.createImageData(TOOTH_TILE, TOOTH_TILE)
  // Value noise on a lattice that wraps at the tile's edge, plus a little
  // per-pixel grit, thresholded into flecks.
  const cells = TOOTH_TILE / TOOTH_CELL
  const lattice = (i: number, j: number) => hash2(((i + cells) % cells) * 92821 + 5, (j + cells) % cells)
  for (let y = 0; y < TOOTH_TILE; y++) {
    for (let x = 0; x < TOOTH_TILE; x++) {
      const gx = x / TOOTH_CELL
      const gy = y / TOOTH_CELL
      const i = Math.floor(gx)
      const j = Math.floor(gy)
      const fx = gx - i
      const fy = gy - j
      const top = lattice(i, j) + (lattice(i + 1, j) - lattice(i, j)) * fx
      const bottom = lattice(i, j + 1) + (lattice(i + 1, j + 1) - lattice(i, j + 1)) * fx
      const v = (top + (bottom - top) * fy) * 0.8 + hash2(x * 7411 + 9, y) * 0.2
      const alpha = clamp((v - 0.42) / 0.16, 0, 1)
      image.data[(y * TOOTH_TILE + x) * 4 + 3] = Math.round(alpha * 255)
    }
  }
  context.putImageData(image, 0, 0)
  return tooth
}

/** Where a branch leaves its parent. */
interface Join {
  /** Half the parent's width there, plate px. */
  readonly parentHalf: number
  /** How far along the branch it is still inside the parent's body. */
  readonly inside: number
  /** The parent's tone. */
  readonly density: number
  readonly cool: number
}

interface Brush {
  readonly body: Path2D
  /** Overall direction of the stroke, degrees. */
  readonly angle: number
  /** Widest point, plate pixels. */
  readonly width: number
  readonly density: number
  readonly cool: number
  /** The tone gradient from the parent's tone, in plate pixels. */
  readonly join: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly density: number; readonly cool: number } | undefined
  /** Bark, rim and dry brush, for strokes wide enough to carry them. */
  readonly marks: Marks | undefined
}

interface StrokeOptions {
  readonly isRoot: boolean
  /** May have bark (if wide enough). */
  readonly isTextured: boolean
  /** A twig seen close up: shading, rim and lenticels, but no fissures. */
  readonly isModelled: boolean
  readonly density: number
  readonly cool: number
  /** Length of the whole stroke, plate pixels: the base for "how far
   *  along", which dries the brush towards the end. */
  readonly total: number
  /** Set when the stroke starts where the chain leaves its parent. */
  readonly join: Join | undefined
  /** Start in the parent's tone (see `join`). */
  readonly joinTone: boolean
  /** Add the outline to this path rather than to one of its own. */
  readonly body: Path2D | undefined
}

/** What the camera allows: see `paintInk`. */
interface Level {
  readonly detail: number
  readonly texture: number
  readonly zoom: number
  readonly octaves: ReadonlyArray<number>
  readonly edgeFine: number
  readonly lenticels: number
  readonly ridges: number
  readonly rim: number
}

const UNUSED = typeof Path2D === 'function' ? new Path2D() : (undefined as unknown as Path2D)

interface Marks {
  readonly body: Path2D
  readonly rim: Path2D
  readonly shadeBroad: Path2D
  readonly shadeCore: Path2D
  readonly light: Path2D
  readonly lightCore: Path2D
  readonly lightInner: Path2D
  readonly fissures: Array<Path2D | undefined>
  ridges: Path2D | undefined
  lenticels: Path2D | undefined
  dry: Path2D | undefined
}

/**
 * Turn the plate-resolution samples in `xs/ys/ws/ss[0..n)` into a brush
 * outline and its marks, in plate pixels.
 *
 * The stroke's shape (eased widths, root flare, collar, relaxed centreline)
 * is worked out on the plate samples, exactly as on the fitted plate. Then
 * only the stretches on screen are kept, as separate pieces whose cut ends
 * lie off screen, and each is resampled so that, zoomed in, the outline
 * still has a point every SAMPLE_STEP on screen. Edge noise and bark are
 * evaluated on those samples by their distance along the stroke in plate
 * units, so the brushwork is the same marks at every zoom, only drawn with
 * more points. Returns undefined when nothing is on screen.
 */
const brushStroke = (
  chain: number,
  n: number,
  maxWidth: number,
  frame: Frame,
  budget: { fine: number },
  level: Level,
  options: StrokeOptions,
): Brush | undefined => {
  const { dpr, view } = frame
  const { isRoot, join } = options
  const s0 = ss[0] ?? 0
  const length = (ss[n - 1] ?? 0) - s0
  const step = length / Math.max(1, n - 1)

  // Widths change at forks; a brush eases between them over about a
  // stroke-width of travel instead of stepping.
  const reach = (maxWidth * 1.3) / Math.max(step, 1e-6)
  const radius = Math.min(n >> 1, Math.round(reach / 2))
  if (radius > 0) {
    // Two running-box passes approximate a Gaussian in O(n) per pass.
    boxBlur(ws, scratch, n, radius)
    boxBlur(ws, scratch, n, radius)
  }

  // Where the trunk meets the ground it flares out a little.
  if (isRoot) {
    const flare = Math.min(length * 0.1, maxWidth * 2)
    for (let i = 0; i < n; i++) {
      const s = (ss[i] ?? 0) - s0
      if (s >= flare) break
      const t = 1 - s / flare
      ws[i] = (ws[i] ?? 0) * (1 + 0.32 * t * t)
    }
  }

  // Where a branch leaves its parent the wood swells into a collar, so the
  // two meet in a fillet rather than at a corner.
  if (join !== undefined) {
    const w0 = ws[0] ?? 0
    const collar = clamp(join.parentHalf / Math.max(w0, 1e-6) - 0.5, 0, 1) * 0.42
    const span = join.inside + w0 * 0.9
    if (collar > 0) {
      for (let i = 0; i < n; i++) {
        const s = (ss[i] ?? 0) - s0
        if (s >= span) break
        const t = 1 - s / span
        ws[i] = (ws[i] ?? 0) * (1 + collar * t * t)
      }
    }
  }

  // Wide strokes don't follow every kink of the turtle's path: relax the
  // centreline a little, keeping both ends where they are.
  const passes = Math.min(6, Math.floor(maxWidth / (3 * dpr)))
  for (let pass = 0; pass < passes; pass++) {
    let px = xs[0] ?? 0
    let py = ys[0] ?? 0
    for (let i = 1; i < n - 1; i++) {
      const cx = xs[i] ?? 0
      const cy = ys[i] ?? 0
      xs[i] = (px + 2 * cx + (xs[i + 1] ?? 0)) / 4
      ys[i] = (py + 2 * cy + (ys[i + 1] ?? 0)) / 4
      px = cx
      py = cy
    }
  }

  const seed = chain * 4 + 1
  const cssWidth = maxWidth / dpr
  const isTextured = options.isTextured || options.isModelled
  // Strokes without marks share a scratch path for them: nothing is drawn
  // into it (see `piece`), and it saves allocating six per twig.
  const own = () => (isTextured ? new Path2D() : UNUSED)
  const marks: Marks = {
    body: options.body ?? new Path2D(),
    rim: own(),
    shadeBroad: own(),
    shadeCore: own(),
    light: own(),
    lightCore: own(),
    lightInner: own(),
    fissures: [],
    ridges: undefined,
    lenticels: undefined,
    dry: undefined,
  }
  // A trunk's bark starts at its foot; a branch's where it leaves its parent.
  const textureStart = join !== undefined ? s0 + join.inside : Number.NEGATIVE_INFINITY

  // Zoomed in, a plate sample spacing spans `detail` times as many pixels:
  // resample to keep the outline smooth (within budget).
  let upsample = Math.max(1, Math.min(64, Math.ceil(level.detail - 1e-6)))
  // A twig is straight between the turtle's turns; its outline only needs
  // the points its width can show.
  if (!options.isTextured) upsample = Math.min(upsample, Math.max(1, Math.ceil((maxWidth * level.zoom) / (6 * dpr))))
  let pieces = 0
  let i = 0
  while (i < n - 1) {
    while (i < n - 1 && !isIntervalInView(view, i, dpr)) i++
    if (i >= n - 1) break
    let j = i
    while (j < n - 1 && isIntervalInView(view, j, dpr)) j++
    if (upsample > 1 && budget.fine < (j - i) * upsample) upsample = 1
    const m = resample(i, j, upsample)
    budget.fine -= m
    piece(marks, m, {
      seed,
      cssWidth,
      dpr,
      isRoot,
      isStart: i === 0,
      isEnd: j === n - 1,
      isTextured,
      isTwig: options.isModelled,
      total: options.total,
      s0,
      textureStart,
      level,
    })
    pieces++
    i = j
  }
  if (pieces === 0) return undefined

  const angle = (Math.atan2((ys[n - 1] ?? 0) - (ys[0] ?? 0), (xs[n - 1] ?? 0) - (xs[0] ?? 0)) * 180) / Math.PI
  let joinGradient: Brush['join']
  if (join !== undefined && options.joinTone) {
    // Along the branch's first stretch, from inside the parent to a couple
    // of widths out.
    const reachOut = join.inside + (ws[0] ?? 0) * 2.5
    let k = 1
    while (k < n - 1 && (ss[k] ?? 0) - s0 < reachOut) k++
    const x0 = xs[0] ?? 0
    const y0 = ys[0] ?? 0
    const dx = (xs[k] ?? x0) - x0
    const dy = (ys[k] ?? y0) - y0
    const d = Math.hypot(dx, dy) || 1
    joinGradient = {
      x0,
      y0,
      x1: x0 + (dx / d) * reachOut,
      y1: y0 + (dy / d) * reachOut,
      density: join.density,
      cool: join.cool,
    }
  }
  return {
    body: marks.body,
    angle,
    width: maxWidth,
    density: options.density,
    cool: options.cool,
    join: joinGradient,
    marks: isTextured || options.isModelled ? marks : undefined,
  }
}

/** Whether the stretch between plate samples `i` and `i + 1`, with room
 *  for its width, rim and bleed, reaches the screen. */
const isIntervalInView = (view: Frame['view'], i: number, dpr: number): boolean => {
  const w = Math.max(ws[i] ?? 0, ws[i + 1] ?? 0)
  return isInView(view, xs[i] ?? 0, ys[i] ?? 0, xs[i + 1] ?? 0, ys[i + 1] ?? 0, w * 1.3 + 4 * dpr)
}

/** Fill the `f*` buffers with plate samples `i..j`, `upsample` points per
 *  interval: Catmull-Rom through the centreline, linear widths and
 *  distances. Returns the number of samples. */
const resample = (i: number, j: number, upsample: number): number => {
  const m = (j - i) * upsample + 1
  ensureFine(m)
  let o = 0
  for (let k = i; k < j; k++) {
    const k0 = k > 0 ? k - 1 : k
    const k3 = k + 2 <= j ? k + 2 : k + 1
    const x0 = xs[k0] ?? 0
    const x1 = xs[k] ?? 0
    const x2 = xs[k + 1] ?? 0
    const x3 = xs[k3] ?? 0
    const y0 = ys[k0] ?? 0
    const y1 = ys[k] ?? 0
    const y2 = ys[k + 1] ?? 0
    const y3 = ys[k3] ?? 0
    const w1 = ws[k] ?? 0
    const w2 = ws[k + 1] ?? 0
    const s1 = ss[k] ?? 0
    const s2 = ss[k + 1] ?? 0
    for (let p = 0; p < upsample; p++) {
      const t = p / upsample
      const t2 = t * t
      const t3 = t2 * t
      fx[o] = 0.5 * (2 * x1 + (x2 - x0) * t + (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 + (3 * x1 - x0 - 3 * x2 + x3) * t3)
      fy[o] = 0.5 * (2 * y1 + (y2 - y0) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (3 * y1 - y0 - 3 * y2 + y3) * t3)
      fw[o] = w1 + (w2 - w1) * t
      fs[o] = s1 + (s2 - s1) * t
      o++
    }
  }
  fx[o] = xs[j] ?? 0
  fy[o] = ys[j] ?? 0
  fw[o] = ws[j] ?? 0
  fs[o] = ss[j] ?? 0
  return m
}

interface PieceOptions {
  readonly seed: number
  /** The stroke's widest point, CSS px of the fitted plate. */
  readonly cssWidth: number
  readonly dpr: number
  readonly isRoot: boolean
  /** The piece begins where the stroke does (and not at an off-screen cut). */
  readonly isStart: boolean
  readonly isEnd: boolean
  readonly isTextured: boolean
  /** Modelled but not barked: a twig seen close up. */
  readonly isTwig: boolean
  readonly total: number
  /** Distance along the chain where the stroke starts, and where its
   *  bark starts (where it comes out of its parent). Plate px. */
  readonly s0: number
  readonly textureStart: number
  readonly level: Level
}

/** The point at across position `u` of sample `i` (see core/shading.ts). */
const acrossX = (i: number, u: number) => (fx[i] ?? 0) - (ty[i] ?? 0) * u * (u > 0 ? hl[i] ?? 0 : hr[i] ?? 0)
const acrossY = (i: number, u: number) => (fy[i] ?? 0) + (tx[i] ?? 0) * u * (u > 0 ? hl[i] ?? 0 : hr[i] ?? 0)

/** A band across the stroke from `bu[i]` to `outer` (across positions)
 *  over samples `i0..i1`, as one filled subpath. */
const band = (path: Path2D, i0: number, i1: number, outer: number) => {
  if (i1 - i0 < 1) return
  path.moveTo(acrossX(i0, outer), acrossY(i0, outer))
  for (let i = i0 + 1; i <= i1; i++) path.lineTo(acrossX(i, outer), acrossY(i, outer))
  for (let i = i1; i >= i0; i--) {
    const u = bu[i] ?? outer
    path.lineTo(acrossX(i, u), acrossY(i, u))
  }
}

/** Outline and marks for the `m` samples in the `f*` buffers, added to
 *  `marks`. */
const piece = (marks: Marks, m: number, options: PieceOptions) => {
  const { seed, cssWidth, dpr, isRoot, isStart, isTextured, total, level } = options
  const css = 1 / dpr

  // Edge offsets: each side wanders on its own noise curve, the brush
  // pressure swells and eases along the stroke, and, close up, old bark
  // breaks the silhouette with a fine roughness.
  const edgeFine = !isTextured
    ? 0
    : options.isTwig
      ? level.edgeFine * Math.min(0.3 * dpr, cssWidth * dpr * 0.09)
      : level.edgeFine * 0.42 * dpr * smoothstep(5, 18, cssWidth)
  pressureCurve.reset(seed)
  leftCurve.reset(seed + 1)
  rightCurve.reset(seed + 2)
  leftFine.reset(seed + 21)
  rightFine.reset(seed + 22)
  for (let i = 0; i < m; i++) {
    const a = i > 0 ? i - 1 : 0
    const b = i < m - 1 ? i + 1 : m - 1
    let dx = (fx[b] ?? 0) - (fx[a] ?? 0)
    let dy = (fy[b] ?? 0) - (fy[a] ?? 0)
    const tl = Math.hypot(dx, dy) || 1
    dx /= tl
    dy /= tl
    tx[i] = dx
    ty[i] = dy
    lit[i] = litSide(dx, dy)
    const s = (fs[i] ?? 0) * css
    const pressure = 1 + 0.08 * pressureCurve.at(s / 70)
    const half = (fw[i] ?? 0) * 0.5 * pressure
    const roughness = Math.min(0.14, 0.55 / Math.sqrt(half * css + 0.5))
    let left = half * (1 + roughness * leftCurve.at(s / 9)) + 0.1 * dpr
    let right = half * (1 + roughness * rightCurve.at(s / 9)) + 0.1 * dpr
    if (edgeFine > 0) {
      left += edgeFine * leftFine.at(s / 1.2)
      right += edgeFine * rightFine.at(s / 1.2)
    }
    hl[i] = left
    hr[i] = right
    lx[i] = (fx[i] ?? 0) - dy * left
    ly[i] = (fy[i] ?? 0) + dx * left
    rx[i] = (fx[i] ?? 0) + dy * right
    ry[i] = (fy[i] ?? 0) - dx * right
  }

  const { body } = marks
  body.moveTo(lx[0] ?? 0, ly[0] ?? 0)
  for (let i = 1; i < m; i++) body.lineTo(lx[i] ?? 0, ly[i] ?? 0)
  roundCap(body, m - 1, m - 2, 1)
  for (let i = m - 1; i >= 0; i--) body.lineTo(rx[i] ?? 0, ry[i] ?? 0)
  roundCap(body, 0, 1, -1, isRoot && isStart ? 0.05 : 1)

  if (!isTextured) return

  // Bark starts where the branch comes out of its parent, easing in.
  const widthCss = (i: number) => (fw[i] ?? 0) * css
  let first = m
  for (let i = 0; i < m; i++) {
    const start = options.textureStart
    const t = start === Number.NEGATIVE_INFINITY ? 1 : smoothstep(start, start + (fw[i] ?? 0) * 0.45, fs[i] ?? 0)
    tr[i] = options.isTwig ? t : t * smoothstep(1.6, BARK_MIN_CSS + 0.6, widthCss(i))
    if (first === m && (tr[i] ?? 0) > 0) first = i > 0 ? i - 1 : 0
  }
  if (first >= m - 1) return

  // Wet rim, just inside both long edges, never across the caps.
  const rimInset = (half: number) => Math.min(level.rim * 0.5 + 0.05 * dpr, half * 0.3)
  let drawing = false
  for (let i = first; i < m; i++) {
    if ((tr[i] ?? 0) < 0.5) {
      drawing = false
      continue
    }
    const left = (hl[i] ?? 0) - rimInset(hl[i] ?? 0)
    const x = (fx[i] ?? 0) - (ty[i] ?? 0) * left
    const y = (fy[i] ?? 0) + (tx[i] ?? 0) * left
    if (drawing) marks.rim.lineTo(x, y)
    else marks.rim.moveTo(x, y)
    drawing = true
  }
  drawing = false
  for (let i = first; i < m; i++) {
    if ((tr[i] ?? 0) < 0.5) {
      drawing = false
      continue
    }
    const right = (hr[i] ?? 0) - rimInset(hr[i] ?? 0)
    const x = (fx[i] ?? 0) + (ty[i] ?? 0) * right
    const y = (fy[i] ?? 0) - (tx[i] ?? 0) * right
    if (drawing) marks.rim.lineTo(x, y)
    else marks.rim.moveTo(x, y)
    drawing = true
  }

  // Volume. On each side, a half-shadow reaching in from the edge and a
  // core shadow a little inside it (leaving the edge to reflected light),
  // as wide as that side is turned from the light; on the lit side, ink
  // lifted short of the edge. Their inner borders wander like brush hairs.
  // One wandering curve per side (two octaves: the band edges are brush
  // hairs, not ruled lines), shared by all its bands at different depths.
  for (const side of [1, -1] as const) {
    bandBroad.reset(seed + 31 + side)
    bandFine.reset(seed + 37 + side)
    for (let i = first; i < m; i++) {
      const s = (fs[i] ?? 0) * css
      zs[i] = bandBroad.at(s / 15) * 0.7 + bandFine.at(s / 5) * 0.3
      scratchAway[i] = smoothstep(0.05, 0.6, -side * (lit[i] ?? 0)) * (tr[i] ?? 0)
    }
    const shadeBand = (path: Path2D, outer: number, depth: number, wander: number, ramp: Float64Array) => {
      for (let i = first; i < m; i++) bu[i] = side * (outer - depth * (ramp[i] ?? 0) * (1 + wander * (zs[i] ?? 0)))
      band(path, first, m - 1, side * outer)
    }
    shadeBand(marks.shadeBroad, 1, 1.15, 0.22, scratchAway)
    shadeBand(marks.shadeCore, 0.86, 0.58, 0.3, scratchAway)
    if (options.isTwig) continue
    for (let i = first; i < m; i++) scratchAway[i] = smoothstep(0.05, 0.6, side * (lit[i] ?? 0)) * (tr[i] ?? 0)
    shadeBand(marks.light, 0.9, 0.75, 0.3, scratchAway)
    shadeBand(marks.lightCore, 0.8, 0.42, -0.35, scratchAway)
    shadeBand(marks.lightInner, 0.92, 1.05, 0.4, scratchAway)
  }

  if (options.isTwig) {
    lenticels(marks, m, first, options)
    return
  }
  fissures(marks, m, first, options)
  if (level.lenticels > 0) lenticels(marks, m, first, options)
  dryBrush(marks, m, first, options)
}

/** Bark fissures: tracks running with the stroke, weaving, breaking and
 *  rejoining. Each octave is finer than the last and only drawn once the
 *  zoom can show it. Fissures are filled, tapered at both ends, and wider
 *  in the shade, so the bark itself models the branch; old (wide) wood is
 *  furrowed, young wood nearly smooth. A lighter lip on each fissure's lit
 *  side gives the relief. */
const fissures = (marks: Marks, m: number, first: number, options: PieceOptions) => {
  const { seed, cssWidth, dpr, level } = options
  const css = 1 / dpr
  // How much each sample's bark is furrowed (wide, old wood is).
  for (let i = first; i < m; i++) zs[i] = smoothstep(4, 16, (fw[i] ?? 0) * css)
  for (let k = 0; k < OCTAVES.length; k++) {
    if ((level.octaves[k] ?? 0) <= 0) continue
    const octave = OCTAVES[k] as (typeof OCTAVES)[number]
    const tracks = Math.min(octave.maxTracks, Math.floor((cssWidth * 0.95) / octave.spacing))
    if (tracks < 1) continue
    const path = (marks.fissures[k] ??= new Path2D())
    const ridge = k < 2 && level.ridges > 0 ? (marks.ridges ??= new Path2D()) : undefined
    const weave = (octave.spacing / (cssWidth * 0.5)) * 0.55
    // Samples are a few screen px apart; a fissure needs about one per
    // fifth of its dash length on screen, so skip the rest.
    const stride = Math.max(1, Math.floor(((octave.dash / 5) * level.detail * 2) / SAMPLE_STEP))
    for (let j = 0; j < tracks; j++) {
      const tseed = (seed * 131 + k * 7919 + j * 31) | 0
      // Tracks drop out as the stroke narrows, the rarest first.
      const rank = hash2(tseed, 1) * 0.9 * cssWidth
      const u0 = -0.9 + (1.8 * (j + 0.5 + (hash2(tseed, 2) - 0.5) * 0.8)) / tracks
      let run = 0
      trackRank.reset(tseed + 7)
      trackDash.reset(tseed + 5)
      trackWeave.reset(tseed + 3)
      for (let i = first; i < m; i = i === m - 1 ? m : Math.min(i + stride, m - 1)) {
        const t = tr[i] ?? 0
        let width = 0
        const s = (fs[i] ?? 0) * css
        // Where the stroke narrows past a fork, tracks end one by one, not
        // all on the same line.
        if (t > 0.05 && (fw[i] ?? 0) * css > rank * (1 + 0.18 * trackRank.at(s / 23))) {
          // The dash first: a fissure is off over most of its track, and
          // then nothing else needs working out.
          const nz = trackDash.at(s / octave.dash) * 0.5 + 0.5
          const furrow = zs[i] ?? 0
          const presence = k === 0 ? furrow : 0.4 + 0.6 * furrow
          // Shade only raises the chance (up to 0.4 × presence).
          if (nz > 1 - presence * 0.82) {
            const u = clamp(u0 + weave * trackWeave.at(s / octave.weave), -0.95, 0.95)
            const l = lit[i] ?? 0
            const sh = shade(u, l)
            const e = (nz - (1 - presence * (0.42 + 0.4 * sh))) / 0.16
            if (e > 0) {
              width = octave.width * dpr * Math.min(1, e) ** 0.6 * (0.45 + 1.0 * sh) * t * (k === 0 ? 0.55 + 0.45 * furrow : 1)
              qx[run] = acrossX(i, u)
              qy[run] = acrossY(i, u)
              qnx[run] = -(ty[i] ?? 0)
              qny[run] = tx[i] ?? 0
              qw[run] = width
              ql[run] = l
              run++
            }
          }
        }
        if (width === 0 && run > 0) {
          flushFissure(path, ridge, run)
          run = 0
        }
      }
      if (run > 0) flushFissure(path, ridge, run)
    }
  }
}

/** One fissure from the run in the `q*` buffers: a tapered ribbon, and its
 *  lit lip. */
const flushFissure = (path: Path2D, ridge: Path2D | undefined, run: number) => {
  if (run < 2) return
  path.moveTo((qx[0] ?? 0) + (qnx[0] ?? 0) * (qw[0] ?? 0) * 0.5, (qy[0] ?? 0) + (qny[0] ?? 0) * (qw[0] ?? 0) * 0.5)
  for (let r = 1; r < run; r++) {
    const h = (qw[r] ?? 0) * 0.5
    path.lineTo((qx[r] ?? 0) + (qnx[r] ?? 0) * h, (qy[r] ?? 0) + (qny[r] ?? 0) * h)
  }
  for (let r = run - 1; r >= 0; r--) {
    const h = (qw[r] ?? 0) * 0.5
    path.lineTo((qx[r] ?? 0) - (qnx[r] ?? 0) * h, (qy[r] ?? 0) - (qny[r] ?? 0) * h)
  }
  if (ridge === undefined) return
  // The lip on the side towards the light: a thinner ribbon just beside it.
  const offset = (r: number) => Math.sign(ql[r] ?? 0) * (qw[r] ?? 0) * 1.05
  const half = (r: number) => (qw[r] ?? 0) * 0.3 * Math.min(1, Math.abs(ql[r] ?? 0) * 2.5)
  ridge.moveTo((qx[0] ?? 0) + (qnx[0] ?? 0) * (offset(0) + half(0)), (qy[0] ?? 0) + (qny[0] ?? 0) * (offset(0) + half(0)))
  for (let r = 1; r < run; r++) {
    const d = offset(r) + half(r)
    ridge.lineTo((qx[r] ?? 0) + (qnx[r] ?? 0) * d, (qy[r] ?? 0) + (qny[r] ?? 0) * d)
  }
  for (let r = run - 1; r >= 0; r--) {
    const d = offset(r) - half(r)
    ridge.lineTo((qx[r] ?? 0) + (qnx[r] ?? 0) * d, (qy[r] ?? 0) + (qny[r] ?? 0) * d)
  }
}

/** Lenticels: the small lens-shaped breathing pores across young bark
 *  (cherry, plum, birch), fading out as the bark ages into furrows. */
const lenticels = (marks: Marks, m: number, first: number, options: PieceOptions) => {
  const { seed, cssWidth, dpr } = options
  const css = 1 / dpr
  const youth = 1 - smoothstep(4, 9, cssWidth)
  if (youth <= 0.05) return
  const path = (marks.lenticels ??= new Path2D())
  let count = 0
  let next = ((fs[first] ?? 0) * css) + 2 + hash2(seed + 41, 0) * 4
  for (let i = first; i < m; i++) {
    const s = (fs[i] ?? 0) * css
    if (s < next) continue
    const h1 = hash2(seed + 43, count)
    const h2 = hash2(seed + 47, count)
    const h3 = hash2(seed + 53, count)
    count++
    next = s + (2.2 + h1 * 5) / youth
    if ((tr[i] ?? 0) < 0.6) continue
    const reach = 0.12 + h2 * 0.26
    const u = (h3 - 0.5) * 2 * (0.9 - reach)
    const half = ((hl[i] ?? 0) + (hr[i] ?? 0)) * 0.5
    if (half * options.level.zoom < 1.2 * dpr) continue
    const cx = acrossX(i, u)
    const cy = acrossY(i, u)
    // Across the branch, give or take a little.
    const tilt = (h1 - 0.5) * 0.5
    const nx = -(ty[i] ?? 0) + (tx[i] ?? 0) * tilt
    const ny = (tx[i] ?? 0) + (ty[i] ?? 0) * tilt
    const thick = (0.2 + h1 * 0.16) * dpr
    const ex = nx * half * reach
    const ey = ny * half * reach
    const ax = (tx[i] ?? 0) * thick
    const ay = (ty[i] ?? 0) * thick
    path.moveTo(cx + ex, cy + ey)
    path.quadraticCurveTo(cx + ax, cy + ay, cx - ex, cy - ey)
    path.quadraticCurveTo(cx - ax, cy - ay, cx + ex, cy + ey)
  }
}

/** Dry brush, "flying white": where the brush ran low, its hairs skip
 *  over the paper and leave thin white streaks. Gathered in dry patches
 *  along the stroke, on the lit side and towards its end; each streak is a
 *  hair's track, tapered at both ends, never a clean band down the middle
 *  (which reads as chrome). Like the fissures, finer hairs appear as the
 *  zoom can show them. */
const dryBrush = (marks: Marks, m: number, first: number, options: PieceOptions) => {
  const { seed, cssWidth, dpr, total, level } = options
  // Thin strokes carry their ink to the end.
  if (cssWidth < 8) return
  const css = 1 / dpr
  const zoneSeed = seed + 7
  let isDry = false
  dryZone.reset(zoneSeed)
  for (let i = first; i < m; i++) {
    const s = (fs[i] ?? 0) * css
    const along = total > 0 ? ((fs[i] ?? 0) - options.s0) / total : 0
    // Narrow strokes carry their ink better: they dry out less often.
    const z = dryZone.at(s / 48) * 0.5 + 0.5 + along * 0.32 - 0.58 - 1.4 / cssWidth
    zs[i] = z
    if (z > 0) isDry = true
  }
  if (!isDry) return
  const path = (marks.dry ??= new Path2D())
  // Hairs: a coarse set always, a fine set once there are pixels for it.
  const sets = [
    // Coarse hairs read at a glance; close up they give way to fine ones.
    { count: Math.min(14, Math.floor(cssWidth / 1.4)), width: Math.min(0.5, cssWidth * 0.045), dash: 9, strength: 1 - 0.75 * (level.octaves[1] ?? 0) },
    { count: Math.min(40, Math.floor(cssWidth / 0.5)), width: Math.min(0.2, cssWidth * 0.018), dash: 4, strength: level.octaves[1] ?? 0 },
  ]
  sets.forEach((set, k) => {
    if (set.strength <= 0) return
    for (let b = 0; b < set.count; b++) {
      const bseed = (seed * 31 + b * 7 + k * 1013) | 0
      // Mostly on the lit side's outer half, some further in.
      const reach = 0.36 + 0.6 * Math.sqrt(hash2(bseed, 1))
      let run = 0
      let lastSide = 0
      hairDash.reset(bseed + 3)
      for (let i = first; i < m; i++) {
        const l = lit[i] ?? 0
        const side = l > 0.15 ? 1 : l < -0.15 ? -1 : 0
        const intensity = ((zs[i] ?? 0) + (reach - 0.36) * 0.35) / 0.4
        const s = (fs[i] ?? 0) * css
        const e =
          side === 0 || (tr[i] ?? 0) < 0.6 || intensity <= 0
            ? -1
            : (Math.min(intensity, 0.8) - (hairDash.at(s / set.dash) * 0.5 + 0.5)) / 0.25
        if (side !== lastSide && run > 0) {
          flushFissure(path, undefined, run)
          run = 0
        }
        lastSide = side
        if (e > 0) {
          // Hairs are dragged straight along the stroke.
          const u = side * reach
          qx[run] = acrossX(i, u)
          qy[run] = acrossY(i, u)
          qnx[run] = -(ty[i] ?? 0)
          qny[run] = tx[i] ?? 0
          qw[run] = set.width * dpr * Math.min(1, e) ** 0.7 * (0.6 + 0.8 * hash2(bseed, 2)) * set.strength
          run++
        } else if (run > 0) {
          flushFissure(path, undefined, run)
          run = 0
        }
      }
      if (run > 0) flushFissure(path, undefined, run)
    }
  })
}

/** Running mean of `values[0..n)` over a window of ±`radius` samples
 *  (clamped at the ends, which keep their values), using `scratch`. */
const boxBlur = (values: Float64Array, scratch: Float64Array, n: number, radius: number) => {
  let sum = 0
  for (let k = -radius; k <= radius; k++) sum += values[clampIndex(k, n)] ?? 0
  const span = 2 * radius + 1
  for (let i = 0; i < n; i++) {
    scratch[i] = sum / span
    sum += (values[clampIndex(i + radius + 1, n)] ?? 0) - (values[clampIndex(i - radius, n)] ?? 0)
  }
  for (let i = 1; i < n - 1; i++) values[i] = scratch[i] ?? 0
}

const clampIndex = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i)

/** A rounded end from the left edge at sample `i` to the right edge, bulging
 *  away from sample `j`. */
const roundCap = (path: Path2D, i: number, j: number, side: 1 | -1, bulge = 1) => {
  const x = fx[i] ?? 0
  const y = fy[i] ?? 0
  let dx = x - (fx[j] ?? x)
  let dy = y - (fy[j] ?? y)
  const tl = Math.hypot(dx, dy) || 1
  dx /= tl
  dy /= tl
  const r = (((hl[i] ?? 0) + (hr[i] ?? 0)) / 2) * bulge
  // Coming from the left edge at the end, or from the right edge at the start.
  const fromX = side === 1 ? lx[i] ?? x : rx[i] ?? x
  const fromY = side === 1 ? ly[i] ?? y : ry[i] ?? y
  const toX = side === 1 ? rx[i] ?? x : lx[i] ?? x
  const toY = side === 1 ? ry[i] ?? y : ly[i] ?? y
  const tipX = x + dx * r
  const tipY = y + dy * r
  path.quadraticCurveTo(fromX + dx * r, fromY + dy * r, tipX, tipY)
  path.quadraticCurveTo(toX + dx * r, toY + dy * r, toX, toY)
}
