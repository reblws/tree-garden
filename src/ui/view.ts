import { Option } from 'effect'
import type { Document, Html, HtmlBuilder, KeyboardModifiers } from 'foldkit/html'

import { ANGLE, ITERATIONS, JITTER } from '../params/lsystem'
import { findPreset, presets } from '../params/presets'
import { type Camera, MAX_ZOOM, formatZoom, isFit } from '../render/camera'
import type { RenderStyle } from '../render/renderStyle'
import { MARK_RATIO } from '../render/sheet'
import { treeCanvas } from '../render/treeCanvas'
import { formatAngle, inscriptionsOf } from './inscriptions'
import { Message } from './message'
import { appearanceOf } from './appearance'
import type { Model } from './model'

type H = HtmlBuilder<Message>

const formatCount = (n: number) => n.toLocaleString('en-US')

const icon = (h: H, d: string): Html =>
  h.svg(
    [h.ViewBox('0 0 12 12'), h.Attribute('width', '12'), h.Attribute('height', '12'), h.AriaHidden(true)],
    [h.path([h.Attribute('d', d), h.Attribute('fill', 'currentColor')], [])],
  )

const PLAY = 'M3 1.6v8.8a.4.4 0 0 0 .6.35l7.3-4.4a.4.4 0 0 0 0-.7L3.6 1.25A.4.4 0 0 0 3 1.6Z'
const PAUSE = 'M2.5 1.5h2.4v9H2.5zM7.1 1.5h2.4v9H7.1z'
const REPLAY =
  'M6 1.5a4.5 4.5 0 1 1-4.4 5.5h1.25A3.3 3.3 0 1 0 6 2.7v1.8L3.2 2.1 6 -.3Z'

/** Hairline plus and minus, stroked rather than filled, at 11px. */
const hairline = (h: H, d: string): Html =>
  h.svg(
    [h.ViewBox('0 0 11 11'), h.Attribute('width', '11'), h.Attribute('height', '11'), h.AriaHidden(true)],
    [h.path([h.Attribute('d', d), h.Attribute('stroke', 'currentColor'), h.Attribute('stroke-width', '1.1'), h.Attribute('fill', 'none')], [])],
  )
const MINUS = 'M1.5 5.5h8'
const PLUS = 'M1.5 5.5h8M5.5 1.5v8'

const row = (h: H, label: string, id: string, title: string, control: Html, value?: Html, extra = ''): Html =>
  h.div([h.Class(`control-row ${extra}`)], [
    h.label([h.For(id), h.Class('control-label')], [
      h.span([h.Class('control-symbol')], [label]),
      h.span([h.Id(`${id}-help`), h.Class('control-tooltip'), h.Role('tooltip')], [title]),
    ]),
    h.div([h.Class('control-value')], [control]),
    ...(value ? [value] : []),
  ])

interface SliderConfig {
  readonly id: string
  readonly label: string
  readonly title: string
  readonly help: string
  readonly value: number
  readonly range: { readonly min: number; readonly max: number; readonly step: number }
  readonly format: (value: number) => string
  readonly toMessage: (value: number) => Message
  readonly extra?: string
}

const slider = (h: H, config: SliderConfig): Html =>
  row(h, config.label, config.id, config.help,
    h.input([
      h.Id(config.id), h.Type('range'), h.Min(String(config.range.min)), h.Max(String(config.range.max)),
      h.Step(String(config.range.step)), h.Value(String(config.value)), h.Class('range'),
      h.AriaLabel(config.title), h.AriaDescribedBy(`${config.id}-help`), h.AriaValuetext(config.format(config.value)),
      h.OnInput(value => config.toMessage(Number(value))), h.OnChange(() => Message.CommittedEdit()),
    ]),
    h.output([h.For(config.id), h.Class('control-readout')], [config.format(config.value)]), config.extra,
  )

const presetSelect = (h: H, model: Model): Html =>
  h.div([h.Class('preset-row')], [
    h.select([
      h.Id('preset'), h.Class('field'), h.AriaLabel('Preset'), h.Title('Choose a specimen'),
      h.OnChange(presetId => Message.SelectedPreset({ presetId })),
    ], [
      ...(model.presetId === '' ? [h.option([h.Value(''), h.Selected(true)], ['Custom grammar'])] : []),
      ...presets.map(preset => h.option([h.Value(preset.id), h.Selected(preset.id === model.presetId)], [preset.name])),
    ]),
  ])

const styles: ReadonlyArray<RenderStyle> = ['Ink', 'Leaf', 'Line']
const styleTitles = {
  Ink: 'A tapering ink brush; branch thickness follows the pipe model',
  Leaf: 'Leaves or blossom, with a seasonal palette chosen by the seed',
  Line: 'A technical pen that shows the structure',
  Blossom: 'Ink with plum blossom',
}

