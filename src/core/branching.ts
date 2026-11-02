import type { Segments2D } from './geometry'

/**
 * Topology of a branching structure, computed from the `parent` links in
 * Segments2D. Pure and allocation-light: everything is a typed array indexed
 * by segment, and every pass is a single sequential loop, because trees can
 * have hundreds of thousands of segments.
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
 *
 * PERFORMANCE. These loops run on every rebuild (in the generator's worker)
 * and, for the growing radii, on every playback frame. The per-frame loops
 * are small functions without closures; `weight^(1/e)` comes from a table
 * for the small integer weights that nearly every segment has; the
 * topology is sequential passes with a counting sort instead of pointer
 * chasing. Every result is bit-identical to the straightforward version
 * (`src/test/reference/branching.ts`, checked by src/test/determinism.test.ts).
 */

/** Default fork exponent: between Leonardo (2) and Murray (3), close to what
 *  is measured on real trees. */
export const PIPE_EXPONENT = 2.3

// ---------------------------------------------------------------- weights

/** Integer weights below this have their radius tabled. */
const POW_TABLE_SIZE = 1 << 16
const powTable = new Float64Array(POW_TABLE_SIZE)
let powTableInverse = Number.NaN

/** Point the table at `inverse` (= 1 / exponent), clearing it if it held
 *  another exponent's radii. */
const usePowTable = (inverse: number): void => {
  if (inverse !== powTableInverse) {
    powTable.fill(0)
    powTableInverse = inverse
  }
}

/** `weight ** inverse` for an integer weight ≥ 1: the same expression,
 *  computed once per weight and then looked up. Call `usePowTable(inverse)`
 *  first. */
const radiusOf = (weight: number, inverse: number): number => {
  if (weight < POW_TABLE_SIZE) {
    const tabled = powTable[weight] as number
    if (tabled !== 0) return tabled
    const radius = weight ** inverse
    powTable[weight] = radius
    return radius
  }
  return weight ** inverse
}

/** Weights (tips = 1) of the segments `0 .. n-1`, others 0. Children come
 *  after their parents, so walking backwards finishes each segment before
 *  its weight is handed up. */
const accumulateWeights = (parent: Int32Array, n: number, out: Float32Array): void => {
  for (let i = n - 1; i >= 0; i--) {
    // A segment nobody grew from is a tip and feeds one pipe.
    const w0 = out[i] as number
    const w = w0 === 0 ? 1 : w0
    out[i] = w
    const p = parent[i] as number
    if (p >= 0) out[p] = (out[p] as number) + w
  }
}

/** The same for the segments that also pass `isVisible`. */
const accumulateVisibleWeights = (
  parent: Int32Array,
  n: number,
  out: Float32Array,
  isVisible: (index: number) => boolean,
): void => {
  for (let i = n - 1; i >= 0; i--) {
    if (!isVisible(i)) continue
    const w0 = out[i] as number
    const w = w0 === 0 ? 1 : w0
    out[i] = w
    const p = parent[i] as number
    if (p >= 0) out[p] = (out[p] as number) + w
  }
}

/** Weight -> radius in place for `0 .. n-1`; returns the largest radius. */
const weightsToRadii = (out: Float32Array, n: number, inverse: number): number => {
  usePowTable(inverse)
  let maxRadius = 0
  for (let i = 0; i < n; i++) {
    const w = out[i] as number
    if (w === 0) continue
    const r = radiusOf(w, inverse)
    out[i] = r
    if (r > maxRadius) maxRadius = r
  }
  return maxRadius
}

/**
 * Accumulate pipe-model weights (`r^exponent`, tips = 1) into `out`, for the
 * segments with `index < visibleCount` that also satisfy `isVisible`
 * (others get 0). Relies on `parent[i] < i`, so one backwards pass suffices.
 * A visible segment's parent must be visible too, which holds for both
 * reveal orders the renderer uses (by index and by path distance).
 *
 * Returns the largest radius (`max weight^(1/exponent)`), 0 when nothing is
 * visible. For the Grow reveal, `growRadii` is faster.
 */
export const pipeRadii = (
  geometry: Pick<Segments2D, 'count' | 'parent'>,
  exponent: number,
  out: Float32Array,
  visibleCount: number = geometry.count,
  isVisible?: (index: number) => boolean,
): number => {
  const n = Math.max(0, Math.min(visibleCount, geometry.count))
  out.fill(0, 0, geometry.count)
  if (isVisible === undefined) accumulateWeights(geometry.parent, n, out)
  else accumulateVisibleWeights(geometry.parent, n, out, isVisible)
  return weightsToRadii(out, n, 1 / exponent)
}

// ------------------------------------------------------------ growing radii

