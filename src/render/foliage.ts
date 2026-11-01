import { litSide } from '../core/shading'
import { type Frame, clamp, isInView, textureMatrix } from './frame'
import { hash, hash2 } from './noise'
import { toothTile } from './inkBrush'
import type { Placement } from './plate'
import type { Season } from './season'

/**
 * Foliage: a watercolour wash of leaves or blossoms, painted on a layer of
 * its own and laid under the ink (see plate.ts). The page stays black and
 * white; colour lives only in the painting, and only a little of it, like
 * the touches of colour in an ink-and-wash scroll or a hand-tinted
 * botanical plate.
 *
 * Leaves are lanceolate, pointed and a little bent, set alternately along
 * the last segments of every twig and at its tip, angled out from the twig
 * and drooping slightly. Each is a translucent wash with a darker dried
 * edge; the half turned from the light (upper left) carries a second, darker
 * glaze, so leaves read as folded along their midrib, and the midrib itself
 * appears once the zoom makes leaves big enough to hold it. Pigments come in
 * a seasonal palette; in autumn a few leaves have fallen to the ground.
 *
 * Plum blossom, as painted in ink-and-colour: five round petals, each its
 * own touch of colour with a fine darker outline, so the petals stay
 * separate; a pale centre and fine dark stamens with anthers (a cluster of
 * dots until the zoom can show lines); some flowers seen from the side as
 * a cup on a dark calyx; buds; and a few petals fallen to the ground.
 *
 * Leaves and flowers in front of the branches also lift the ink beneath
 * them (`occluders`, cut from the ink layer by the compositor), so some
 * twigs pass behind the foliage and some in front: depth, cheaply.
 *
 * Dense trees keep a deterministic subset of tips (by a hash of the tip).
 * During playback the subset is smaller still, and nested in the final
 * one, so leaves only ever fill in. Everything is in plate pixels under the
 * view's transform; the subset doesn't depend on the zoom (a print under a
 * loupe gains no leaves). Unbranched figures get no foliage.
 */

interface Pigment {
  readonly color: string
  readonly rim: string
  /** Relative frequency. */
  readonly weight: number
}

const SPRING: ReadonlyArray<Pigment> = [
  { color: '#a9c172', rim: '#78923f', weight: 3 },
  { color: '#bfcf83', rim: '#8ea150', weight: 2.5 },
  { color: '#93b562', rim: '#5f8237', weight: 2 },
  { color: '#d0d898', rim: '#a3ab62', weight: 1.4 },
  { color: '#c9a483', rim: '#97704f', weight: 0.5 },
]

const SUMMER: ReadonlyArray<Pigment> = [
  { color: '#7e9a64', rim: '#55703f', weight: 3 },
  { color: '#98ab68', rim: '#6d8143', weight: 2.5 },
  { color: '#6f8b78', rim: '#4b6553', weight: 2 },
  { color: '#5f7d55', rim: '#3e5636', weight: 1.4 },
  { color: '#b9a865', rim: '#8c7c3f', weight: 0.4 },
]

const AUTUMN: ReadonlyArray<Pigment> = [
  { color: '#d0a145', rim: '#9c7022', weight: 3 },
  { color: '#c97d34', rim: '#94511b', weight: 2.5 },
  { color: '#b9503a', rim: '#863121', weight: 1.8 },
  { color: '#e0bf62', rim: '#ab8b33', weight: 1.6 },
  { color: '#94363a', rim: '#64201f', weight: 0.8 },
  { color: '#94985a', rim: '#666b35', weight: 0.8 },
]

const PALETTES: Record<Season, ReadonlyArray<Pigment>> = { Spring: SPRING, Summer: SUMMER, Autumn: AUTUMN }

/** Plum blossom: white and pale pinks, with a rare deep rose. */
const BLOSSOMS: ReadonlyArray<Pigment> = [
  { color: '#f4e4e2', rim: '#c39a9c', weight: 3 },
  { color: '#eec7cb', rim: '#b98088', weight: 2.5 },
  { color: '#f8f0ea', rim: '#bfa59c', weight: 2 },
  { color: '#dc95a1', rim: '#a5596a', weight: 0.8 },
]
const CALYX = '#4a2a2c'
const STAMEN = '#3a2a24'
const ANTHER = '#8a6424'
const HEART = '#d9cf8f'