const controls = (h: H, model: Model): Html => {
  const errors = model.errors.map(error => `Line ${error.line}: ${error.message}`).join('\n')
  return h.aside([h.Class('rail'), h.Id('controls'), h.AriaLabel('Parameters')], [
    presetSelect(h, model),
    h.div([h.Class('grammar menu-content')], [
      h.textarea([
        h.Id('rules'), h.Class('field'), h.Value(model.params.rules), h.Rows(3), h.Spellcheck(false),
        h.AriaLabel('Productions'), h.AriaInvalid(model.errors.length > 0), h.AriaDescribedBy('rules-errors'),
        h.Title(errors || 'Productions, one per line. A (0.5) -> … makes a weighted random choice.'),
        h.OnInput(value => Message.ChangedRules({ value })), h.OnChange(() => Message.CommittedEdit()),
      ]),
      h.p([h.Id('rules-errors'), h.Class('grammar-errors'), h.AriaLive('polite')], [errors]),
    ]),
    row(h, 'ω', 'axiom', 'Axiom (ω): the starting string, before any production rules are applied.', h.input([
      h.Id('axiom'), h.Class('field'), h.Value(model.params.axiom), h.Spellcheck(false),
      h.Attribute('autocomplete', 'off'), h.AriaLabel('Axiom'), h.AriaDescribedBy('axiom-help'),
      h.OnInput(value => Message.ChangedAxiom({ value })), h.OnChange(() => Message.CommittedEdit()),
    ]), undefined, 'menu-content'),
    slider(h, { id: 'iterations', label: 'n', title: 'Iterations', help: 'Iterations (n): how many times the production rules rewrite the string. Higher values add detail.', value: model.params.iterations,
      range: ITERATIONS, format: String, toMessage: value => Message.ChangedIterations({ value }) }),
    slider(h, { id: 'angle', label: 'δ', title: 'Angle', help: 'Turn angle (δ): how far the turtle turns for each + or − command, in degrees.', value: model.params.angle,
      range: ANGLE, format: formatAngle, toMessage: value => Message.ChangedAngle({ value }) }),
    slider(h, { id: 'jitter', label: '±', title: 'Angle jitter', help: 'Angle jitter (±): adds seeded variation to each turn. Zero keeps every turn exact.', value: model.params.jitter,
      range: JITTER, format: value => `${Math.round(value * 100)}%`,
      toMessage: value => Message.ChangedJitter({ value }), extra: 'menu-content' }),
    row(h, 'seed', 'seed', 'Seed: controls random rules, angle jitter, and the season or blossom in Leaf. The same seed reproduces the same plant.', h.input([
      h.Id('seed'), h.Class('field'), h.Value(model.params.seed), h.Spellcheck(false),
      h.Attribute('autocomplete', 'off'), h.AriaLabel('Seed'), h.AriaDescribedBy('seed-help'),
      h.OnInput(value => Message.ChangedSeed({ value })), h.OnChange(() => Message.CommittedEdit()),
    ]), h.button([
      h.Type('button'), h.Class('icon-button reseed'), h.AriaLabel('New seed'), h.Title('New seed'),
      h.OnClick(Message.ClickedNewSeed()),
    ], [hairline(h, 'M9.5 5.5a4 4 0 1 1-1.2-2.8M9.5 1v2.5H7')]), 'menu-content'),
    h.div([h.Class('style-options'), h.Role('group'), h.AriaLabel('Style')], styles.map(style =>
      h.button([
        h.Type('button'), h.AriaPressed(String(model.renderStyle === style)), h.Title(styleTitles[style]),
        h.OnClick(Message.SelectedRenderStyle({ renderStyle: style })),
      ], [style]),
    )),
    ...(model.renderStyle === 'Leaf' ? [h.div([
      h.Class('style-options season-options'), h.Role('group'), h.AriaLabel('Season'),
    ], [
      h.button([h.Type('button'), h.AriaPressed(String(model.isSeasonAutomatic)),
        h.Title('Choose leaves, a seasonal palette, or blossom from the seed'),
        h.OnClick(Message.SelectedAutomaticSeason())], ['Auto']),
      ...(['Spring', 'Summer', 'Autumn'] as const).map(season => h.button([
        h.Type('button'), h.AriaPressed(String(!model.isSeasonAutomatic && model.season === season)),
        h.OnClick(Message.SelectedSeason({ season })),
      ], [season])),
    ])] : []),
  ])
}

