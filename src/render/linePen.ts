import { type Frame, isInView } from './frame'

/**
 * Technical-pen painter: every stroke chain as one crisp polyline, in a few
 * pen weights that follow the pipe-model radius. No texture, no noise, so
 * the structure reads clearly, and it is the cheapest way to draw huge
 * trees.
 *
 * Paths are in plate pixels under the view's transform, so pens magnify
 * with the zoom like ink on a print; segments off screen are skipped.
 */

const PEN_WEIGHTS = [0.7, 1, 1.5, 2.2] as const

export const paintLines = (context: CanvasRenderingContext2D, frame: Frame): void => {
  const { geometry, topology, radius, dpr, scale, offsetX, offsetY, visible, view } = frame
  const { coords } = geometry
  const { chainSegments, chainStart, chainCount } = topology
  const maxRadius = Math.max(topology.maxRadius, 1)
  const paths = PEN_WEIGHTS.map(() => new Path2D())
  const last = PEN_WEIGHTS.length - 1
  const pad = (PEN_WEIGHTS[last] ?? 2) * dpr

  for (let c = 0; c < chainCount; c++) {
    const begin = chainStart[c] ?? 0
    const end = chainStart[c + 1] ?? 0
    let pen = -1
    for (let k = begin; k < end; k++) {
      const segment = chainSegments[k] ?? 0
      const v = visible(segment)
      if (v <= 0) break
      const fraction = v < 1 ? v : 1
      // Pen weight by relative radius on a log scale: twigs, branches,
      // limbs, trunk.
      const relative = Math.log(Math.max(radius[segment] ?? 1, 1)) / Math.log(maxRadius + 1e-9)
      const weight = maxRadius <= 1.0001 ? 1 : Math.min(last, Math.floor(relative * (last + 1)))
      const path = paths[weight] ?? (paths[0] as Path2D)
      const o = segment * 4
      const ax = coords[o] ?? 0
      const ay = coords[o + 1] ?? 0
      const bx = ax + ((coords[o + 2] ?? 0) - ax) * fraction
      const by = ay + ((coords[o + 3] ?? 0) - ay) * fraction
      const x0 = offsetX + ax * scale
      const y0 = offsetY - ay * scale
      const x1 = offsetX + bx * scale
      const y1 = offsetY - by * scale
      if (!isInView(view, x0, y0, x1, y1, pad)) {
        pen = -1
        if (v < 1) break
        continue
      }
      if (weight !== pen) {
        path.moveTo(x0, y0)
        pen = weight
      }
      path.lineTo(x1, y1)
      if (v < 1) break
    }
  }

  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.strokeStyle = frame.palette.ink
  context.globalAlpha = 0.92
  paths.forEach((path, weight) => {
    context.lineWidth = (PEN_WEIGHTS[weight] ?? 1) * dpr
    context.stroke(path)
  })
  context.globalAlpha = 1
}
