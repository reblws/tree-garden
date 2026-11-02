import { Option } from 'effect'
import type { Document, Html, HtmlBuilder, KeyboardModifiers } from 'foldkit/html'

import { ANGLE, ITERATIONS, JITTER } from '../params/lsystem'
import { findPreset, presets } from '../params/presets'
import { type Camera, MAX_ZOOM, formatZoom, isFit } from '../render/camera'
import { type PrintSize, printPixels } from '../render/print'
import type { RenderStyle } from '../render/renderStyle'
import type { RevealMode } from '../render/revealMode'
import type { Season } from '../render/season'
import { MARK_RATIO } from '../render/sheet'
import { treeCanvas } from '../render/treeCanvas'
import { formatAngle, inscriptionsOf } from './inscriptions'
import { Message } from './message'
import type { BuildStats, Model } from './model'

type H = HtmlBuilder<Message>

const formatCount = (n: number) => n.toLocaleString('en-US')

// ICONS
//
// Drawn at 12px on a 12-unit grid, filled with the current text colour.

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

// CONTROLS

const field = (h: H, label: string, id: string, control: Html, aside?: Html): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex items-baseline justify-between gap-3')],
        [
          h.label([h.For(id), h.Class('font-serif text-[15px] text-ink')], [label]),
          ...(aside === undefined ? [] : [aside]),
        ],
      ),
      control,
    ],
  )

const hint = (h: H, text: string): Html => h.p([h.Class('font-sans text-[11.5px] leading-snug text-ink-3')], [text])

interface SliderConfig {
  readonly id: string
  readonly label: string
  readonly value: number
  readonly range: { readonly min: number; readonly max: number; readonly step: number }
  readonly format: (value: number) => string
  readonly toMessage: (value: number) => Message
}

const slider = (h: H, config: SliderConfig): Html =>
  field(
    h,
    config.label,
    config.id,
    h.input([
      h.Id(config.id),
      h.Type('range'),
      h.Min(String(config.range.min)),
      h.Max(String(config.range.max)),
      h.Step(String(config.range.step)),
      h.Value(String(config.value)),
      h.Class('range'),
      h.OnInput(value => config.toMessage(Number(value))),
      h.OnChange(() => Message.CommittedEdit()),
    ]),
    h.output(
      [h.For(config.id), h.Class('font-mono text-[12px] tabular-nums text-ink-2')],
      [config.format(config.value)],
    ),
  )

const section = (h: H, title: string, children: ReadonlyArray<Html>): Html =>
  h.section(
    [h.Class('flex flex-col gap-5')],
    [h.h2([h.Class('caps section-head')], [title]), ...children],
  )

const presetSelect = (h: H, model: Model): Html =>
  field(
    h,
    'Preset',
    'preset',
    h.select(
      [h.Id('preset'), h.Class('field'), h.OnChange(presetId => Message.SelectedPreset({ presetId }))],
      [
        ...(model.presetId === '' ? [h.option([h.Value(''), h.Selected(true)], ['Custom grammar'])] : []),
        ...presets.map(preset =>
          h.option([h.Value(preset.id), h.Selected(preset.id === model.presetId)], [preset.name]),
        ),
      ],
    ),
  )

/** Parse errors, set apart by a bar of ink rather than by colour. */
const errorList = (h: H, model: Model): Html =>
  h.ul(
    [h.Id('rules-errors'), h.Class('flex flex-col gap-1.5 empty:hidden'), h.AriaLive('polite')],
    model.errors.map(error =>
      h.li(
        [h.Class('border-l-[3px] border-ink pl-2.5 font-serif text-[14px] leading-snug text-ink')],
        [h.span([h.Class('font-sans text-[11px] font-semibold uppercase tracking-[0.12em]')], [`Line ${error.line}`]), ' ', h.em([], [error.message])],
      ),
    ),
  )

