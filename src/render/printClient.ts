import { canFilter } from './canvas'
import { type PrintProgress, type PrintRequest, renderPrint } from './print'
import { type FromWorker, type ToWorker, transferableCopy } from './printProtocol'

/**
 * The page's side of the print: prints are painted in a module Web Worker
 * on OffscreenCanvas (print.worker.ts), so not one long task lands on the
 * main thread, and they come back as PNG Blobs ready to download.
 *
 * One worker, started on the first print and kept, and one print at a
 * time, queued here as well as in the worker: two prints painting at once
 * can push the browser into software raster partway and change the bytes.
 *
 * Without Worker or OffscreenCanvas (older browsers), if the worker fails
 * to load, or if its OffscreenCanvas contexts lack `filter` where the
 * window's canvas has it (Safari may), the print is painted here on the
 * main thread instead, yielding between bands, with the same bytes.
 */

/** How long the worker may take to load before the page paints the print
 *  itself. */
const READY_TIMEOUT_MS = 15_000

interface Pending {
  readonly onProgress: PrintProgress | undefined
  readonly resolve: (blob: Blob) => void
  readonly reject: (error: Error) => void
}

interface PrintWorker {
  readonly worker: Worker
  readonly pending: Map<number, Pending>
}

let started: Promise<PrintWorker | undefined> | undefined
let nextId = 1
let queue: Promise<unknown> = Promise.resolve()

/** The worker, loaded, or undefined when prints must be painted here. */
const printWorker = (): Promise<PrintWorker | undefined> => {
  started ??= startWorker()
  return started
}

const startWorker = (): Promise<PrintWorker | undefined> =>
  new Promise(resolve => {
    if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') {
      resolve(undefined)
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL('./print.worker.ts', import.meta.url), { type: 'module', name: 'print' })
    } catch {
      resolve(undefined)
      return
    }
    const pending = new Map<number, Pending>()
    let isReady = false
    const give = (value: PrintWorker | undefined) => {
      clearTimeout(timer)
      if (value === undefined) worker.terminate()
      resolve(value)
    }
    const timer = setTimeout(() => give(undefined), READY_TIMEOUT_MS)
    worker.addEventListener('message', (event: MessageEvent<FromWorker>) => {
      const message = event.data
      if (message.type === 'Ready') {
        isReady = true
        // A worker that can't blur would print without the ink's bleed
        // and the soft wash; paint here instead, where the canvas can.
        give(message.canFilter || !canFilter() ? { worker, pending } : undefined)
        return
      }
      const job = pending.get(message.id)
      if (job === undefined) return
      if (message.type === 'Progress') {
        job.onProgress?.(message.done, message.total)
        return
      }
      pending.delete(message.id)
      if (message.type === 'Done') job.resolve(message.blob)
      else job.reject(new Error(message.reason))
    })
    worker.addEventListener('error', event => {
      event.preventDefault()
      if (!isReady) {
        give(undefined)
        return
      }
      // The worker died mid-print (out of memory, say): fail what it held,
      // and start a fresh one for the next print.
      worker.terminate()
      started = undefined
      for (const job of pending.values()) job.reject(new Error(event.message || 'The print worker stopped'))
      pending.clear()
    })
  })

const paintInWorker = ({ worker, pending }: PrintWorker, request: PrintRequest, onProgress: PrintProgress | undefined): Promise<Blob> =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { onProgress, resolve, reject })
    const { geometry, transfer } = transferableCopy(request.geometry)
    const message: ToWorker = { type: 'Print', id, request: { ...request, geometry } }
    worker.postMessage(message, transfer)
  })

/**
 * Paint `request` as a PNG Blob, in the worker if there is one, reporting
 * progress per band. Prints run one at a time, in the order asked for.
 */
export const paintPrint = (request: PrintRequest, onProgress?: PrintProgress): Promise<Blob> => {
  const run = queue.then(async () => {
    const worker = await printWorker()
    if (worker !== undefined) return paintInWorker(worker, request, onProgress)
    // A geometry object of its own, as the worker's copy is, so the
    // painters' per-geometry caches start afresh (the density wash's
    // first draw of a new wash differs by a level or two from a redraw
    // of a cached one): every print of a plant is the same, the first
    // or the fifth, here or in the worker.
    return renderPrint({ ...request, geometry: { ...request.geometry } }, onProgress === undefined ? {} : { onProgress })
  })
  queue = run.catch(() => undefined)
  return run
}

/** Hand `blob` to the browser as a download named `fileName`. */
export const saveBlob = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
