import { findPreset } from '../params/presets'
import type { Model } from './model'

/** "22.5°", "20°". */
export const formatAngle = (value: number): string => `${Number.isInteger(value) ? value : value.toFixed(1)}°`

/**
 * What is pencilled under the plate, on screen and on the print: where the
 * grammar comes from, its title, and the numbers that grow it. The print
 * also records the seed, so it can be traced back to its link.
 */
export const inscriptionsOf = (
  model: Pick<Model, 'presetId' | 'params'>,
  withSeed = false,
): readonly [string, string, string] => {
  const preset = findPreset(model.presetId)
  const numbers = `n ${model.params.iterations} · δ ${formatAngle(model.params.angle)}`
  return [
    preset?.source ?? 'Custom',
    preset?.name ?? 'Untitled',
    withSeed ? `${numbers} · ${model.params.seed}` : numbers,
  ]
}

/** "tree-garden-fractal-plant-oak-leaf-a3.png" */
export const printFileName = (model: Pick<Model, 'presetId' | 'params' | 'renderStyle' | 'printSize'>): string => {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const title = findPreset(model.presetId)?.name ?? 'untitled'
  return ['tree-garden', slug(title), slug(model.params.seed), slug(model.renderStyle), slug(model.printSize)]
    .filter(part => part !== '')
    .join('-')
    .concat('.png')
}