const controls = (h: H, model: Model): Html => {
  const hasErrors = model.errors.length > 0
  return h.aside(
    [h.Class('flex flex-col gap-10'), h.AriaLabel('Parameters')],
    [
      section(h, 'Specimen', [presetSelect(h, model)]),
      plateSection(h, model),
      section(h, 'Grammar', [
        field(
          h,
          'Axiom',
          'axiom',
          h.input([
            h.Id('axiom'),
            h.Value(model.params.axiom),
            h.Spellcheck(false),
            h.Attribute('autocomplete', 'off'),
            h.Class('field'),
            h.OnInput(value => Message.ChangedAxiom({ value })),
            h.OnChange(() => Message.CommittedEdit()),
          ]),
        ),
        h.div(
          [h.Class('flex flex-col gap-2')],
          [
            field(
              h,
              'Productions',
              'rules',
              h.textarea([
                h.Id('rules'),
                h.Value(model.params.rules),
                h.Rows(5),
                h.Spellcheck(false),
                h.Class('field'),
                h.AriaInvalid(hasErrors),
                h.AriaDescribedBy('rules-hint rules-errors'),
                h.OnInput(value => Message.ChangedRules({ value })),
                h.OnChange(() => Message.CommittedEdit()),
              ]),
            ),
            h.p(
              [h.Id('rules-hint'), h.Class('font-sans text-[11.5px] leading-snug text-ink-3')],
              ['One per line. ', h.code([h.Class('font-mono text-ink-2')], ['A (0.5) -> …']), ' for a weighted, random choice.'],
            ),
            errorList(h, model),
          ],
        ),
      ]),
      section(h, 'Growth', [
        slider(h, {
          id: 'iterations',
          label: 'Iterations',
          value: model.params.iterations,
          range: ITERATIONS,
          format: value => `n = ${value}`,
          toMessage: value => Message.ChangedIterations({ value }),
        }),
        slider(h, {
          id: 'angle',
          label: 'Angle δ',
          value: model.params.angle,
          range: ANGLE,
          format: formatAngle,
          toMessage: value => Message.ChangedAngle({ value }),
        }),
        slider(h, {
          id: 'jitter',
          label: 'Angle jitter',
          value: model.params.jitter,
          range: JITTER,
          format: value => `± ${Math.round(value * 100)}%`,
          toMessage: value => Message.ChangedJitter({ value }),
        }),
        h.div(
          [h.Class('flex flex-col gap-2')],
          [
            field(
              h,
              'Seed',
              'seed',
              h.div(
                [h.Class('flex gap-2')],
                [
                  h.input([
                    h.Id('seed'),
                    h.Value(model.params.seed),
                    h.Spellcheck(false),
                    h.Attribute('autocomplete', 'off'),
                    h.Class('field min-w-0'),
                    h.AriaDescribedBy('seed-hint'),
                    h.OnInput(value => Message.ChangedSeed({ value })),
                    h.OnChange(() => Message.CommittedEdit()),
                  ]),
                  h.button(
                    [h.Type('button'), h.Class('btn h-auto shrink-0'), h.OnClick(Message.ClickedNewSeed())],
                    ['Reseed'],
                  ),
                ],
              ),
            ),
            h.p(
              [h.Id('seed-hint'), h.Class('font-sans text-[11.5px] leading-snug text-ink-3')],
              ['Drives the random rules and the jitter.'],
            ),
          ],
        ),
      ]),
      h.div(
        [h.Class('flex flex-col gap-2 border-t border-rule pt-6')],
        [
          h.button(
            [h.Type('button'), h.Class('btn w-full'), h.OnClick(Message.ClickedCopyLink())],
            [model.isLinkCopied ? 'Link copied to the clipboard' : 'Copy a link to this plant'],
          ),
          hint(h, 'The link holds the grammar and the seed: the same link grows the same plant.'),
        ],
      ),
      printSection(h, model),
    ],
  )
}

const PRINT_SIZES: ReadonlyArray<{ readonly value: PrintSize; readonly title: string }> = (['A4', 'A3', 'A2'] as const).map(
  value => {
    const { width, height } = printPixels(value)
    return { value, title: `${value} at 300 dpi: ${formatCount(width)} × ${formatCount(height)} px` }
  },
)

/** The print: a sheet size and a button. The plate is painted off screen
 *  at 300 dpi with its margins, plate mark and inscriptions. */
