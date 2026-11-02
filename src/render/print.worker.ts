import { canFilter } from './canvas'
import { renderPrint } from './print'
import type { FromWorker, ToWorker } from './printProtocol'

/**
 * The print worker: paints prints on OffscreenCanvas and encodes them, off
 * the main thread. One long-lived worker, one print at a time: two prints
 * painting at once compete for canvas memory, and under that pressure the
 * browser can fall back from GPU to software raster partway, which changes
 * the bytes. Requests that arrive while a print is painting wait their
 * turn.
 */

const post = (message: FromWorker): void => self.postMessage(message)

let queue: Promise<void> = Promise.resolve()

const paint = async ({ id, request }: ToWorker): Promise<void> => {
  try {
    const blob = await renderPrint(request, {
      yieldBetweenBands: false,
      onProgress: (done, total) => {
        if (done < total) post({ type: 'Progress', id, done, total })
      },
    })
    post({ type: 'Done', id, blob })
  } catch (error) {
    post({ type: 'Failed', id, reason: error instanceof Error ? error.message : String(error) })
  }
}

self.addEventListener('message', (event: MessageEvent<ToWorker>) => {
  if (event.data.type !== 'Print') return
  const job = event.data
  queue = queue.then(() => paint(job))
})

post({ type: 'Ready', canFilter: canFilter() })