export type FoliageKind = 'Leaf' | 'Blossom'

/** Most leaves (or flowers × 5) on a finished plate, and per playback
 *  frame. Filling and rimming ~10K small shapes costs ~50 ms. */
const MAX_DABS = 10_000
const MAX_DABS_ANIMATING = 3_500
/** Leaves per tip: one at the tip and up to four along the twig. */
const LEAVES_PER_TIP = 5
const PETALS = 5

const pickPigment = (pigments: ReadonlyArray<Pigment>, h: number): number => {
  const total = pigments.reduce((sum, p) => sum + p.weight, 0)
  let x = h * total
  for (let k = 0; k < pigments.length; k++) {
    x -= pigments[k]?.weight ?? 0
    if (x < 0) return k
  }
  return pigments.length - 1
}

/** Bézier handle length for a quarter ellipse. */
const KAPPA = 0.5522847498

/** An ellipse rotated by `rotation`, as four cubic Béziers, starting and
 *  ending at the end of its first axis. Same shape as `Path2D.ellipse`.
 *  Measured in Chrome 156: a rotated `ellipse()`, like `closePath()`, costs
 *  time proportional to the whole path so far, so 10K leaves in one Path2D
 *  took ~400 ms; Béziers without a closePath take ~3 ms. */
export const addEllipse = (path: Path2D, cx: number, cy: number, rx: number, ry: number, rotation: number): void => {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  const ax = cos * rx
  const ay = sin * rx
  const bx = -sin * ry
  const by = cos * ry
  const k = KAPPA
  path.moveTo(cx + ax, cy + ay)
  path.bezierCurveTo(cx + ax + k * bx, cy + ay + k * by, cx + k * ax + bx, cy + k * ay + by, cx + bx, cy + by)
  path.bezierCurveTo(cx - k * ax + bx, cy - k * ay + by, cx - ax + k * bx, cy - ay + k * by, cx - ax, cy - ay)
  path.bezierCurveTo(cx - ax - k * bx, cy - ay - k * by, cx - k * ax - bx, cy - k * ay - by, cx - bx, cy - by)
  path.bezierCurveTo(cx + k * ax - bx, cy + k * ay - by, cx + ax - k * bx, cy + ay - k * by, cx + ax, cy + ay)
}

/** Paths for one pigment: two washes (so overlapping leaves of the same
 *  colour still deepen where they overlap), the shaded halves, and veins. */
interface Wash {
  readonly fill: [Path2D, Path2D]
  readonly shade: Path2D
  readonly veins: Path2D
}

const newWash = (): Wash => ({ fill: [new Path2D(), new Path2D()], shade: new Path2D(), veins: new Path2D() })

/** A lanceolate leaf from its base at (x, y), `length` long and `width`
 *  wide at its widest (a third of the way out), pointing along `angle` and
 *  bending by `bend` (a share of its length). Adds the outline to `fill`,
 *  the half on side `shadeSide` (1 left, -1 right) to `shade`, and the
 *  midrib to `veins` if given. */