const transport = (h: H, model: Model): Html => {
  const { playback } = model
  const [label, glyph] = playback.isPlaying ? ['Pause', PAUSE] : playback.progress >= 1 ? ['Replay', REPLAY] : ['Play', PLAY]
  return h.div([h.Class('transport'), h.Role('group'), h.AriaLabel('Playback')], [
    h.button([h.Type('button'), h.Class('icon-button'), h.AriaLabel(label), h.Title(label),
      h.OnClick(Message.ClickedTogglePlay())], [icon(h, glyph)]),
    h.input([
      h.Type('range'), h.Min('0'), h.Max('1'), h.Step('0.001'), h.Value(String(playback.progress)),
      h.AriaLabel('Growth'), h.AriaValuetext(`${Math.round(playback.progress * 100)}% grown`), h.Class('range growth-range'),
      h.OnInput(value => Message.ScrubbedProgress({ value: Number(value) })),
    ]),
    h.div([h.Class('reveal-options'), h.Role('group'), h.AriaLabel('Reveal')], (['Grow', 'Trace'] as const).map(mode =>
      h.button([h.Type('button'), h.AriaPressed(String(playback.mode === mode)),
        h.Title(mode === 'Grow' ? 'Every branch extends outward from the root' : 'Segments appear in drawing order'),
        h.OnClick(Message.SelectedMode({ mode }))], [mode.toLowerCase()]),
    )),
    h.output([h.Class('growth-readout'), h.AriaLabel('Growth progress')], [`${Math.round(playback.progress * 100)}%`]),
  ])
}

const actions = (h: H, model: Model): Html => {
  const preparing = model.printStatus === 'Preparing'
  return h.div([h.Class('actions menu-content')], [
    h.button([
      h.Type('button'), h.Title('Copy a link with this grammar and seed'), h.OnClick(Message.ClickedCopyLink()),
      h.AriaLabel(model.isLinkCopied ? 'Link copied' : 'Share this plant'),
    ], [model.isLinkCopied ? 'Copied' : 'Share']),
    h.button([
      h.Type('button'), h.Disabled(preparing || Option.isNone(model.shown)), h.AriaBusy(preparing),
      h.Title('Download an A3 PNG at 300 dpi, in ink on paper'), h.OnClick(Message.ClickedDownloadPrint()),
    ], [preparing ? `Printing ${Math.round(model.printProgress * 100)}%` : `Print ${model.printSize}`]),
    ...(model.printStatus === 'Failed' ? [h.p([h.Class('print-error'), h.Role('status')],
      ['The print could not be prepared. Try printing again.'])] : []),
    h.span([h.Class('sr-only'), h.Role('status')], [model.isLinkCopied ? 'Link copied to the clipboard' : '']),
  ])
}

const inscriptions = (h: H, model: Model): Html => {
  const [source, title, numbers] = inscriptionsOf(model)
  return h.div(
    [h.Class('inscriptions'), h.AriaHidden(true)],
    [
      h.span([h.Class('inscription inscription-source')], [source]),
      h.span([h.Class('inscription')], [title]),
      h.span([h.Class('inscription inscription-numbers')], [numbers]),
    ],
  )
}

// ZOOM

/** Keys on the focused plate: + and − zoom, 0 fits, arrows pan once zoomed
 *  (at the fitted view they scroll the page as usual). Browser shortcuts
 *  with Ctrl or ⌘ are left alone. */
const canvasKey = (camera: Camera, key: string, modifiers: KeyboardModifiers): Option.Option<Message> => {
  if (modifiers.ctrlKey || modifiers.metaKey || modifiers.altKey) return Option.none()
  switch (key) {
    case '+':
    case '=':
      return Option.some(Message.PressedZoomKey({ step: 'In' }))
    case '-':
    case '_':
      return Option.some(Message.PressedZoomKey({ step: 'Out' }))
    case '0':
      return Option.some(Message.PressedZoomKey({ step: 'Fit' }))
  }
  if (isFit(camera)) return Option.none()
  switch (key) {
    case 'ArrowLeft':
      return Option.some(Message.PressedPanKey({ step: 'Left' }))
    case 'ArrowRight':
      return Option.some(Message.PressedPanKey({ step: 'Right' }))
    case 'ArrowUp':
      return Option.some(Message.PressedPanKey({ step: 'Up' }))
    case 'ArrowDown':
      return Option.some(Message.PressedPanKey({ step: 'Down' }))
    default:
      return Option.none()
  }
}

/** − 100% + · Fit, set into the plate mark's top edge like a cartouche. */
const zoomControls = (h: H, camera: Camera): Html => {
  const fit = isFit(camera)
  const button = (label: string, title: string, disabled: boolean, message: Message, content: Html | string) =>
    h.button(
      [
        h.Type('button'),
        h.Class('zoom-button'),
        h.AriaLabel(label),
        h.Title(title),
        h.Disabled(disabled),
        h.OnClick(message),
      ],
      [content],
    )
  return h.div(
    [h.Class('zoom'), h.Role('group'), h.AriaLabel('Magnification')],
    [
      button('Zoom out', 'Zoom out (−)', fit, Message.ClickedZoom({ step: 'Out' }), hairline(h, MINUS)),
      h.output([h.Class('zoom-readout'), h.AriaLabel('Magnification')], [formatZoom(camera.zoom)]),
      button('Zoom in', 'Zoom in (+)', camera.zoom >= MAX_ZOOM - 1e-9, Message.ClickedZoom({ step: 'In' }), hairline(h, PLUS)),
      h.span([h.Class('zoom-rule'), h.AriaHidden(true)], []),
      button('Fit the plate', 'Fit the plate (0, or double-click)', fit, Message.ClickedZoom({ step: 'Fit' }), 'Fit'),
    ],
  )
}

