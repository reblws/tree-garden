import type { Segments2D } from '../core/geometry'

/**
 * Generated geometry lives here, keyed by build id, and never in the Foldkit
 * Model. The Model would copy and diff it on every update, and the Model
 * must stay small and serialisable (time-travel DevTools depends on it).
 *
 * The Model holds only the build id; the canvas element looks the geometry
 * up by that id when it draws. This is the one piece of shared mutable
 * state in the app.
 */
const KEEP = 4
const builds = new Map<number, Segments2D>()

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
}