const addLeaf = (
  fill: Path2D,
  shade: Path2D,
  veins: Path2D | undefined,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  bend: number,
  shadeSide: number,
) => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  // Leaf-local (u along, v across) to plate.
  const px = (u: number, v: number) => x + c * u - s * v
  const py = (u: number, v: number) => y + s * u + c * v
  const curve = (u: number) => bend * length * (u / length) ** 2
  const w = width
  const L = length
  const tipX = px(L, curve(L))
  const tipY = py(L, curve(L))
  fill.moveTo(x, y)
  fill.bezierCurveTo(px(L * 0.12, w * 0.62 + curve(L * 0.12)), py(L * 0.12, w * 0.62 + curve(L * 0.12)), px(L * 0.58, w * 0.55 + curve(L * 0.58)), py(L * 0.58, w * 0.55 + curve(L * 0.58)), tipX, tipY)
  fill.bezierCurveTo(px(L * 0.58, -w * 0.55 + curve(L * 0.58)), py(L * 0.58, -w * 0.55 + curve(L * 0.58)), px(L * 0.12, -w * 0.62 + curve(L * 0.12)), py(L * 0.12, -w * 0.62 + curve(L * 0.12)), x, y)
  const v = shadeSide * w
  shade.moveTo(x, y)
  shade.bezierCurveTo(px(L * 0.12, v * 0.62 + curve(L * 0.12)), py(L * 0.12, v * 0.62 + curve(L * 0.12)), px(L * 0.58, v * 0.55 + curve(L * 0.58)), py(L * 0.58, v * 0.55 + curve(L * 0.58)), tipX, tipY)
  shade.quadraticCurveTo(px(L * 0.5, curve(L * 0.5) * 0.5), py(L * 0.5, curve(L * 0.5) * 0.5), x, y)
  if (veins !== undefined) {
    veins.moveTo(px(L * 0.04, 0), py(L * 0.04, 0))
    veins.quadraticCurveTo(px(L * 0.5, curve(L * 0.5) * 0.5), py(L * 0.5, curve(L * 0.5) * 0.5), px(L * 0.86, curve(L * 0.86)), py(L * 0.86, curve(L * 0.86)))
  }
}

export const hasFoliage = (frame: Frame): boolean => frame.topology.maxRadius > 1.0001

/**
 * Paint the foliage on `context` (under the view's transform). Returns the
 * shapes of the leaves and flowers that lie in front of the branches, for
 * the compositor to lift out of the ink, and how strongly.
 */
