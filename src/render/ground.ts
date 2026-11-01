import { type Frame, clamp } from './frame'
import { hash, hash2, noise1 } from './noise'
import type { Placement } from './plate'

/**
 * The ground: not a floor line but what an ink painter leaves at the foot
 * of a tree, a sweep of dry brush, a fainter echo of it, a breath of wash
 * and a few moss dots (the "tai dian" of Chinese painting). Painted on the
 * ink layer before the tree, in a light cool tone, so the trunk stands in
 * it rather than on it.
 *
 * Everything is in plate pixels, seeded from the plant, and sized from the
 * finished trunk (not the growing one), so it neither changes during
 * playback nor swims under the camera.
 */
export const paintGround = (context: CanvasRenderingContext2D, frame: Frame, placement: Placement): void => {
  const { dpr, palette, topology, geometry } = frame
  const root = placement.root
  if (root === undefined) return
  const trunk = Math.max(frame.width(topology.maxRadius), 2 * dpr)
  const span = placement.plantWidth
  const seed = Math.floor(hash(geometry.count * 7 + 3) * 1e6)
  const rnd = (k: number) => hash2(seed, k)
  // Which way the main sweep runs further: away from the crown's lean, so
  // the ground balances the tree.
  const lean = placement.lean
  const far = lean < 0 ? 1 : -1

  context.save()
  context.globalCompositeOperation = 'source-over'

  // The main sweep, through the foot of the trunk.
  const reachFar = span * (0.36 + rnd(1) * 0.22)
  const reachNear = span * (0.14 + rnd(2) * 0.14)
  const x0 = root.x - far * reachNear
  const x1 = root.x + far * reachFar
  const tilt = (rnd(3) - 0.5) * 0.035
  sweep(context, frame, {
    x0,
    x1,
    y: root.y - trunk * 0.02,
    tilt,
    sag: trunk * (0.2 + rnd(4) * 0.3),
    width: trunk * 0.7,
    density: 0.5,
    cool: 0.45,
    seed: seed + 1,
    dryness: 0.6,
    hairs: 9,
  })
  // A fainter echo, lower and shorter, on the far side.
  const ex0 = root.x + far * span * (0.05 + rnd(5) * 0.1)
  sweep(context, frame, {
    x0: ex0,
    x1: ex0 + far * span * (0.2 + rnd(6) * 0.14),
    y: root.y + trunk * (0.75 + rnd(7) * 0.4),
    tilt: -tilt * 0.6,
    sag: trunk * 0.15,
    width: trunk * 0.3,
    density: 0.36,
    cool: 0.6,
    seed: seed + 2,
    dryness: 0.7,
    hairs: 6,
  })
  // A short stroke on the near side, sometimes.
  if (rnd(8) < 0.7) {
    const nx = root.x - far * span * (0.18 + rnd(9) * 0.12)
    sweep(context, frame, {
      x0: nx,
      x1: nx - far * span * (0.08 + rnd(11) * 0.08),
      y: root.y + trunk * (0.45 + rnd(12) * 0.3),
      tilt: tilt * 0.5,
      sag: trunk * 0.1,
      width: trunk * 0.24,
      density: 0.32,
      cool: 0.6,
      seed: seed + 3,
      dryness: 0.65,
      hairs: 5,
    })
  }

  // Moss dots: a few small clusters of dabs near the foot, each dab a
  // couple of overlapping touches of the brush tip.
  context.fillStyle = palette.inkTint(0.15, 1)
  const clusters = 2 + Math.floor(rnd(13) * 2)
  for (let k = 0; k < clusters; k++) {
    const along = k === 0 ? -far * trunk * (0.9 + rnd(30) * 0.6) : far * span * (0.06 + rnd(30 + k) * 0.22)
    const cx = root.x + along
    const cy = root.y + trunk * (0.05 + rnd(40 + k) * 0.2) + along * tilt
    const dabs = 2 + Math.floor(rnd(45 + k) * 3)
    for (let d = 0; d < dabs; d++) {
      const r = trunk * (0.03 + rnd(50 + k * 7 + d) * 0.04)
      const x = cx + (rnd(80 + k * 7 + d) - 0.5) * trunk * 1.1
      const y = cy + (rnd(90 + k * 7 + d) - 0.5) * trunk * 0.18
      context.globalAlpha = 0.4 + rnd(60 + k * 7 + d) * 0.3
      context.beginPath()
      for (let p = 0; p < 3; p++) {
        const ox = (rnd(100 + d * 3 + p + k * 17) - 0.5) * r * 0.9
        const oy = (rnd(110 + d * 3 + p + k * 17) - 0.5) * r * 0.5
        context.ellipse(x + ox, y + oy, r * (0.8 + rnd(120 + p + d) * 0.6), r * (0.45 + rnd(130 + p + d) * 0.3), (rnd(140 + p + d) - 0.5) * 0.8, 0, Math.PI * 2)
      }
      context.fill()
    }
  }
  context.restore()
}

