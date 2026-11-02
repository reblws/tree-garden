import type { Segments2D } from '../core/geometry'
import type { PrintRequest } from './print'

/**
 * What the page and the print worker say to each other. Everything is
 * passed by value: the request is plain data (the geometry's typed arrays
 * and a few strings; the print's palette is the fixed ink-on-paper one,
 * built in the worker by `printPalette`, which reads no CSS), and the PNG
 * comes back as a Blob.
 */

export type ToWorker = { readonly type: 'Print'; readonly id: number; readonly request: PrintRequest }

export type FromWorker =
  /** The worker has loaded. `canFilter`: its OffscreenCanvas contexts
   *  honour `filter` (see canvas.ts). */
  | { readonly type: 'Ready'; readonly canFilter: boolean }
  | { readonly type: 'Progress'; readonly id: number; readonly done: number; readonly total: number }
  | { readonly type: 'Done'; readonly id: number; readonly blob: Blob }
  | { readonly type: 'Failed'; readonly id: number; readonly reason: string }

/**
 * A copy of `geometry` whose typed arrays can be transferred to the
 * worker, and their buffers. The store keeps the original: the screen is
 * still painting it. Copying 350K segments (~9 MB) is a few milliseconds
 * and the transfer itself is free; rebuilding the plant in the worker
 * from its params would cost the generator's ~60 ms and the whole engine
 * in the worker's bundle.
 */
export const transferableCopy = (geometry: Segments2D): { readonly geometry: Segments2D; readonly transfer: Array<ArrayBuffer> } => {
  const coords = geometry.coords.slice()
  const depth = geometry.depth.slice()
  const parent = geometry.parent.slice()
  const arrival = geometry.arrival.slice()
  return {
    geometry: {
      count: geometry.count,
      coords,
      depth,
      parent,
      arrival,
      maxDepth: geometry.maxDepth,
      maxArrival: geometry.maxArrival,
      bounds: { ...geometry.bounds },
    },
    transfer: [coords.buffer, depth.buffer, parent.buffer, arrival.buffer],
  }
}