export const paintFoliage = (
  context: CanvasRenderingContext2D,
  frame: Frame,
  kind: FoliageKind,
  season: Season,
  placement: Placement,
): { readonly occluders: Path2D; readonly strength: number } | undefined => {
  if (!hasFoliage(frame)) return undefined
  const { geometry, topology, dpr, scale, offsetX, offsetY, visible, view } = frame
  const { coords, count, parent } = geometry
  const { childCount } = topology

  let tips = 0
  for (let i = 0; i < count; i++) if (childCount[i] === 0 && (parent[i] ?? -1) >= 0) tips++
  if (tips === 0) return undefined

  // How much paper each tip has, in CSS pixels; leaves fill part of it.
  const { minX, minY, maxX, maxY } = geometry.bounds
  const area = Math.max(1, ((maxX - minX) * scale) / dpr) * Math.max(1, ((maxY - minY) * scale) / dpr)
  const isBlossom = kind === 'Blossom'
  const perTip = isBlossom ? PETALS : LEAVES_PER_TIP
  const keepFinal = Math.min(1, MAX_DABS / (tips * perTip))
  const keep = frame.isAnimating ? Math.min(keepFinal, MAX_DABS_ANIMATING / (tips * perTip)) : keepFinal
  // Sized for the finished plate, so dabs don't change size when it lands.
  const spacing = Math.sqrt(area / (tips * keepFinal))
  const leaf = clamp(spacing * (isBlossom ? 0.78 : 0.95), isBlossom ? 2.6 : 3, isBlossom ? 11 : 15) * dpr
  // Growth: a leaf unfolds over this much of the reveal after its tip.
  const unfold = frame.isGrow ? 2.5 : 1
  // Fine detail once there are pixels for it.
  const onScreen = (leaf / dpr) * view.detail
  // Dried edges and veins are the paint's, not the leaf's: they thicken
  // only gently as you zoom.
  const edge = dpr * Math.sqrt(view.texture / view.zoom)

  const occluders = new Path2D()
  if (isBlossom) {
    paintBlossom(context, frame, { tips, keep, leaf, unfold, onScreen, occluders, placement, edge })
    return { occluders, strength: 0.72 }
  }

  const pigments = PALETTES[season]
  const washes = pigments.map(newWash)
  const hasVeins = onScreen > 9
  const spring = season === 'Spring' ? 0.82 : 1
  const pad = leaf * 2
  for (let i = 0; i < count; i++) {
    if (childCount[i] !== 0 || (parent[i] ?? -1) < 0) continue
    if (keep < 1 && hash(i * 7 + 3) > keep) continue
    const v = visible(i)
    if (v < 1) continue
    const grown = clamp((v - 1) / unfold + 0.35, 0, 1)
    // Walk back from the tip: the tip segment and up to two before it.
    let segment = i
    let slot = 0
    for (let back = 0; back < 3 && segment >= 0; back++) {
      const o = segment * 4
      const ax = offsetX + (coords[o] ?? 0) * scale
      const ay = offsetY - (coords[o + 1] ?? 0) * scale
      const bx = offsetX + (coords[o + 2] ?? 0) * scale
      const by = offsetY - (coords[o + 3] ?? 0) * scale
      if (!isInView(view, ax, ay, bx, by, pad)) break
      const heading = Math.atan2(by - ay, bx - ax)
      const segmentLength = Math.hypot(bx - ax, by - ay)
      // The tip's own leaf, carrying on the twig's line.
      if (back === 0) {
        const h = hash2(i, 0x51)
        const length = leaf * (0.95 + h * 0.4) * grown * spring
        const angle = heading + (hash2(i, 0x52) - 0.5) * 0.5
        addOne(washes, pigments, i, slot++, bx, by, angle, length, grown, hasVeins, occluders)
      }
      // Alternate leaves along the segment, smaller towards the tip.
      const along = back === 0 ? [0.55] : [0.25, 0.75]
      for (const t of along) {
        if (slot >= LEAVES_PER_TIP) break
        const side = slot % 2 === 0 ? 1 : -1
        const h1 = hash2(i * 5 + slot, 0x61)
        const h2 = hash2(i * 5 + slot, 0x62)
        const x = ax + (bx - ax) * t
        const y = ay + (by - ay) * t
        // Out from the twig, drooping a little under its own weight.
        let angle = heading + side * (0.55 + h1 * 0.5)
        angle += Math.atan2(Math.sin(Math.PI / 2 - angle), Math.cos(Math.PI / 2 - angle)) * 0.18
        const length = leaf * (0.65 + h2 * 0.5 + back * 0.12) * grown * spring
        if (segmentLength > 0) addOne(washes, pigments, i, slot, x, y, angle, length, grown, hasVeins, occluders)
        slot++
      }
      const up = parent[segment] ?? -1
      if (up < 0 || (childCount[up] ?? 0) > 2) break
      segment = up
    }
  }

  // A few leaves already fallen, in autumn.
  if (season === 'Autumn' && placement.root !== undefined && !frame.isAnimating) {
    const root = placement.root
    const fallen = 9 + Math.floor(hash(geometry.count) * 10)
    for (let k = 0; k < fallen; k++) {
      const h1 = hash2(geometry.count + k, 0x71)
      const h2 = hash2(geometry.count + k, 0x72)
      const h3 = hash2(geometry.count + k, 0x73)
      const x = root.x + (h1 - 0.45) * placement.plantWidth * 0.8
      const y = root.y + (h2 - 0.3) * leaf * 1.6
      const wash = washes[pickPigment(pigments, h3)] ?? (washes[0] as Wash)
      // Lying on the ground: foreshortened.
      const angle = (h3 - 0.5) * 1.2 + (k % 2 === 0 ? 0 : Math.PI)
      addLeaf(wash.fill[k % 2] as Path2D, wash.shade, undefined, x, y, angle, leaf * (0.7 + h2 * 0.4), leaf * 0.16, 0.08, 1)
    }
  }

  context.lineJoin = 'round'
  washes.forEach((wash, k) => {
    const pigment = pigments[k]
    if (pigment === undefined) return
    context.fillStyle = pigment.color
    context.globalAlpha = 0.5
    context.fill(wash.fill[0])
    context.fill(wash.fill[1])
    // The half turned from the light, glazed again.
    context.fillStyle = pigment.rim
    context.globalAlpha = 0.2
    context.fill(wash.shade)
    // The wash dried darker at its edge (left out of busy playback frames).
    if (frame.isAnimating && tips * keep * LEAVES_PER_TIP > 1500) return
    context.globalAlpha = 0.3
    context.strokeStyle = pigment.rim
    context.lineWidth = 0.55 * edge
    context.stroke(wash.fill[0])
    context.stroke(wash.fill[1])
    if (hasVeins) {
      context.globalAlpha = 0.4 * clamp((onScreen - 9) / 8, 0, 1)
      context.lineWidth = 0.35 * edge
      context.stroke(wash.veins)
    }
  })

  granulate(context, frame)
  return { occluders, strength: 0.4 }
}