/** Reused between frames: the running count of visible tips. */
let tipPrefix = new Int32Array(0)

/**
 * Pipe-model radii for the Grow reveal, where a segment is visible once
 * `arrival < threshold`: the same result as
 * `pipeRadii(geometry, exponent, out, count, i => arrival[i] < threshold)`,
 * bit for bit, in two flat passes and no closure.
 *
 * Segments come in depth-first preorder, so each subtree is an index range
 * (`topology.subtreeEnd`), and every child arrives one step after its
 * parent, so a visible segment is a visible tip exactly when it is a tip or
 * its children have not arrived yet. A segment's weight is then the number
 * of visible tips in its range: a difference of two prefix sums. Geometry
 * that isn't in that order (a move inside a branch) takes a plain
 * backwards pass instead.
 */
export const growRadii = (
  geometry: Pick<Segments2D, 'count' | 'parent' | 'arrival'>,
  topology: Pick<BranchTopology, 'childCount' | 'subtreeEnd'>,
  exponent: number,
  out: Float32Array,
  threshold: number,
): number => {
  const { count, arrival } = geometry
  const inverse = 1 / exponent
  if (topology.subtreeEnd.length !== count) {
    out.fill(0, 0, count)
    accumulateArrivedWeights(geometry.parent, arrival, count, out, threshold)
    return weightsToRadii(out, count, inverse)
  }
  if (tipPrefix.length < count + 1) tipPrefix = new Int32Array(count + 1)
  countVisibleTips(arrival, topology.childCount, count, threshold, tipPrefix)
  usePowTable(inverse)
  return radiiFromTipCounts(arrival, topology.subtreeEnd, tipPrefix, count, threshold, inverse, out)
}

/** `prefix[i]` = visible tips among segments `0 .. i-1`. */
const countVisibleTips = (
  arrival: Float32Array,
  childCount: Uint32Array,
  count: number,
  threshold: number,
  prefix: Int32Array,
): void => {
  let tips = 0
  for (let i = 0; i < count; i++) {
    prefix[i] = tips
    const a = arrival[i] as number
    if (a < threshold && (childCount[i] === 0 || !(a + 1 < threshold))) tips++
  }
  prefix[count] = tips
}

const radiiFromTipCounts = (
  arrival: Float32Array,
  subtreeEnd: Int32Array,
  prefix: Int32Array,
  count: number,
  threshold: number,
  inverse: number,
  out: Float32Array,
): number => {
  let maxRadius = 0
  for (let i = 0; i < count; i++) {
    if (!((arrival[i] as number) < threshold)) {
      out[i] = 0
      continue
    }
    const r = radiusOf((prefix[subtreeEnd[i] as number] as number) - (prefix[i] as number), inverse)
    out[i] = r
    if (r > maxRadius) maxRadius = r
  }
  return maxRadius
}

/** The plain backwards pass for the Grow reveal, without a closure. */
const accumulateArrivedWeights = (
  parent: Int32Array,
  arrival: Float32Array,
  count: number,
  out: Float32Array,
  threshold: number,
): void => {
  for (let i = count - 1; i >= 0; i--) {
    if (!((arrival[i] as number) < threshold)) continue
    const w0 = out[i] as number
    const w = w0 === 0 ? 1 : w0
    out[i] = w
    const p = parent[i] as number
    if (p >= 0) out[p] = (out[p] as number) + w
  }
}

// --------------------------------------------------------------- topology

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
  /** One past the last segment of each segment's subtree: when the
   *  segments are in depth-first preorder (as the turtle draws them) and
   *  every child arrives one step after its parent, segment `i`'s
   *  descendants are exactly `i + 1 .. subtreeEnd[i] - 1`. Empty when the
   *  geometry isn't in that order. Used by `growRadii`. */
  readonly subtreeEnd: Int32Array
}

/** The typed arrays of a BranchTopology, by name (to move it between
 *  threads). */
export const TOPOLOGY_ARRAYS = [
  'radius',
  'childCount',
  'mainChild',
  'chainSegments',
  'chainStart',
  'chainOf',
  'chainParent',
  'chainOrder',
  'chainRecession',
  'subtreeEnd',
] as const satisfies ReadonlyArray<keyof BranchTopology>

/**
 * Radii, forks and stroke chains for a finished structure, in four
 * sequential passes: weights backwards; radii, forks and main children
 * forwards (a child's radius is final when it is compared, since
 * parent < child); each segment's chain, with the chains' parents, orders
 * and recessions, forwards; and a counting sort of the segments into
 * their chains. (Measured in Chrome: as one function this is ~15% faster
 * than the pointer-chasing version and stays so; split into one function
 * per pass, V8 sometimes compiled it badly.)
 */
