/**
 * Canvases for the painters, in a window or in a worker.
 *
 * The print is painted in a Web Worker (print.worker.ts), where there is
 * no `document`: there every canvas is an `OffscreenCanvas`. On the main
 * thread the painters keep the DOM canvas they always had, so the screen,
 * and the print's fallback when there is no worker, paint exactly as
 * before (and Safari, whose OffscreenCanvas contexts may lack `filter`,
 * keeps its blurs there).
 *
 * The result is typed as an `HTMLCanvasElement`: the painters use only
 * what the two share (`width`, `height`, `getContext('2d')`, and the
 * canvas as an image or pattern source), and the 2D contexts share the
 * drawing API, so not one painter's signature has to change.
 */

const hasDocument = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function'

/** A canvas of `width` × `height` px: an OffscreenCanvas where there is no
 *  DOM (a worker), a `<canvas>` element where there is. */
export const makeCanvas = (width: number, height: number): HTMLCanvasElement => {
  if (!hasDocument() && typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const isOffscreen = (canvas: HTMLCanvasElement): boolean =>
  typeof OffscreenCanvas === 'function' && (canvas as unknown) instanceof OffscreenCanvas

/** Encode `canvas` as a PNG, whichever kind it is. */
export const encodePng = async (canvas: HTMLCanvasElement): Promise<Blob> => {
  const blob = isOffscreen(canvas)
    ? await (canvas as unknown as OffscreenCanvas).convertToBlob({ type: 'image/png' })
    : await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('The browser could not encode the print')
  return blob
}

/** Whether 2D contexts here honour `filter` (the plate's blurs: the ink's
 *  bleed and the softened wash). Safari's may not, notably on an
 *  OffscreenCanvas, where the property can be missing even when the
 *  window's canvas has it. */
export const canFilter = (): boolean => {
  if (!hasDocument()) {
    return typeof OffscreenCanvasRenderingContext2D === 'function' && 'filter' in OffscreenCanvasRenderingContext2D.prototype
  }
  return typeof CanvasRenderingContext2D === 'function' && 'filter' in CanvasRenderingContext2D.prototype
}