/** One leaf into a wash chosen by hash; leaves in front also become
 *  occluders. */
const addOne = (
  washes: ReadonlyArray<Wash>,
  pigments: ReadonlyArray<Pigment>,
  tip: number,
  slot: number,
  x: number,
  y: number,
  angle: number,
  length: number,
  grown: number,
  hasVeins: boolean,
  occluders: Path2D,
) => {
  if (length <= 0) return
  const h = hash2(tip * 7 + slot, 0x9e37)
  const wash = washes[pickPigment(pigments, h)] ?? (washes[0] as Wash)
  const width = length * (0.3 + hash2(tip * 7 + slot, 0x41) * 0.1)
  const bend = (hash2(tip * 7 + slot, 0x43) - 0.5) * 0.25
  // The shaded half: the one whose side faces away from the light.
  const shadeSide = litSide(Math.cos(angle), Math.sin(angle)) > 0 ? -1 : 1
  const fill = wash.fill[slot % 2] as Path2D
  addLeaf(fill, wash.shade, hasVeins ? wash.veins : undefined, x, y, angle, length, width, bend, shadeSide)
  if (grown >= 1 && hash2(tip * 7 + slot, 0x45) < 0.45) {
    addLeaf(occluders, new Path2D(), undefined, x, y, angle, length, width, bend, shadeSide)
  }
}

interface BlossomContext {
  readonly tips: number
  readonly keep: number
  readonly leaf: number
  readonly unfold: number
  readonly onScreen: number
  readonly occluders: Path2D
  readonly placement: Placement
  /** Line width for dried edges, plate px. */
  readonly edge: number
}

