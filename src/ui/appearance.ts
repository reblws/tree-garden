import type { RenderStyle } from '../render/renderStyle'
import type { Season } from '../render/season'

/** A seed chooses a repeatable foliage variant without changing geometry. */
export const foliageOf = (seed: string): { style: RenderStyle; season: Season } => {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619)
  const variant = (hash >>> 0) % 4
  return {
    style: variant === 3 ? 'Blossom' : 'Leaf',
    season: variant === 0 ? 'Spring' : variant === 2 ? 'Autumn' : 'Summer',
  }
}

export const appearanceOf = (model: { renderStyle: RenderStyle; season: Season; isSeasonAutomatic: boolean; params: { seed: string } }) =>
  model.renderStyle === 'Leaf' && model.isSeasonAutomatic ? foliageOf(model.params.seed) : { style: model.renderStyle, season: model.season }
