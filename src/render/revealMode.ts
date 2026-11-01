import { Schema } from 'effect'

/** How the canvas reveals a plant during playback: `Grow` extends every
 *  branch outward from the root at once, `Trace` draws segments in the
 *  order the turtle visited them. */
export const RevealMode = Schema.Literals(['Grow', 'Trace'])
export type RevealMode = typeof RevealMode.Type
