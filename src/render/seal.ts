import { makeCanvas } from './canvas'
import { hash2, noise1 } from './noise'

/**
 * The seal: a small vermilion chop pressed into a corner of the plate, as
 * on a scroll or a woodblock print. Carved "white text" (baiwen): the
 * character 森, a grove, written as three trees in seal script, cut out of
 * a square of seal paste. The paste is uneven and the square's edges are
 * worn, so it reads as a stamp rather than a red box.
 *
 * Drawn once per size into its own canvas (it is the same at every zoom up
 * to its resolution), then laid on the plate.
 */

/** Cinnabar seal paste: a warm, slightly dull vermilion. */
const PASTE = [184, 52, 38] as const

let cache: { size: number; canvas: HTMLCanvasElement } | undefined

/** The seal at `size` device pixels square. */
export const sealImage = (size: number): HTMLCanvasElement => {
  const px = Math.max(16, Math.min(1024, Math.round(size)))
  if (cache?.size === px) return cache.canvas
  const canvas = makeCanvas(px, px)
  const context = canvas.getContext('2d')
  if (context === null) return canvas
  context.scale(px, px)

  // The square of paste, its edges worn by a little noise.
  const edge = (k: number, t: number) => 0.035 + 0.02 * noise1(0x5ea1 + k, t * 9) + 0.012 * noise1(0x5eb1 + k, t * 31)
  context.beginPath()
  const steps = 40
  for (let i = 0; i <= steps; i++) context.lineTo(i / steps, edge(0, i / steps))
  for (let i = 0; i <= steps; i++) context.lineTo(1 - edge(1, i / steps), i / steps)
  for (let i = steps; i >= 0; i--) context.lineTo(i / steps, 1 - edge(2, i / steps))
  for (let i = steps; i >= 0; i--) context.lineTo(edge(3, i / steps), i / steps)
  context.fillStyle = `rgb(${PASTE[0]}, ${PASTE[1]}, ${PASTE[2]})`
  context.fill()

  // The carving: three seal-script trees, cut out of the paste.
  context.globalCompositeOperation = 'destination-out'
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.lineWidth = 0.058
  tree(context, 0.5, 0.29, 0.34, 0.36)
  tree(context, 0.285, 0.71, 0.33, 0.37)
  tree(context, 0.715, 0.71, 0.33, 0.37)

  // Uneven paste: specks and a thin patch where the stamp didn't bite.
  context.setTransform(1, 0, 0, 1, 0, 0)
  const image = context.getImageData(0, 0, px, px)
  const data = image.data
  const cell = Math.max(1, px / 28)
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const o = (y * px + x) * 4 + 3
      const a = data[o] ?? 0
      if (a === 0) continue
      const fleck = hash2(Math.floor(x / cell) * 7919 + 3, Math.floor(y / cell)) * 0.6 + hash2(x * 31 + 7, y) * 0.4
      const thin = 0.5 + 0.5 * noise1(0x5ec1 + Math.floor(y / (px / 6)), x / (px / 3))
      const keep = fleck > 0.93 ? 0.35 : 1 - 0.18 * thin
      data[o] = Math.round(a * keep)
    }
  }
  context.putImageData(image, 0, 0)
  cache = { size: px, canvas }
  return canvas
}

/** 木 in seal script, in the box centred at (cx, cy), w × h: a stem, two
 *  arms curving up and two roots curving down. */
const tree = (context: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number) => {
  const top = cy - h / 2
  const bottom = cy + h / 2
  const left = cx - w / 2
  const right = cx + w / 2
  const branch = cy - h * 0.06
  const root = cy + h * 0.1
  context.beginPath()
  context.moveTo(cx, top)
  context.lineTo(cx, bottom)
  context.moveTo(cx, branch)
  context.quadraticCurveTo(left, branch, left + w * 0.04, top + h * 0.06)
  context.moveTo(cx, branch)
  context.quadraticCurveTo(right, branch, right - w * 0.04, top + h * 0.06)
  context.moveTo(cx, root)
  context.quadraticCurveTo(left + w * 0.05, root, left, bottom)
  context.moveTo(cx, root)
  context.quadraticCurveTo(right - w * 0.05, root, right, bottom)
  context.stroke()
}

/** Press the seal at (x, y) (its top-left corner), `size` plate pixels
 *  square, on a context under the view's transform. `zoom` sizes the
 *  image so it stays crisp. */
export const paintSeal = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  zoom: number,
  isDark: boolean,
): void => {
  const image = sealImage(size * zoom)
  context.save()
  context.globalCompositeOperation = isDark ? 'source-over' : 'multiply'
  context.globalAlpha = isDark ? 0.82 : 0.92
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, x, y, size, size)
  context.restore()
}