const printSection = (h: H, model: Model): Html => {
  const isPreparing = model.printStatus === 'Preparing'
  const { width, height } = printPixels(model.printSize)
  return h.div(
    [h.Class('flex flex-col gap-3 border-t border-rule pt-6')],
    [
      h.div(
        [h.Class('flex items-center justify-between gap-3')],
        [
          h.span([h.Class('font-serif text-[15px] text-ink')], ['Print']),
          segmented(h, 'Sheet', PRINT_SIZES, model.printSize, size => Message.SelectedPrintSize({ size })),
        ],
      ),
      h.button(
        [
          h.Type('button'),
          h.Class('btn w-full'),
          h.Disabled(isPreparing || Option.isNone(model.shown)),
          h.AriaBusy(isPreparing),
          h.OnClick(Message.ClickedDownloadPrint()),
        ],
        [isPreparing ? `Painting the print… ${Math.round(model.printProgress * 100)}%` : `Download the print · ${model.printSize}`],
      ),
      model.printStatus === 'Failed'
        ? h.p(
            [h.Class('border-l-[3px] border-ink pl-2.5 font-serif text-[14px] italic leading-snug text-ink'), h.Role('status')],
            ['The browser couldn’t paint a sheet this large. Try a smaller one.'],
          )
        : hint(
            h,
            `A PNG at 300 dpi, ${formatCount(width)} × ${formatCount(height)} px, with margins, plate mark and inscriptions; the same link and style always print the same.`,
          ),
    ],
  )
}

// THE PLATE

const segmented = <A extends string>(
  h: H,
  label: string,
  options: ReadonlyArray<{ readonly value: A; readonly title: string }>,
  current: A,
  toMessage: (value: A) => Message,
  rowClass = 'flex items-center gap-2.5',
): Html =>
  h.div(
    [h.Class(rowClass)],
    [
      h.span([h.Class('caps'), h.AriaHidden(true)], [label]),
      h.div(
        [h.Class('segmented'), h.Role('group'), h.AriaLabel(label)],
        options.map(option =>
          h.button(
            [
              h.Type('button'),
              h.AriaPressed(String(option.value === current)),
              h.Title(option.title),
              h.OnClick(toMessage(option.value)),
            ],
            [option.value],
          ),
        ),
      ),
    ],
  )

const REVEAL_OPTIONS: ReadonlyArray<{ readonly value: RevealMode; readonly title: string }> = [
  { value: 'Grow', title: 'Every branch extends outward from the root at once' },
  { value: 'Trace', title: 'Segments appear in the order the turtle draws them' },
]

const STYLE_OPTIONS: ReadonlyArray<{ readonly value: RenderStyle; readonly title: string }> = [
  { value: 'Leaf', title: 'Ink brush with a watercolour wash of leaves at the tips' },
  { value: 'Blossom', title: 'Ink brush with plum blossom and buds at the tips' },
  { value: 'Ink', title: 'A tapering ink brush; branch thickness follows the pipe model' },
  { value: 'Line', title: 'A plain technical pen that shows the structure' },
]

const SEASON_OPTIONS: ReadonlyArray<{ readonly value: Season; readonly title: string }> = [
  { value: 'Spring', title: 'Fresh, pale yellow-greens' },
  { value: 'Summer', title: 'Deep sap and olive greens' },
  { value: 'Autumn', title: 'Ochre, madder and russet' },
]

const STYLE_DESCRIPTIONS: Record<RenderStyle, string> = {
  Leaf: 'painted in ink with a wash of leaves',
  Blossom: 'painted in ink with plum blossom',
  Ink: 'painted in ink',
  Line: 'drawn in line',
}

/** Play and the growth scrubber, under the sheet and as wide as it. */
const transport = (h: H, model: Model): Html => {
  const { playback } = model
  const isDone = playback.progress >= 1
  const [label, glyph] = playback.isPlaying ? ['Pause', PAUSE] : isDone ? ['Replay', REPLAY] : ['Play', PLAY]
  return h.div(
    [h.Class('transport flex items-center gap-4')],
    [
      h.button(
        [h.Type('button'), h.Class('btn btn-solid w-[6.5rem] shrink-0'), h.OnClick(Message.ClickedTogglePlay())],
        [icon(h, glyph), label],
      ),
      h.input([
        h.Type('range'),
        h.Min('0'),
        h.Max('1'),
        h.Step('0.001'),
        h.Value(String(playback.progress)),
        h.AriaLabel('Growth'),
        h.AriaValuetext(`${Math.round(playback.progress * 100)}% grown`),
        h.Class('range min-w-0 flex-1'),
        h.OnInput(value => Message.ScrubbedProgress({ value: Number(value) })),
      ]),
    ],
  )
}

