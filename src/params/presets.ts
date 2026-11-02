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
  plant('fractint-plant11', 'Parasol tree', 'Fractint plants.l, Plant11', 'F', 'F -> F[+F[+F][-F]F][-F[+F][-F]F]F[+F][-F]F', 3, 30),
  plant('sfi-conifer', 'Conifer', 'The Science of Fractal Images p. 286', 'VZFFF', 'V -> [+++W][---W]YV\nW -> +X[-W]Z\nX -> -W[+X]Z\nY -> YZ\nZ -> [-FFF][+FFF]F', 10, 20),
  plant('fractint-plant10', 'Round-crowned tree', 'Fractint plants.l, Plant10', 'F', 'F -> F[+FF][-FF]F[+FF][-FF]F', 4, 36),
  plant('bourke-bush-c', 'Tiered bush', 'Paul Bourke, Bush C', 'F', 'F -> F[+FF][-FF]F[-F][+F]F', 4, 35),
  plant('kevs-wispy-tree', 'Wispy tree', 'kevs3d.co.uk L-systems', 'FX', 'F -> FF-[-F+F]+[+F-F]\nX -> FF+[+F]+[-F]', 4, 25),
  plant('bourke-algae', 'Algae', 'Paul Bourke, Algae A (gaps drawn)', 'aF', 'a -> FFFFFv[+++h][---q]Fb\nb -> FFFFFv[+++h][---q]Fc\nc -> FFFFFv[+++Fa]Fd\nd -> FFFFFv[+++h][---q]Fe\ne -> FFFFFv[+++h][---q]Fz\nz -> FFFFFv[---Fa]Fa\nh -> iFFF\ni -> FFFF[--m]j\nj -> FFFF[--n]k\nk -> FFFF[--o]l\nl -> FFFF[--p]\nm -> FFn\nn -> FFo\no -> FFp\np -> FF\nq -> rFF\nr -> FFFF[++m]s\ns -> FFFF[++n]t\nt -> FFFF[++o]u\nu -> FFFF[++p]\nv -> Fv', 12, 12),
  plant('stochastic-parasol', 'Stochastic parasol tree', 'Fractint Plant11, stochastic after ABOP fig. 1.27', 'F', '# the full fork half the time, a one-sided fork otherwise\nF (0.5) -> F[+F[+F][-F]F][-F[+F][-F]F]F[+F][-F]F\nF (0.25) -> F[+F[+F][-F]F]F[-F]F\nF (0.25) -> F[-F[+F][-F]F]F[+F]F', 3, 30),
  plant('sfi-candelabra', 'Candelabra bush', 'The Science of Fractal Images p. 285b', 'Y', 'X -> X[-FFF][+FFF]FX\nY -> YFX[+Y][-Y]', 6, 25.7),
  plant('binary-tree', 'Binary tree', 'Wikipedia, L-system', 'F', 'F -> G[+F]-F\nG -> GG', 8, 45),
  plant('kevs-pond-weed', 'Pond weed', 'kevs3d.co.uk L-systems', 'F', 'F -> FF[-F++F][+F--F]++F--F', 4, 27),
  // Fractals
  plant('abop-1-11a', 'Hexagonal Gosper curve', 'ABOP fig. 1.11a', 'F', 'F -> F+G++G-F--FF-G+\nG -> -F+GG++G+F--F-G', 4, 60),
  plant('abop-1-10a', 'Dragon curve', 'ABOP fig. 1.10a', 'F', 'F -> F+G+\nG -> -F-G', 12, 90),
  plant('abop-1-9a', 'Koch ring', 'ABOP fig. 1.9a', 'F-F-F-F', 'F -> FF-F-F-F-F-F+F', 4, 90),
  plant('abop-1-8', 'Islands and lakes', 'ABOP fig. 1.8', 'F+F+F+F', 'F -> F+f-FF+F+FF+Ff+FF-f+FF-F-FF-Ff-FFF\nf -> ffffff', 2, 90),
  plant('abop-1-6', 'Quadratic Koch island', 'ABOP fig. 1.6', 'F-F-F-F', 'F -> F-F+F+FF-F-F+F', 3, 90),
  plant('bourke-pentaplexity', 'Pentaplexity', 'Paul Bourke, L-systems', 'F++F++F++F++F', 'F -> F++F++F|F-F++F', 4, 36),
  plant('bourke-levy', 'Lévy C curve', 'Paul Bourke, L-systems', 'F', 'F -> -F++F-', 12, 45),
  plant('abop-1-15', 'Hilbert curve', 'ABOP fig. 1.15', 'L', 'L -> +RF-LFL-FR+\nR -> -LF+RFR+FL-', 5, 90),
]

export const defaultPreset: Preset = presets[5] ?? (presets[0] as Preset)

export const findPreset = (id: string): Preset | undefined =>
  presets.find(preset => preset.id === id)
