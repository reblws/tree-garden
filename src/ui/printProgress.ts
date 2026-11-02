import { Effect, Queue, Stream } from 'effect'

/**
 * Progress of the print being painted, from the DownloadPrint Command (which
 * hears it from the print worker, a band at a time) to the subscription
 * that turns it into PaintedPrintBand Messages. A Command returns a single
 * Message, so the steps in between travel this way.
 */

export interface PrintBand {
  readonly done: number
  readonly total: number
}

const listeners = new Set<(band: PrintBand) => void>()

/** Called by the DownloadPrint Command as each band is painted. */
export const reportPrintBand = (band: PrintBand): void => {
  for (const listener of listeners) listener(band)
}

/** The bands painted from now on, as a Stream. */
export const printBands: Stream.Stream<PrintBand> = Stream.callback<PrintBand>(queue =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener = (band: PrintBand) => {
        Queue.offerUnsafe(queue, band)
      }
      listeners.add(listener)
      return listener
    }),
    listener => Effect.sync(() => listeners.delete(listener)),
  ).pipe(Effect.flatMap(() => Effect.never)),
)