const stage = (h: H, model: Model): Html => {
  const canvas = treeCanvas.withMessage(h)
  const shownBuildId = Option.match(model.shown, { onNone: () => -1, onSome: stats => stats.buildId })
  const title = findPreset(model.presetId)?.name ?? 'A plant from your own grammar'
  const appearance = appearanceOf(model)
  return h.figure([
    h.Class('stage'), h.DataAttribute('orientation', model.orientation),
    h.Style({ '--mark-ratio': String(MARK_RATIO[model.orientation]) }),
  ], [
    h.div([h.Class('sheet')], [
      canvas([
        canvas.BuildId(shownBuildId), canvas.Progress(model.playback.progress), canvas.Mode(model.playback.mode),
        canvas.RenderStyle(appearance.style), canvas.Season(appearance.season), canvas.Camera(model.camera),
        canvas.OnCameraMove(({ camera }) => Message.MovedCamera({ camera })),
        canvas.OnCameraSettle(({ camera }) => Message.SettledCamera({ camera })),
        h.OnDoubleClick(Message.DoubleClickedCanvas()),
        h.OnKeyDownPreventDefault((key, modifiers) => canvasKey(model.camera, key, modifiers)),
        h.Tabindex(0), h.Class('plate-canvas'), h.Role('img'), h.AriaRoleDescription('zoomable plate'),
        h.AriaLabel(`${title}, ${styleTitles[appearance.style]}, at ${formatZoom(model.camera.zoom)}`),
        h.AriaKeyshortcuts('+ - 0'),
        h.AriaDescription('Scroll or pinch to zoom, drag to pan, double-click to fit. Keys: plus and minus zoom, 0 fits, arrows pan.'),
      ]),
      h.div([h.Class('plate-mark'), h.AriaHidden(true)], []),
      zoomControls(h, model.camera), inscriptions(h, model),
    ]),
  ])
}

const about = (h: H): Html => h.details([h.Class('about')], [
  h.summary([h.Title('About Tree Garden')], ['About']),
  h.div([h.Class('about-panel')], [
    h.p([], ['Grammars after Prusinkiewicz & Lindenmayer, The Algorithmic Beauty of Plants (1990). Branch thickness follows the pipe model.']),
    h.p([], ['Scroll or pinch to zoom, drag to pan, double-click to fit.']),
  ]),
])

const header = (h: H, model: Model): Html => h.header([h.Class('topbar')], [
  h.h1([], ['Tree Garden']),
  h.p([h.Class('build-stats'), h.AriaLive('polite')], [Option.match(model.shown, {
    onNone: () => 'Growing…',
    onSome: stats => `${formatCount(stats.segmentCount)} segments · ${stats.elapsedMs.toFixed(1)} ms`,
  })]),
  about(h),
  h.button([
    h.Type('button'), h.Class('theme-toggle'), h.Role('switch'), h.AriaLabel('Dark mode'),
    h.Attribute('aria-checked', String(model.theme === 'Dark')),
    h.Title(`Switch to ${model.theme === 'Dark' ? 'light' : 'dark'} mode`), h.OnClick(Message.ClickedToggleTheme()),
  ], [h.span([h.Class('theme-symbol'), h.AriaHidden(true)], ['◐'])]),
  h.button([
    h.Type('button'), h.Class('icon-button menu-toggle'), h.AriaLabel('More controls'),
    h.AriaExpanded(model.isMenuOpen), h.AriaControls('controls'),
    h.OnClick(Message.ClickedToggleMenu()),
  ], [model.isMenuOpen ? '×' : '⋯']),
])

export const view = (model: Model, h: H): Document => ({
  title: 'Tree Garden · L-systems',
  body: h.main([h.Class('garden'), h.DataAttribute('menu-open', String(model.isMenuOpen))], [
    header(h, model), stage(h, model), transport(h, model), controls(h, model), actions(h, model),
    ...Option.match(model.shown, {
      onNone: () => [],
      onSome: stats => stats.truncated ? [h.p([h.Class('build-notice'), h.Role('status')],
        [`Stopped at n = ${stats.iterationsApplied} of ${model.params.iterations}: the next iteration would exceed two million symbols.`])] : [],
    }),
  ]),
})