/** How the plate is revealed and painted: a label column and the choices,
 *  aligned down the rail. */
const PLATE_ROW = 'grid grid-cols-[4.75rem_auto] items-center justify-start'

const plateSection = (h: H, model: Model): Html =>
  section(h, 'Plate', [
    h.div(
      [h.Class('flex flex-col gap-3')],
      [
        segmented(h, 'Reveal', REVEAL_OPTIONS, model.playback.mode, mode => Message.SelectedMode({ mode }), PLATE_ROW),
        segmented(h, 'Style', STYLE_OPTIONS, model.renderStyle, renderStyle => Message.SelectedRenderStyle({ renderStyle }), PLATE_ROW),
        ...(model.renderStyle === 'Leaf'
          ? [segmented(h, 'Season', SEASON_OPTIONS, model.season, season => Message.SelectedSeason({ season }), PLATE_ROW)]
          : []),
      ],
    ),
  ])

const dot = (h: H): Html => h.span([h.Class('text-rule-strong'), h.AriaHidden(true)], ['·'])

/** What "grown in" counts, for its tooltip. */
const growthBreakdown = (stats: BuildStats): string =>
  stats.topologyMs === undefined
    ? 'Parse, rewrite, turtle and branch topology'
    : `Parse, rewrite and turtle ${(stats.elapsedMs - stats.topologyMs).toFixed(1)} ms, branch topology ${stats.topologyMs.toFixed(1)} ms`

const statsLine = (h: H, stats: BuildStats, requested: number): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.p(
        [h.Class('flex flex-wrap gap-x-2.5 gap-y-1 font-mono text-[11.5px] tabular-nums text-ink-3')],
        [
          h.span([], [`n = ${stats.iterationsApplied}`]),
          dot(h),
          h.span([], [`${formatCount(stats.symbolCount)} symbols`]),
          dot(h),
          h.span([], [`${formatCount(stats.segmentCount)} segments`]),
          dot(h),
          h.span([h.Title(growthBreakdown(stats))], [`grown in ${stats.elapsedMs.toFixed(1)} ms`]),
        ],
      ),
      ...(stats.truncated
        ? [
            h.p(
              [h.Class('font-serif text-[14px] italic text-ink-2'), h.Role('status')],
              [
                h.span([h.Class('not-italic text-ink'), h.AriaHidden(true)], ['※ ']),
                `Stopped at n = ${stats.iterationsApplied} of ${requested}: one more step would pass two million symbols.`,
              ],
            ),
          ]
        : []),
    ],
  )

const derivedString = (h: H, stats: BuildStats): Html =>
  h.details(
    [h.Class('disclosure border-t border-rule pt-4')],
    [
      h.summary([], [h.span([h.Class('caps text-ink-2')], ['Derived string'])]),
      h.pre(
        [
          h.Class(
            'mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-[2px] border border-rule bg-field ' +
              'p-3 font-mono text-[11.5px] leading-relaxed text-ink-2',
          ),
        ],
        [stats.preview + (stats.symbolCount > stats.preview.length ? ' …' : '')],
      ),
    ],
  )

/** Pencilled titles in the sheet's lower margin, as on a print: the
 *  title always whole in the middle, the source and the numbers giving way
 *  on a narrow sheet (see `.inscriptions` in styles.css). */
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

/**
 * The stage: the sheet, as tall as the window allows, turned to suit the
 * plant (`model.orientation`), with the transport under it. styles.css
 * sizes the sheet from the orientation so its plate mark has the print's
 * proportions.
 */
