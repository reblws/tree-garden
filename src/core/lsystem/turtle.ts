import { type Segments2D, emptyBounds } from '../geometry'

/**
 * Turtle interpretation (ABOP chapter 1): read the derived string left to
 * right as drawing commands for a turtle with a position and heading.
 *
 *   F G   move forward one step, drawing a segment
 *   f g   move forward one step without drawing
 *   +     turn left by the angle
 *   -     turn right by the angle
 *   |     turn around
 *   [     push the turtle's state (start a branch)
 *   ]     pop the turtle's state (end the branch)
 *
 * Every other symbol is ignored by the turtle; it only matters to the
 * grammar (like X in many plant grammars).
 */
export interface TurtleOptions {
  readonly angleDegrees: number
  /** 0..1. Each turn is scaled by a random factor in [1 - jitter, 1 + jitter]. */
  readonly angleJitter: number
  /** Initial heading; 90 points straight up. */
  readonly headingDegrees: number
}

const DEG = Math.PI / 180

const isDraw = (code: number) => code === 70 /* F */ || code === 71 /* G */
const isMove = (code: number) => code === 102 /* f */ || code === 103 /* g */

export const interpret = (
  symbols: string,
  options: TurtleOptions,
  random: () => number,
): Segments2D => {
  let capacity = 0
  for (let i = 0; i < symbols.length; i++) {
    if (isDraw(symbols.charCodeAt(i))) capacity++
  }

  const coords = new Float32Array(capacity * 4)
  const depth = new Uint16Array(capacity)
  const parent = new Int32Array(capacity)
  const arrival = new Float32Array(capacity)

  // Turtle state, plus a stack of saved states for branches.
  let x = 0
  let y = 0
  let heading = options.headingDegrees * DEG
  let level = 0
  let distance = 0
  // The segment the turtle last drew in this branch: the parent of the next
  // one. Saved and restored with the rest of the state on [ and ].
  let last = -1
  const stack: Array<number> = []

  let count = 0
  let maxDepth = 0
  let maxArrival = 0
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  const delta = options.angleDegrees * DEG
  const jitter = options.angleJitter

  const turn = () =>
    jitter > 0 ? delta * (1 + jitter * (2 * random() - 1)) : delta

  for (let i = 0; i < symbols.length; i++) {
    const code = symbols.charCodeAt(i)
    if (isDraw(code) || isMove(code)) {
      const nx = x + Math.cos(heading)
      const ny = y + Math.sin(heading)
      if (isDraw(code)) {
        const o = count * 4
        coords[o] = x
        coords[o + 1] = y
        coords[o + 2] = nx
        coords[o + 3] = ny
        depth[count] = level
        parent[count] = last
        arrival[count] = distance
        last = count
        count++
        if (level > maxDepth) maxDepth = level
        if (distance + 1 > maxArrival) maxArrival = distance + 1
      } else {
        // A move without drawing breaks the stroke.
        last = -1
      }
      x = nx
      y = ny
      distance += 1
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    } else if (code === 43 /* + */) {
      heading += turn()
    } else if (code === 45 /* - */) {
      heading -= turn()
    } else if (code === 124 /* | */) {
      heading += Math.PI
    } else if (code === 91 /* [ */) {
      stack.push(x, y, heading, level, distance, last)
      level++
    } else if (code === 93 /* ] */ && stack.length > 0) {
      last = stack.pop() ?? -1
      distance = stack.pop() ?? 0
      level = stack.pop() ?? 0
      heading = stack.pop() ?? 0
      y = stack.pop() ?? 0
      x = stack.pop() ?? 0
    }
  }

  return {
    count,
    coords,
    depth,
    parent,
    arrival,
    maxDepth,
    maxArrival,
    bounds: count === 0 ? emptyBounds : { minX, minY, maxX, maxY },
  }
}
