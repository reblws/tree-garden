import type { Segments2D } from './geometry'

/**
 * Topology of a branching structure, computed from the `parent` links in
 * Segments2D. Pure and allocation-light: everything is a typed array indexed
 * by segment, and every pass is a single loop, because trees can have
 * hundreds of thousands of segments.
 *
 * Two ideas live here:
 *
 * - **Pipe model** (Shinozaki et al. 1964; "Leonardo's rule"): a branch is a
 *   bundle of pipes, one per leaf it feeds. At every fork the parent's cross
 *   section relates to its children's by `r_parent^e = Σ r_child^e`, with
 *   `e = 2` for Leonardo's area-preserving rule and up to 3 for
 *   Murray's law. Here every tip has radius 1, so a segment's
 *   `weight = r^e` is just the number of tips it feeds (for `e` fixed), and
 *   `radius = weight^(1/e)`.
 *
 * - **Stroke chains**: an artist paints a tree as a few long tapering
 *   strokes, not as thousands of line pieces. Following each segment's
 *   heaviest child from the root yields the trunk as one chain; every
 *   lighter child starts a chain of its own. Every segment belongs to exactly
 *   one chain, so the chains partition the tree.
 */

/** Default fork exponent: between Leonardo (2) and Murray (3), close to what
 *  is measured on real trees. */
export const PIPE_EXPONENT = 2.3

/**
 * Accumulate pipe-model weights (`r^exponent`, tips = 1) into `out`, for the
 * segments with `index < visibleCount` that also satisfy `isVisible`
 * (others get 0). Relies on `parent[i] < i`, so one backwards pass suffices.
 * A visible segment's parent must be visible too, which holds for both
 * reveal orders the renderer uses (by index and by path distance).
 *
 * Returns the largest radius (`max weight^(1/exponent)`), 0 when nothing is
 * visible.
 */
export const pipeRadii = (
  geometry: Pick<Segments2D, 'count' | 'parent'>,
  exponent: number,
  out: Float32Array,
  visibleCount: number = geometry.count,
  isVisible?: (index: number) => boolean,
): number => {
  const { parent } = geometry
  const n = Math.min(visibleCount, geometry.count)
  out.fill(0, 0, geometry.count)
  // Pass 1: weights. Children come after their parents, so walking
  // backwards finishes each segment before its weight is handed up.
  for (let i = n - 1; i >= 0; i--) {
    if (isVisible !== undefined && !isVisible(i)) continue
    // A segment nobody grew from is a tip and feeds one pipe.
    const w = out[i] === 0 ? 1 : out[i] ?? 1
    out[i] = w
    const p = parent[i] ?? -1
    if (p >= 0) out[p] = (out[p] ?? 0) + w
  }
  // Pass 2: weight -> radius.
  const inv = 1 / exponent
  let maxRadius = 0
  for (let i = 0; i < n; i++) {
    const w = out[i] ?? 0
    if (w === 0) continue
    const r = w ** inv
    out[i] = r
    if (r > maxRadius) maxRadius = r
  }
  return maxRadius
}

export interface BranchTopology {
  /** Pipe-model radius per segment, in units of a tip's radius (tips = 1). */
  readonly radius: Float32Array
  readonly maxRadius: number
  /** Number of segments growing from each segment's end. 0 marks a tip. */
  readonly childCount: Uint32Array
  /** The child a stroke continues into: the heaviest, ties going to the
   *  straightest. -1 for tips. */
  readonly mainChild: Int32Array
  /** Segment indices grouped chain by chain, each chain in root-to-tip
   *  order. Chain `c` is `chainSegments[chainStart[c] .. chainStart[c + 1])`. */
  readonly chainSegments: Int32Array
  readonly chainStart: Int32Array
  readonly chainCount: number
  /** The chain each segment belongs to. */
  readonly chainOf: Int32Array
  /** The chain a chain branches off (the chain of its first segment's
   *  parent), or -1 for a chain that starts a stroke from nothing. */
  readonly chainParent: Int32Array
  /** Branch order of a chain: 0 for a root chain (the trunk), +1 for every
   *  fork it is off the trunk. Unlike the turtle's bracket depth, this
   *  follows the strokes: the trunk's own continuation stays order 0. */
  readonly chainOrder: Uint16Array
  /** How far back a chain sits, 0 (the front plane, with the trunk) to 1
   *  (the back of the crown). A 2D plant has no depth, so this is invented,
   *  deterministically: each lateral chain stays in its parent's plane or
   *  steps back by a hashed amount, and its own branches inherit that. The
   *  painter uses it for aerial perspective (lighter, cooler ink). */
  readonly chainRecession: Float32Array
}

