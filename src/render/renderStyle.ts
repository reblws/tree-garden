import { Schema } from 'effect'

/** How the canvas paints a plant: `Leaf` and `Blossom` are the ink brush
 *  with a watercolour wash of leaves or plum blossom at the tips, `Ink` the
 *  brush alone (a tapering,
 *  textured stroke whose width follows the pipe model), and `Line` a plain
 *  technical pen that shows the structure. */
export const RenderStyle = Schema.Literals(['Leaf', 'Blossom', 'Ink', 'Line'])
export type RenderStyle = typeof RenderStyle.Type
