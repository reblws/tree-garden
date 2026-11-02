import { type BranchTopology, PIPE_EXPONENT, analyzeBranches } from '../core/branching'
import type { Segments2D } from '../core/geometry'

/**
 * Generated geometry lives here, keyed by build id, and never in the Foldkit
 * Model. The Model would copy and diff it on every update, and the Model
 * must stay small and serialisable (time-travel DevTools depends on it).
 *
 * The Model holds only the build id; the canvas element looks the geometry
 * up by that id when it draws. This is the one piece of shared mutable
 * state in the app.
 *
 * Each geometry's branch topology is kept with it, keyed by the geometry
 * itself (so it goes when the geometry does). The generator's worker
 * computes it along with the geometry and puts it here, so the first
 * paint finds it ready.
 */
const KEEP = 4
const builds = new Map<number, Segments2D>()
const topologies = new WeakMap<Segments2D, BranchTopology>()

export const GeometryStore = {
  set: (buildId: number, geometry: Segments2D): void => {
    builds.set(buildId, geometry)
    // Maps iterate in insertion order, so the first key is the oldest build.
    while (builds.size > KEEP) {
      const oldest = builds.keys().next().value
      if (oldest === undefined) break
      builds.delete(oldest)
    }
  },
  get: (buildId: number): Segments2D | undefined => builds.get(buildId),
  /** Keep the topology computed along with `geometry` (with the default
   *  pipe exponent). */
  setTopology: (geometry: Segments2D, topology: BranchTopology): void => {
    topologies.set(geometry, topology)
  },
  /** The topology of `geometry`: the one that came with it, or computed
   *  now and kept. */
  topologyOf: (geometry: Segments2D): BranchTopology => {
    let topology = topologies.get(geometry)
    if (topology === undefined) {
      topology = analyzeBranches(geometry, PIPE_EXPONENT)
      topologies.set(geometry, topology)
    }
    return topology
  },
}
