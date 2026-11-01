/**
 * Light and shade across a branch, as an ink painter would suggest volume:
 * a branch is a cylinder lit from the upper left. Pure math, shared by the
 * painters and unit-tested; no DOM.
 *
 * Coordinates are the screen's (x right, y down). Across a stroke, `u` runs
 * from -1 at its right-hand edge to +1 at its left-hand edge (left and right
 * as seen walking along the stroke from root to tip).
 */

/** Unit vector towards the light, on the page: up and to the left. */
export const LIGHT_X = -0.6
export const LIGHT_Y = -0.8
/** How much of the light comes from the viewer's side rather than across
 *  the page: enough that the middle of a branch is never in full shadow. */
const LIGHT_FRONT = 0.5
const LIGHT_ACROSS = 0.85
/** Light bounced back into the shadow side from the surroundings. */
const REFLECTED = 0.16

/**
 * How squarely the left-hand edge (u = +1) of a stroke heading along the
 * unit tangent (tx, ty) faces the light: 1 when it faces it, -1 when the
 * right-hand edge does, 0 when the stroke points at the light.
 */
export const litSide = (tx: number, ty: number): number => -ty * LIGHT_X + tx * LIGHT_Y

/**
 * Brightness of a cylinder's surface at across position `u` (-1..1), for a
 * stroke whose left edge faces the light by `lit` (see `litSide`): Lambert
 * shading with the light partly in front, plus a little reflected light
 * creeping round the shadow edge. 0 (core shadow) .. ~1 (highlight).
 */
export const brightness = (u: number, lit: number): number => {
  const a = u < -1 ? -1 : u > 1 ? 1 : u
  const facing = a * lit
  const direct = facing * LIGHT_ACROSS + Math.sqrt(1 - a * a) * LIGHT_FRONT
  const away = -facing
  const bounce = away > 0 ? REFLECTED * away ** 4 : 0
  return (direct > 0 ? direct : 0) + bounce
}

/** Ink to add for shade at `u`: 0 on the highlight, 1 in the core shadow. */
export const shade = (u: number, lit: number): number => {
  const b = brightness(u, lit) / (LIGHT_ACROSS * 0.75 + LIGHT_FRONT * 0.66)
  return b >= 1 ? 0 : 1 - b
}