const stage = (h: H, model: Model): Html => {
  const canvas = treeCanvas.withMessage(h)
  const shownBuildId = Option.match(model.shown, { onNone: () => -1, onSome: stats => stats.buildId })
  const title = findPreset(model.presetId)?.name ?? 'A plant from your own grammar'
  return h.figure(
    [
      h.Class('stage'),
      h.DataAttribute('orientation', model.orientation),
      h.Style({ '--mark-ratio': String(MARK_RATIO[model.orientation]) }),
    ],
    [
      h.div(
        [h.Class('sheet')],
        [
          canvas([
            canvas.BuildId(shownBuildId),
            canvas.Progress(model.playback.progress),
            canvas.Mode(model.playback.mode),
            canvas.RenderStyle(model.renderStyle),
            canvas.Season(model.season),
            canvas.Camera(model.camera),
            canvas.OnCameraMove(({ camera }) => Message.MovedCamera({ camera })),
            canvas.OnCameraSettle(({ camera }) => Message.SettledCamera({ camera })),
            h.OnDoubleClick(Message.DoubleClickedCanvas()),
            h.OnKeyDownPreventDefault((key, modifiers) => canvasKey(model.camera, key, modifiers)),
            h.Tabindex(0),
            h.Class('absolute inset-0'),
            h.Role('img'),
            h.AriaRoleDescription('zoomable plate'),
            h.AriaLabel(`${title}, ${STYLE_DESCRIPTIONS[model.renderStyle]}, at ${formatZoom(model.camera.zoom)}`),
            h.AriaKeyshortcuts('+ - 0'),
            h.AriaDescription('Scroll or pinch to zoom, drag to pan, double-click to fit. Keys: plus and minus zoom, 0 fits, arrows pan.'),
          ]),
          h.div([h.Class('plate-mark'), h.AriaHidden(true)], []),
          zoomControls(h, model.camera),
          inscriptions(h, model),
        ],
      ),
      transport(h, model),
    ],
  )
}

/** What the build came to: its numbers and the start of its string. */
const record = (h: H, model: Model): ReadonlyArray<Html> =>
  Option.match(model.shown, {
    onNone: () => [],
    onSome: stats => [
      section(h, 'Record', [statsLine(h, stats, model.params.iterations), derivedString(h, stats)]),
    ],
  })



// PAGE

const token = (h: H, text: string): Html =>
  h.code([h.Class('font-mono text-[0.84em] whitespace-nowrap not-italic text-ink')], [text])

const masthead = (h: H): Html =>
  h.header(
    [h.Class('masthead flex flex-col gap-3')],
    [
      h.div(
        [h.Class('flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1.5')],
        [
          h.p([h.Class('caps')], ['Algorithms that grow trees']),
          h.p([h.Class('caps hidden sm:block')], ['No. 1 · Lindenmayer systems']),
        ],
      ),
      h.h1([h.Class('font-serif text-[40px] leading-[0.95] font-normal tracking-[-0.015em] sm:text-[46px]')], ['Tree Garden']),
    ],
  )

/** What an L-system is, in a sentence: beside the title in the rail, or
 *  under the plate on a narrow screen. */
const lede = (h: H): Html =>
  h.p(
    [h.Class('lede max-w-[34rem] font-serif text-[15.5px] leading-relaxed text-ink-2')],
    [
      'A grammar rewrites its axiom in parallel ',
      h.em([], ['n']),
      ' times; a turtle then reads the result as drawing commands: ',
      token(h, 'F'),
      ' draws, ',
      token(h, '+ −'),
      ' turn by δ, ',
      token(h, '[ ]'),
      ' start and end a branch.',
    ],
  )

const colophon = (h: H): Html =>
  h.footer(
    [h.Class('border-t border-rule pt-6 font-serif text-[13.5px] italic leading-relaxed text-ink-3')],
    [
      'Grammars after Prusinkiewicz & Lindenmayer, ',
      h.span([h.Class('not-italic')], ['The Algorithmic Beauty of Plants']),
      ' (1990). Branch thickness by the pipe model: at every fork the parent’s cross-section matches its children’s.',
    ],
  )

/**
 * The folio (styles.css): on a wide screen, the stage holds the left of
 * the page at the window's height while the rail beside it (masthead,
 * controls, record) scrolls; on a narrow one they stack, the sheet first.
 */
export const view = (model: Model, h: H): Document => ({
  title: 'Tree Garden · L-systems',
  body: h.div(
    [h.Class('min-h-screen bg-page font-sans text-ink')],
    [
      h.main(
        [h.Class('folio')],
        [
          masthead(h),
          lede(h),
          stage(h, model),
          h.div([h.Class('rail flex flex-col gap-10')], [controls(h, model), ...record(h, model), colophon(h)]),
        ],
      ),
    ],
  ),
})
