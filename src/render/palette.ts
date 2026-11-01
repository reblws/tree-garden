/**
 * The plate's colours. The CSS owns them (`--plate-paper`, `--plate-ink`,
 * `--plate-highlight` in styles.css, switched by prefers-color-scheme), and
 * the canvas reads them back so the painting always matches the page.
 */

type Rgb = readonly [number, number, number]

export interface Palette {
  /** Changes whenever anything below does; part of the cache keys. */
  readonly key: string
  readonly isDark: boolean
  readonly paper: string
  readonly ink: string
  /** The paper's own light fibres and grain (dark fibres use the ink). */
  readonly highlight: string
  readonly inkRgb: Rgb
  readonly highlightRgb: Rgb
  /** Strength of the paper texture layers, 0..1. */
  readonly grain: number
  readonly cloud: number
  readonly vignette: number
  /** How the ink layer lands on the paper: darken on light paper, lighten
   *  on dark paper. Either way the paper's tooth shows through the ink. */
  readonly blend: GlobalCompositeOperation
  /** How the colour wash lands: a transparent glaze on light paper, a
   *  gouache-like body colour on dark paper. */
  readonly washBlend: GlobalCompositeOperation
  readonly washAlpha: number
  readonly withInkAlpha: (alpha: number) => string
  /** How brush bodies combine on the ink layer: each is an opaque tone
   *  (see `tone`), and overlapping bodies keep the denser one, so a branch
   *  flows into its limb without a darker seam at the join. */
  readonly union: GlobalCompositeOperation
  /** An opaque colour for ink of `density` (0 none .. 1 full) on the ink
   *  layer, `cool` (0..1) of the way to diluted ink's blue-grey. Used with
   *  `union`; the layer then lands on the paper by `blend`. */
  readonly tone: (density: number, cool: number) => string
  /** The ink, `cool` of the way to its diluted blue-grey, at `alpha`. */
  readonly inkTint: (cool: number, alpha: number) => string
}

const LIGHT = { paper: '#f2efe8', ink: '#141311', highlight: '#fdfcf9' }
const DARK = { paper: '#141413', ink: '#ebe8e1', highlight: '#2a2927' }
/** Sumi ink thinned with water turns a cool blue-grey; dense, it is a warm
 *  black. On dark paper the same idea is a cool chalk. */
const COOL_LIGHT: Rgb = [44, 56, 68]
const COOL_DARK: Rgb = [196, 208, 220]

const parseHex = (value: string, fallback: string): Rgb => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1] ?? fallback.slice(1)
  const n = Number.parseInt(hex, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = ([r, g, b]: Rgb) => `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`

export const prefersDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches

export const readPalette = (element: Element): Palette => {
  const isDark = prefersDark()
  const defaults = isDark ? DARK : LIGHT
  const style = getComputedStyle(element)
  return buildPalette(
    isDark,
    parseHex(style.getPropertyValue('--plate-paper'), defaults.paper),
    parseHex(style.getPropertyValue('--plate-ink'), defaults.ink),
    parseHex(style.getPropertyValue('--plate-highlight'), defaults.highlight),
  )
}

const buildPalette = (isDark: boolean, paperRgb: Rgb, inkRgb: Rgb, highlightRgb: Rgb): Palette => {
  const coolRgb = isDark ? COOL_DARK : COOL_LIGHT
  const paper = toHex(paperRgb)
  const ink = toHex(inkRgb)
  const highlight = toHex(highlightRgb)
  return {
    key: `${paper}${ink}${highlight}`,
    isDark,
    paper,
    ink,
    highlight,
    inkRgb,
    highlightRgb,
    grain: isDark ? 0.07 : 0.085,
    cloud: isDark ? 0.05 : 0.045,
    vignette: isDark ? 0.0 : 0.07,
    blend: isDark ? 'screen' : 'multiply',
    washBlend: isDark ? 'source-over' : 'multiply',
    washAlpha: isDark ? 0.8 : 1,
    withInkAlpha: alpha => `rgba(${inkRgb[0]}, ${inkRgb[1]}, ${inkRgb[2]}, ${alpha})`,
    union: isDark ? 'lighten' : 'darken',
    tone: (density, cool) => {
      const neutral = isDark ? 0 : 255
      const c = mix(inkRgb, coolRgb, cool)
      const d = density < 0 ? 0 : density > 1 ? 1 : density
      return `rgb(${Math.round(neutral + (c[0] - neutral) * d)}, ${Math.round(neutral + (c[1] - neutral) * d)}, ${Math.round(neutral + (c[2] - neutral) * d)})`
    },
    inkTint: (cool, alpha) => {
      const c = mix(inkRgb, coolRgb, cool)
      return `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`
    },
  }
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** The light palette with the CSS defaults: a print is always ink on paper,
 *  whatever the page's theme. */
export const printPalette = (): Palette => ({
  ...buildPalette(false, parseHex(LIGHT.paper, LIGHT.paper), parseHex(LIGHT.ink, LIGHT.ink), parseHex(LIGHT.highlight, LIGHT.highlight)),
  // A real sheet is lit by the room it hangs in: no vignette.
  vignette: 0,
})