/** Radii, forks and stroke chains for a finished structure. */
export const analyzeBranches = (geometry: Segments2D, exponent = PIPE_EXPONENT): BranchTopology => {
  const { count, parent, coords } = geometry
  const radius = new Float32Array(count)
  const maxRadius = pipeRadii(geometry, exponent, radius)

  const childCount = new Uint32Array(count)
  const mainChild = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const p = parent[i] ?? -1
    if (p < 0) continue
    childCount[p] = (childCount[p] ?? 0) + 1
    const current = mainChild[p] ?? -1
    if (current < 0 || isBetterContinuation(coords, radius, p, i, current)) {
      mainChild[p] = i
    }
  }

  // A chain starts at every segment that is not its parent's continuation.
  let chainCount = 0
  for (let i = 0; i < count; i++) {
    const p = parent[i] ?? -1
    if (p < 0 || mainChild[p] !== i) chainCount++
  }
  const chainStart = new Int32Array(chainCount + 1)
  const chainSegments = new Int32Array(count)
  let c = 0
  let k = 0
  for (let i = 0; i < count; i++) {
    const p = parent[i] ?? -1
    if (p >= 0 && mainChild[p] === i) continue
    chainStart[c++] = k
    for (let s = i; s >= 0; s = mainChild[s] ?? -1) {
      chainSegments[k++] = s
    }
  }
  chainStart[chainCount] = k

  const chainOf = new Int32Array(count)
  for (let ch = 0; ch < chainCount; ch++) {
    for (let j = chainStart[ch] ?? 0; j < (chainStart[ch + 1] ?? 0); j++) chainOf[chainSegments[j] ?? 0] = ch
  }
  // Chains are numbered by their first segment, and a parent segment always
  // comes before its children, so a chain's parent chain has a smaller
  // number: one forward pass settles order and recession.
  const chainParent = new Int32Array(chainCount)
  const chainOrder = new Uint16Array(chainCount)
  const chainRecession = new Float32Array(chainCount)
  for (let ch = 0; ch < chainCount; ch++) {
    const first = chainSegments[chainStart[ch] ?? 0] ?? 0
    const p = parent[first] ?? -1
    const up = p < 0 ? -1 : chainOf[p] ?? -1
    chainParent[ch] = up
    if (up < 0) continue
    chainOrder[ch] = (chainOrder[up] ?? 0) + 1
    chainRecession[ch] = Math.min(1, (chainRecession[up] ?? 0) + recessionStep(first))
  }

  return {
    radius,
    maxRadius,
    childCount,
    mainChild,
    chainSegments,
    chainStart,
    chainCount,
    chainOf,
    chainParent,
    chainOrder,
    chainRecession,
  }
}

/** How far a lateral branch starting at `segment` steps back from its
 *  parent's plane: about half stay level, a third step back a little, the
 *  rest further. Hashed, so the same plant always recedes the same way. */
export const recessionStep = (segment: number): number => {
  const h = hashUnit(segment)
  return h < 0.5 ? 0 : h < 0.85 ? 0.3 : 0.6
}

/** lowbias32 integer hash, mapped to [0, 1). */
const hashUnit = (n: number): number => {
  let x = (n ^ 0x2545f491) | 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** Should `candidate` rather than `current` continue `p`'s stroke? */
const isBetterContinuation = (
  coords: Float32Array,
  radius: Float32Array,
  p: number,
  candidate: number,
  current: number,
): boolean => {
  const rc = radius[candidate] ?? 0
  const rk = radius[current] ?? 0
  if (rc !== rk) return rc > rk
  return straightness(coords, p, candidate) > straightness(coords, p, current)
}

/** Cosine of the turn from segment `a` into segment `b`. */
const straightness = (coords: Float32Array, a: number, b: number): number => {
  const ax = (coords[a * 4 + 2] ?? 0) - (coords[a * 4] ?? 0)
  const ay = (coords[a * 4 + 3] ?? 0) - (coords[a * 4 + 1] ?? 0)
  const bx = (coords[b * 4 + 2] ?? 0) - (coords[b * 4] ?? 0)
  const by = (coords[b * 4 + 3] ?? 0) - (coords[b * 4 + 1] ?? 0)
  const length = Math.hypot(ax, ay) * Math.hypot(bx, by)
  return length === 0 ? 1 : (ax * bx + ay * by) / length
}
