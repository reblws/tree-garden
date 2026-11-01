/**
 * The shared output format for 2D generators: a flat list of branch
 * segments in typed arrays. Every 2D algorithm on the site (L-systems now,
 * space colonization and others later) should produce this, so they can
 * share one renderer.
 *
 * Coordinates are in generator units with +y pointing up; the renderer fits
 * them to the canvas.
 */
export interface Segments2D {
  readonly count: number
  /** `x0, y0, x1, y1` per segment. */
  readonly coords: Float32Array
  /** Branch order: 0 for the main axis, +1 for each level of branching. */
  readonly depth: Uint16Array
  /** Index of the segment this one grows from (whose end is this one's
   *  start), or -1 for a segment that starts a new stroke. Parents always
   *  come before their children, so `parent[i] < i`. This is the topology
   *  that branch thickness and brush strokes are computed from; see
   *  `branching.ts`. */
  readonly parent: Int32Array
  /** Distance along the plant from the root to the segment's start. Used to
   *  animate growth outward from the root. */
  readonly arrival: Float32Array
  readonly maxDepth: number
  /** Largest `arrival + segment length`, i.e. when growth is complete. */
  readonly maxArrival: number
  readonly bounds: Bounds
}

export interface Bounds {
  readonly minX: number
  readonly minY: number
  readonly maxX: number
  readonly maxY: number
}

export const emptyBounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 }