const paintBlossom = (context: CanvasRenderingContext2D, frame: Frame, b: BlossomContext) => {
  const { geometry, topology, dpr, scale, offsetX, offsetY, visible, view } = frame
  const { coords, count, parent } = geometry
  const { childCount } = topology
  const { keep, leaf, unfold, onScreen, occluders } = b
  // Two washes per pigment, so neighbouring petals deepen where they
  // overlap and each petal stays a petal.
  const petals = BLOSSOMS.map(() => [new Path2D(), new Path2D()] as const)
  const calyx = new Path2D()
  const hearts = new Path2D()
  const stamens = new Path2D()
  const anthers = new Path2D()
  const showStamens = onScreen > 7
  for (let i = 0; i < count; i++) {
    if (childCount[i] !== 0 || (parent[i] ?? -1) < 0) continue
    if (keep < 1 && hash(i * 7 + 3) > keep) continue
    const v = visible(i)
    if (v < 1) continue
    const grown = clamp((v - 1) / unfold + 0.35, 0, 1)
    const o = i * 4
    const x0 = coords[o] ?? 0
    const y0 = coords[o + 1] ?? 0
    const x1 = coords[o + 2] ?? 0
    const y1 = coords[o + 3] ?? 0
    const tx = offsetX + x1 * scale
    const ty = offsetY - y1 * scale
    if (!isInView(view, tx, ty, tx, ty, leaf * 1.5)) continue
    const heading = Math.atan2(-(y1 - y0), x1 - x0)
    const size = leaf * (0.78 + hash2(i, 0x3d) * 0.4) * grown
    const pair = petals[pickPigment(BLOSSOMS, hash2(i, 0x9e37))] ?? (petals[0] as (typeof petals)[number])
    const kind = hash2(i, 0xb1)
    if (kind < 0.55) {
      // An open flower, facing us, a little away from the shoot.
      const cx = tx + Math.cos(heading) * size * 0.22
      const cy = ty + Math.sin(heading) * size * 0.22
      const turn = hash2(i, 0x7a) * Math.PI * 2
      const r = size * (0.2 + hash2(i, 0x3c) * 0.05)
      for (let k = 0; k < PETALS; k++) {
        const a = turn + (k * Math.PI * 2) / PETALS + (hash2(i + k, 0x13) - 0.5) * 0.25
        const reach = r * (0.95 + hash2(i + k, 0x15) * 0.15)
        const px = cx + Math.cos(a) * reach
        const py = cy + Math.sin(a) * reach
        const rx = r * 1.05
        const ry = r * (0.9 + hash2(i + k, 0x11) * 0.15)
        addEllipse(pair[k % 2] as Path2D, px, py, rx, ry, a)
        if (grown >= 1) addEllipse(occluders, px, py, rx * 0.92, ry * 0.92, a)
      }
      addEllipse(hearts, cx, cy, r * 0.3, r * 0.3, 0)
      if (showStamens) {
        // Many fine filaments, of uneven length, each with a tiny anther.
        const n = 16 + Math.floor(hash2(i, 0x21) * 10)
        for (let k = 0; k < n; k++) {
          const a = turn + (k / n) * Math.PI * 2 + (hash2(i * 3 + k, 0x23) - 0.5) * 0.5
          const len = r * (0.55 + hash2(i * 3 + k, 0x25) * 0.75)
          const ex = cx + Math.cos(a) * len
          const ey = cy + Math.sin(a) * len
          const sway = (hash2(i * 3 + k, 0x29) - 0.5) * 0.5
          stamens.moveTo(cx + Math.cos(a) * r * 0.15, cy + Math.sin(a) * r * 0.15)
          stamens.quadraticCurveTo(cx + Math.cos(a + sway) * len * 0.55, cy + Math.sin(a + sway) * len * 0.55, ex, ey)
          const dot = r * 0.045 + 0.12 * dpr
          addEllipse(anthers, ex, ey, dot, dot * 0.8, a)
        }
      } else {
        for (let k = 0; k < 3; k++) {
          const a = turn + k * 2.1
          addEllipse(anthers, cx + Math.cos(a) * r * 0.45, cy + Math.sin(a) * r * 0.45, r * 0.16 + 0.25 * dpr, r * 0.16 + 0.25 * dpr, 0)
        }
      }
    } else if (kind < 0.75) {
      // Seen from the side: a cup of three petals on a dark calyx.
      const axis = heading + (hash2(i, 0x7b) - 0.5) * 1.2
      const r = size * 0.21
      const bx = tx + Math.cos(axis) * r * 0.5
      const by = ty + Math.sin(axis) * r * 0.5
      for (let k = -1; k <= 1; k++) {
        const a = axis + k * 0.62
        addEllipse(pair[(k + 2) % 2] as Path2D, bx + Math.cos(a) * r * 1.05, by + Math.sin(a) * r * 1.05, r * 1.1, r * 0.82, a)
      }
      if (grown >= 1) addEllipse(occluders, bx + Math.cos(axis) * r * 1.05, by + Math.sin(axis) * r * 1.05, r * 1.2, r * 1.1, axis)
      addCalyx(calyx, tx, ty, axis, r * 0.75)
      if (showStamens) {
        for (let k = -3; k <= 3; k++) {
          const a = axis + k * 0.16 + (hash2(i + k, 0x2b) - 0.5) * 0.1
          const len = r * (1.5 + hash2(i + k, 0x27) * 0.6)
          stamens.moveTo(bx, by)
          stamens.lineTo(bx + Math.cos(a) * len, by + Math.sin(a) * len)
          const dot = r * 0.05 + 0.12 * dpr
          addEllipse(anthers, bx + Math.cos(a) * len, by + Math.sin(a) * len, dot, dot * 0.8, a)
        }
      }
    } else {
      // A bud: a closed dab of deeper colour held in a dark calyx.
      const r = size * 0.17
      const deep = petals[1] ?? pair
      const bx = tx + Math.cos(heading) * r * 0.9
      const by = ty + Math.sin(heading) * r * 0.9
      addEllipse(deep[0] as Path2D, bx, by, r * 1.12, r * 0.92, heading)
      addCalyx(calyx, tx, ty, heading, r * 0.8)
    }
  }

  // Petals fallen to the ground, and a couple still falling.
  const root = b.placement.root
  if (root !== undefined && !frame.isAnimating) {
    const n = 10 + Math.floor(hash(geometry.count * 3) * 12)
    for (let k = 0; k < n; k++) {
      const h1 = hash2(geometry.count + k, 0x81)
      const h2 = hash2(geometry.count + k, 0x82)
      const h3 = hash2(geometry.count + k, 0x83)
      const pair = petals[pickPigment(BLOSSOMS, h3)] ?? (petals[0] as (typeof petals)[number])
      const r = leaf * 0.19 * (0.8 + h3 * 0.4)
      const isFalling = k < 3
      const x = root.x + (h1 - 0.5) * b.placement.plantWidth * (isFalling ? 0.7 : 0.85)
      const y = isFalling ? root.y - (0.15 + h2 * 0.3) * b.placement.plantWidth * 0.5 : root.y + (h2 - 0.25) * leaf * 1.3
      // Lying flat they are foreshortened; in the air, tumbling.
      addEllipse(pair[k % 2] as Path2D, x, y, r * 1.1, r * (isFalling ? 0.7 : 0.5), (h3 - 0.5) * (isFalling ? 3 : 0.6))
    }
  }

  const alpha = 0.78
  context.lineJoin = 'round'
  BLOSSOMS.forEach((pigment, k) => {
    const pair = petals[k]
    if (pair === undefined) return
    context.fillStyle = pigment.color
    context.globalAlpha = alpha
    context.fill(pair[0])
    context.fill(pair[1])
    if (frame.isAnimating && b.tips * b.keep * PETALS > 1500) return
    // A fine outline, as in the outline-and-colour manner.
    context.strokeStyle = pigment.rim
    context.globalAlpha = 0.38
    context.lineWidth = 0.5 * b.edge
    context.stroke(pair[0])
    context.stroke(pair[1])
  })
  context.fillStyle = HEART
  context.globalAlpha = 0.75
  context.fill(hearts)
  context.fillStyle = CALYX
  context.globalAlpha = 0.85
  context.fill(calyx)
  if (showStamens) {
    context.strokeStyle = STAMEN
    context.globalAlpha = 0.55 * clamp((onScreen - 7) / 6, 0, 1)
    context.lineWidth = Math.max(0.16 * dpr, 0.3 * b.edge)
    context.lineCap = 'round'
    context.stroke(stamens)
  }
  context.fillStyle = showStamens ? ANTHER : STAMEN
  context.globalAlpha = showStamens ? 0.85 : 0.7
  context.fill(anthers)
  granulate(context, frame)
}

