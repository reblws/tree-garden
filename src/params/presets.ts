import type { LSystemParams } from './lsystem'

export interface Preset {
  readonly id: string
  readonly name: string
  /** Where it comes from, e.g. a figure in The Algorithmic Beauty of Plants. */
  readonly source: string
  readonly params: Omit<LSystemParams, 'seed'>
}

const plant = (
  id: string,
  name: string,
  source: string,
  axiom: string,
  rules: string,
  iterations: number,
  angle: number,
  jitter = 0,
): Preset => ({ id, name, source, params: { axiom, rules, iterations, angle, jitter } })

/** Bracketed and stochastic OL-systems from ABOP chapter 1, plus two
 *  classic fractals for contrast. */
export const presets: ReadonlyArray<Preset> = [
  plant('abop-1-24a', 'Bush (edge rewriting)', 'ABOP fig. 1.24a', 'F', 'F -> F[+F]F[-F]F', 5, 25.7),
  plant('abop-1-24b', 'Weed', 'ABOP fig. 1.24b', 'F', 'F -> F[+F]F[-F][F]', 5, 20),
  plant('abop-1-24c', 'Shrub', 'ABOP fig. 1.24c', 'F', 'F -> FF-[-F+F+F]+[+F-F-F]', 4, 22.5),
  plant('abop-1-24d', 'Twig (node rewriting)', 'ABOP fig. 1.24d', 'X', 'X -> F[+X]F[-X]+X\nF -> FF', 7, 20),
  plant('abop-1-24e', 'Sapling', 'ABOP fig. 1.24e', 'X', 'X -> F[+X][-X]FX\nF -> FF', 7, 25.7),
  plant('abop-1-24f', 'Fractal plant', 'ABOP fig. 1.24f', 'X', 'X -> F-[[X]+X]+F[+FX]-X\nF -> FF', 5, 22.5),
  plant(
    'abop-1-27',
    'Stochastic bush',
    'ABOP fig. 1.27',
    'F',
    '# three successors for F, picked at random with these weights\nF (0.33) -> F[+F]F[-F]F\nF (0.33) -> F[+F]F\nF (0.34) -> F[-F]F',
    5,
    25.7,
  ),
  plant('windswept', 'Windswept fractal plant', 'ABOP fig. 1.24f with angle jitter', 'X', 'X -> F-[[X]+X]+F[+FX]-X\nF -> FF', 5, 22.5, 0.35),
  plant('koch-snowflake', 'Koch snowflake', 'Classic fractal', 'F--F--F', 'F -> F+F--F+F', 4, 60),
  plant('sierpinski', 'Sierpinski triangle', 'Classic fractal', 'F-G-G', 'F -> F-G+F+G-F\nG -> GG', 6, 120),
]

export const defaultPreset: Preset = presets[5] ?? (presets[0] as Preset)

export const findPreset = (id: string): Preset | undefined =>
  presets.find(preset => preset.id === id)
