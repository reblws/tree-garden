import { Schema } from 'effect'

/** The leaves' palette in the Leaf style: fresh yellow-greens, deep summer
 *  greens, or autumn's ochres, madders and russets. A viewing choice, like
 *  the style, so not part of the link. */
export const Season = Schema.Literals(['Spring', 'Summer', 'Autumn'])
export type Season = typeof Season.Type