/** A calyx: two or three small pointed sepals at (x, y), opening along
 *  `axis`. */
const addCalyx = (path: Path2D, x: number, y: number, axis: number, r: number) => {
  for (let k = -1; k <= 1; k++) {
    const a = axis + k * 0.75
    const tipX = x + Math.cos(a) * r * 1.3
    const tipY = y + Math.sin(a) * r * 1.3
    const nx = -Math.sin(a) * r * 0.45
    const ny = Math.cos(a) * r * 0.45
    path.moveTo(x, y)
    path.quadraticCurveTo(x + Math.cos(a) * r * 0.6 + nx, y + Math.sin(a) * r * 0.6 + ny, tipX, tipY)
    path.quadraticCurveTo(x + Math.cos(a) * r * 0.6 - nx, y + Math.sin(a) * r * 0.6 - ny, x, y)
  }
}

/** Granulation: pigment settles in the paper's hollows and leaves the
 *  peaks. */
const granulate = (context: CanvasRenderingContext2D, frame: Frame) => {
  const tooth = context.createPattern(toothTile(), 'repeat')
  if (tooth === null) return
  tooth.setTransform(textureMatrix(frame.view, false).scaleSelf(frame.dpr * 0.7, frame.dpr * 0.7))
  context.save()
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.globalCompositeOperation = 'destination-out'
  context.globalAlpha = 0.22
  context.fillStyle = tooth
  context.fillRect(0, 0, context.canvas.width, context.canvas.height)
  context.restore()
  context.globalAlpha = 1
}