export const analyzeBranches = (geometry: Segments2D, exponent = PIPE_EXPONENT): BranchTopology => {
  const { count, parent, coords } = geometry
  const radius = new Float32Array(count)
  accumulateWeights(parent, count, radius)

  const inverse = 1 / exponent
  usePowTable(inverse)
  let maxRadius = 0
  const childCount = new Uint32Array(count)
  const mainChild = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    // Every segment has weight ≥ 1 here.
    const r = radiusOf(radius[i] as number, inverse)
    radius[i] = r
    if (r > maxRadius) maxRadius = r
    const p = parent[i] as number
    if (p < 0) continue
    childCount[p] = (childCount[p] as number) + 1
    const current = mainChild[p] as number
    if (current < 0 || isBetterContinuation(coords, radius, p, i, current)) mainChild[p] = i
  }

  // A chain starts at every segment that is not its parent's continuation.
  let chainCount = 0
  for (let i = 0; i < count; i++) {
    const p = parent[i] as number
    if (p < 0 || mainChild[p] !== i) chainCount++
  }
  // Chains are numbered by their first segment, and a parent segment always
  // comes before its children, so a chain's parent chain has a smaller
  // number: one forward pass settles membership, order and recession.
  // Chain sizes go into chainStart[c + 1] for now.
  const chainOf = new Int32Array(count)
  const chainStart = new Int32Array(chainCount + 1)
  const chainParent = new Int32Array(chainCount)
  const chainOrder = new Uint16Array(chainCount)
  const chainRecession = new Float32Array(chainCount)
  let next = 0
  for (let i = 0; i < count; i++) {
    const p = parent[i] as number
    if (p >= 0 && mainChild[p] === i) {
      const chain = chainOf[p] as number
      chainOf[i] = chain
      chainStart[chain + 1] = (chainStart[chain + 1] as number) + 1
      continue
    }
    const chain = next++
    chainOf[i] = chain
    chainStart[chain + 1] = (chainStart[chain + 1] as number) + 1
    const up = p < 0 ? -1 : (chainOf[p] as number)
    chainParent[chain] = up
    if (up < 0) continue
    chainOrder[chain] = (chainOrder[up] as number) + 1
    chainRecession[chain] = Math.min(1, (chainRecession[up] as number) + recessionStep(i))
  }
  // Sizes -> starts, then a counting sort. Within a chain, ascending index
  // is root-to-tip order.
  for (let c = 0; c < chainCount; c++) chainStart[c + 1] = (chainStart[c + 1] as number) + (chainStart[c] as number)
  const fill = chainStart.slice(0, chainCount)
  const chainSegments = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    const c = chainOf[i] as number
    const k = fill[c] as number
    chainSegments[k] = i
    fill[c] = k + 1
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
    subtreeEnd: subtreeEnds(parent, geometry.arrival, count),
  }
}

/** One past the end of every segment's subtree, if every subtree is the
 *  index range `[i, i + size)` and every child arrives one step after its
 *  parent; otherwise empty. If each child's range lies inside its
 *  parent's, then by counting each range holds exactly its subtree. */
const subtreeEnds = (parent: Int32Array, arrival: Float32Array, count: number): Int32Array => {
  const end = new Int32Array(count)
  // Backwards: subtree sizes.
  for (let i = count - 1; i >= 0; i--) {
    const size = (end[i] as number) + 1
    end[i] = size
    const p = parent[i] as number
    if (p >= 0) end[p] = (end[p] as number) + size
  }
  // Forwards: sizes -> ends, checking that the ranges nest.
  for (let i = 0; i < count; i++) {
    const e = i + (end[i] as number)
    end[i] = e
    const p = parent[i] as number
    if (p >= 0 && (e > (end[p] as number) || arrival[i] !== (arrival[p] as number) + 1)) return new Int32Array(0)
  }
  return end
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
  const rc = radius[candidate] as number
  const rk = radius[current] as number
  if (rc !== rk) return rc > rk
  return straightness(coords, p, candidate) > straightness(coords, p, current)
}

/** Cosine of the turn from segment `a` into segment `b`. */
const straightness = (coords: Float32Array, a: number, b: number): number => {
  const ax = (coords[a * 4 + 2] as number) - (coords[a * 4] as number)
  const ay = (coords[a * 4 + 3] as number) - (coords[a * 4 + 1] as number)
  const bx = (coords[b * 4 + 2] as number) - (coords[b * 4] as number)
  const by = (coords[b * 4 + 3] as number) - (coords[b * 4 + 1] as number)
  const length = Math.hypot(ax, ay) * Math.hypot(bx, by)
  return length === 0 ? 1 : (ax * bx + ay * by) / length
}