interface Sweep {
  readonly x0: number
  readonly x1: number
  readonly y: number
  readonly tilt: number
  readonly sag: number
  readonly width: number
  readonly density: number
  readonly cool: number
  readonly seed: number
  /** 0 a loaded brush .. 1 a brush that breaks up into streaks. */
  readonly dryness: number
  /** How many bundles of hairs the brush splits into. */
  readonly hairs: number
}

/** One horizontal brush stroke from x0 to x1: pressed at the start,
 *  thinning towards its end. The brush splits into bundles of hairs; each
 *  bundle's track breaks where it ran dry and tapers into each break, so
 *  the stroke frays into "flying white" towards its end and its edges. */
const sweep = (context: CanvasRenderingContext2D, frame: Frame, stroke: Sweep) => {
  const { dpr, palette } = frame
  const length = Math.abs(stroke.x1 - stroke.x0)
  if (length < 4 * dpr) return
  const dir = Math.sign(stroke.x1 - stroke.x0)
  const steps = Math.max(8, Math.ceil(length / (1.5 * dpr)))
  const bundles = stroke.hairs
  context.fillStyle = palette.tone(1, stroke.cool)
  const path = new Path2D()
  const xs: Array<number> = []
  const ys: Array<number> = []
  const hs: Array<number> = []
  const flush = () => {
    const run = xs.length
    if (run >= 2) {
      path.moveTo(xs[0] ?? 0, (ys[0] ?? 0) - (hs[0] ?? 0))
      for (let k = 1; k < run; k++) path.lineTo(xs[k] ?? 0, (ys[k] ?? 0) - (hs[k] ?? 0))
      for (let k = run - 1; k >= 0; k--) path.lineTo(xs[k] ?? 0, (ys[k] ?? 0) + (hs[k] ?? 0))
    }
    xs.length = 0
    ys.length = 0
    hs.length = 0
  }
  for (let b = 0; b < bundles; b++) {
    const across = (b + 0.5) / bundles - 0.5 + (hash2(stroke.seed, b + 50) - 0.5) * 0.6 / bundles
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const s = (t * length) / dpr
      // Pressed in quickly, then lifted slowly.
      const pressure = Math.sin(Math.min(1, t * 5) * Math.PI * 0.5) * (1 - 0.8 * t ** 1.6)
      const half = (stroke.width / 2) * pressure * (1 + 0.12 * noise1(stroke.seed + 1, s / 9))
      const x = stroke.x0 + dir * t * length
      const y = stroke.y + (x - stroke.x0) * stroke.tilt + stroke.sag * 4 * t * (1 - t) + noise1(stroke.seed + 9, s / 40) * stroke.width * 0.25
      // Dry towards the end and at the edges of the brush.
      const dry = clamp(stroke.dryness * (0.25 + 0.75 * t) + Math.abs(across) * 0.6 - 0.25, 0, 0.97)
      const nz = noise1(stroke.seed * 13 + b, s / 13) * 0.5 + 0.5
      const e = (nz - dry) / 0.18
      if (e > 0 && half > 0.05 * dpr) {
        xs.push(x)
        ys.push(y + across * half * 2)
        hs.push(((half * 2) / bundles) * (0.3 + 0.2 * hash2(stroke.seed, b + 90)) * Math.min(1, e) ** 0.6)
      } else if (xs.length > 0) {
        flush()
      }
    }
    flush()
  }
  context.globalAlpha = stroke.density
  context.fill(path)
}
