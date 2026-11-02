/**
 * The pure arithmetic behind the twig layer, shared by the Canvas2D painter
 * (inkBrush.ts, linePen.ts) and the WebGL2 one (gpuInk.ts), so both make
 * the same decisions: which segments are twigs, in which tone and width
 * class each is drawn, and how strong each class's ink is.
 *
 * The Canvas2D painter batches twigs into one path per (tone class, width
 * class) and strokes each path once: inside a class, overlapping twigs are
 * a union (they don't pool), and the classes are laid over each other in
 * order (they do). The GPU painter reproduces exactly that with one
 * coverage channel per class ("slot"): coverage is combined by `max` inside
 * a slot and the slots are composited in the same order (see gpuInk.ts).
 *
 * No DOM here: unit-tested in twigPlan.test.ts.
 */

/** Width classes for the polyline strokes, in device pixels on screen. */
export const WIDTH_CLASS = 0.2
/** Twig tone classes, by how far back the twig sits. */
export const TONE_CLASSES = 4
/** Pen weights of the Line style, CSS px (linePen.ts). */
export const PEN_WEIGHTS = [0.7, 1, 1.5, 2.2] as const

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** 0 for a hairline (0.5 CSS px), 1 for a limb (13 CSS px and up), log scale. */
export const widthScaleOf = (cssWidth: number): number => {
  const v = Math.log2(Math.max(cssWidth, 0.5) / 0.5) / 4.7
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Ink density for a stroke `cssWidth` CSS px wide on the fitted plate:
 *  hairlines are a pale grey, limbs nearly full. Continuous, so a chain
 *  that turns from brush into polyline keeps its tone. */
export const inkDensity = (cssWidth: number): number => 0.6 + 0.22 * widthScaleOf(cssWidth)

/** Aerial perspective: further from the trunk and further back, lighter. */
export const aerial = (order: number, recession: number): number => (1 - 0.05 * Math.min(order, 5)) * (1 - 0.42 * recession)

/** ... and cooler: the blue-grey of thinned ink. */
export const coolness = (order: number, recession: number): number => Math.min(0.8, recession * 0.75 + Math.min(order, 6) * 0.04)

/** The tone class of a chain that sits `recession` back. */
export const toneClassOf = (recession: number): number => Math.min(TONE_CLASSES - 1, Math.round(recession * (TONE_CLASSES - 1)))

/** The width class of a twig `width` plate px wide, at `zoom`. */
export const widthClassOf = (width: number, zoom: number, dpr: number): number => Math.max(1, Math.round((width * zoom) / (WIDTH_CLASS * dpr)))

/** The plate width a width class is stroked at. */
export const classWidth = (widthClass: number, zoom: number, dpr: number): number => (widthClass * WIDTH_CLASS * dpr) / zoom

/** Twig dilution: dense crowns are thinned to a wash of ink. */
export const twigAlpha = (widthClass: number, toneClass: number, zoom: number, dpr: number, dilution: number): number => {
  const recession = toneClass / (TONE_CLASSES - 1)
  return inkDensity(classWidth(widthClass, zoom, dpr) / dpr) * aerial(2, recession) * dilution
}

/**
 * A stroke-width function `w(r) = tip · r^exponent` read back from the
 * frame's `width` (frame.ts `widthScale`): the GPU needs the two numbers,
 * and a radius threshold is the same test on both sides.
 */
export interface WidthLaw {
  readonly tip: number
  readonly exponent: number
}

export const widthLawOf = (width: (radius: number) => number): WidthLaw => {
  const tip = width(1)
  const atE = width(Math.E)
  const exponent = tip > 0 && atE > 0 ? Math.log(atE / tip) : 0
  return { tip, exponent: Math.abs(exponent) < 1e-9 ? 0 : exponent }
}

/**
 * The smallest radius whose stroke is at least `width` wide, as a float32
 * (radii are float32, on the CPU and the GPU alike): `r >= radiusFor(w)`
 * is the test both painters use for `w(r) >= w`, so they always agree.
 */
export const radiusFor = (law: WidthLaw, width: number): number => {
  if (!Number.isFinite(width)) return Number.POSITIVE_INFINITY
  if (law.exponent === 0) return law.tip >= width ? 0 : Number.POSITIVE_INFINITY
  if (width <= 0) return 0
  return Math.fround((width / law.tip) ** (1 / law.exponent))
}

/**
 * Slots for the twig classes. Each tone class gets `perTone` slots; when
 * the frame's width classes don't fit, neighbouring classes share a slot
 * (they then form one union, a difference no eye can see on twigs wide
 * enough to have so many classes).
 */
export interface SlotPlan {
  readonly classMin: number
  readonly classMax: number
  readonly perTone: number
  /** Width classes per slot (1 when every class has its own). */
  readonly binWidth: number
  readonly slots: number
}

export const planSlots = (classMin: number, classMax: number, perTone: number): SlotPlan => {
  const lo = Math.max(1, Math.min(classMin, classMax))
  const hi = Math.max(lo, classMax)
  const span = hi - lo + 1
  const binWidth = Math.max(1, Math.ceil(span / perTone))
  const used = Math.ceil(span / binWidth)
  return { classMin: lo, classMax: hi, perTone: used, binWidth, slots: used * TONE_CLASSES }
}

/** The slot of a twig of width class `widthClass` in tone class `toneClass`. */
export const slotOf = (plan: SlotPlan, toneClass: number, widthClass: number): number => {
  const bin = Math.floor((widthClass - plan.classMin) / plan.binWidth)
  return toneClass * plan.perTone + (bin < 0 ? 0 : bin >= plan.perTone ? plan.perTone - 1 : bin)
}

/** The width class a slot stands for (the middle of its bin), for its alpha. */
export const slotClass = (plan: SlotPlan, slot: number): number => {
  const bin = slot % plan.perTone
  const first = plan.classMin + bin * plan.binWidth
  const last = Math.min(plan.classMax, first + plan.binWidth - 1)
  return Math.round((first + last) / 2)
}

/**
 * Pack the static per-segment data the GPU needs beyond the geometry: each
 * segment's position in chain order (the order the painter walks, which the
 * sample budgets are spent in), whether it starts its chain (it then gets a
 * round cap at its start; inside a chain, pieces meet end to end) and its
 * chain's tone class, as `position << 3 | isChainStart << 2 | toneClass`.
 */
export const packSegmentMeta = (
  count: number,
  chainSegments: Int32Array,
  chainStart: Int32Array,
  chainCount: number,
  chainRecession: Float32Array,
  out: Uint32Array = new Uint32Array(count),
): Uint32Array => {
  for (let c = 0; c < chainCount; c++) {
    const tone = toneClassOf(chainRecession[c] ?? 0)
    const begin = chainStart[c] ?? 0
    const end = chainStart[c + 1] ?? 0
    for (let k = begin; k < end; k++) {
      const segment = chainSegments[k] ?? 0
      if (segment < count) out[segment] = (k * 8 + (k === begin ? 4 : 0) + tone) >>> 0
    }
  }
  return out
}

export const unpackSegmentMeta = (word: number): { readonly position: number; readonly isChainStart: boolean; readonly toneClass: number } => ({
  position: word >>> 3,
  isChainStart: (word & 4) !== 0,
  toneClass: word & 3,
})

/** The highest chain position `packSegmentMeta` can hold. */
export const MAX_CHAIN_POSITION = 2 ** 29 - 1

/**
 * For each segment, the unit direction of the piece before it in its chain
 * (its parent, unless it starts the chain) and of the piece after it (its
 * main child), as `prevX, prevY, nextX, nextY` in generator units; zeros
 * where there is none. The GPU splits each joint along the bisector of the
 * two directions, which is exactly where the union of the two round-ended
 * pieces changes hands: every pixel is painted by one of them, never both.
 */
export const jointDirections = (
  coords: Float32Array,
  parent: Int32Array,
  mainChild: Int32Array,
  count: number,
  out: Float32Array = new Float32Array(count * 4),
): Float32Array => {
  const dirs = new Float32Array(count * 2)
  for (let i = 0; i < count; i++) {
    const o = i * 4
    const dx = (coords[o + 2] ?? 0) - (coords[o] ?? 0)
    const dy = (coords[o + 3] ?? 0) - (coords[o + 1] ?? 0)
    const length = Math.hypot(dx, dy)
    if (length > 0) {
      dirs[i * 2] = dx / length
      dirs[i * 2 + 1] = dy / length
    }
  }
  for (let i = 0; i < count; i++) {
    const p = parent[i] ?? -1
    const o = i * 4
    if (p >= 0 && mainChild[p] === i) {
      out[o] = dirs[p * 2] ?? 0
      out[o + 1] = dirs[p * 2 + 1] ?? 0
    } else {
      out[o] = 0
      out[o + 1] = 0
    }
    const next = mainChild[i] ?? -1
    out[o + 2] = next >= 0 ? dirs[next * 2] ?? 0 : 0
    out[o + 3] = next >= 0 ? dirs[next * 2 + 1] ?? 0 : 0
  }
  return out
}

/** Each segment's predecessor in its chain (its parent, when the segment
 *  continues the parent's stroke), or -1 where a chain starts. */
export const chainPrevious = (parent: Int32Array, mainChild: Int32Array, count: number, out: Int32Array = new Int32Array(count)): Int32Array => {
  for (let i = 0; i < count; i++) {
    const p = parent[i] ?? -1
    out[i] = p >= 0 && mainChild[p] === i ? p : -1
  }
  return out
}

/** Radii as a texture: `RADIUS_ROW` texels a row, the last row padded. */
export const RADIUS_ROW = 4096

export const radiusTexels = (radius: Float32Array, count: number, out?: Float32Array): Float32Array => {
  const rows = Math.max(1, Math.ceil(count / RADIUS_ROW))
  const texels = out !== undefined && out.length === rows * RADIUS_ROW ? out : new Float32Array(rows * RADIUS_ROW)
  texels.set(radius.subarray(0, count))
  return texels
}

/** The arrival of each segment's continuation (its main child), or +∞ for
 *  a tip: the GPU gives a piece a round end cap only where its chain ends
 *  on screen. */
export const nextArrivals = (arrival: Float32Array, mainChild: Int32Array, count: number, out: Float32Array = new Float32Array(count)): Float32Array => {
  for (let i = 0; i < count; i++) {
    const next = mainChild[i] ?? -1
    out[i] = next >= 0 ? arrival[next] ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
  }
  return out
}
