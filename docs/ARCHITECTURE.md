# Architecture notes

How the app's moving parts fit together: the sheet and page layout, print
export, generation in a worker, and zoom and pan. The README has the
overview; [RENDERING.md](RENDERING.md) has the painting techniques and the
lessons behind them.

## The sheet and the page layout

**The sheet** (`render/sheet.ts`). Every plate is an A-series sheet,
portrait, or landscape for a plant at least 1.1× wider than tall
(`orientationOf`; of the presets, Koch's snowflake and the Conifer). The
screen and the print share it: the on-screen sheet is sized (styles.css,
from `MARK_RATIO`) so its plate mark has exactly the print's proportions,
and `plateMargins` keeps the same room inside the mark on both, head
room by the mark's height and side room by its width. What you see is
what you print, short of the print's wider paper margins.

The page (`ui/view.ts`, `.garden` in styles.css) is a full-height grid:
a 48px top bar, a plate beside a 320px control rail, and 48px playback
and action bars. The rail scrolls independently; the sheet fits the stage
using size-container units while keeping its plate-mark proportions.
At 800px and below, the plate, playback and controls stack. The ⋯ button
reveals the grammar, axiom, jitter, seed and actions.

The icon in the top bar selects Light or Dark. `ui/theme.ts` persists the
choice locally and applies `data-theme` to the document root; a first
visit defaults to Dark. The canvas observes that attribute and rereads
its CSS palette. Ink compositing follows CSS `color-scheme`, including
when it differs from the operating system. Print palettes stay fixed.

Leaf offers manual Spring, Summer and Autumn palettes, plus Auto.
`ui/appearance.ts` derives Auto's seasonal leaves or blossom from the
seed; screen and export use the same resolved appearance. Manual choices
persist across seed changes. The interface font is locally bundled
Instrument Sans; grammar and numeric readouts remain monospace.

The sheet turns only at quiet moments, never under the finger. The Model
keeps `orientation` and `isEditing`: a slider drag or typing in a field
leaves the sheet as it is; releasing the slider or leaving the field
(`CommittedEdit`), a new plant, or a new seed lets it turn, once the
build has landed and as long as the view is fitted. Zoomed in, the turn
waits until the view goes back to Fit, so the camera never has to be
carried across a change of shape. Playback never moves the plant: it is
fitted to the finished build.

## Print export

**Print** (`render/print.ts`, Command `DownloadPrint`). A PNG at 300 dpi
on A3 (3508 × 4961 px; the renderer also supports A4 and A2), portrait or landscape by the
plant's shape (`orientationOf`, the same as the screen's sheet, taken
from the plant so the same link always prints the same way, even while
the screen's turn waits for a zoom to end), always ink on paper. It is the screen's renderer at a
higher `dpr` (the sheet is ~1100 CSS px on its long side, so proportions
match the screen) and a higher `detail` (fine bark and stamens show). It
paints in bands of ~2.5 Mpx (`printBands`), then adds the plate mark (a
plate tone and a bevelled edge) and pencilled inscriptions with the
seed; the file carries a pHYs chunk so it opens at 300 dpi. Same link,
style, season and size give the same print, byte for byte.

- *Off the main thread.* The print is painted and encoded in a module
  Web Worker on OffscreenCanvas (`render/print.worker.ts`, driven by
  `render/printClient.ts`), so the page never stalls; the PNG comes back
  as a Blob for the download. The request goes by value: a copy of the
  geometry's typed arrays, transferred (a few ms for 350K segments;
  rebuilding the plant in the worker would cost the generator's ~60 ms),
  and the print's palette is the fixed ink-on-paper one, which reads no
  CSS. Every painter gets its canvases from `makeCanvas`
  (`render/canvas.ts`): an OffscreenCanvas in the worker, a `<canvas>` on
  the page, so the screen paints exactly as before.
- *One at a time.* One long-lived worker, started by the first print,
  and prints queued, never overlapping: two prints at once compete for
  canvas memory, and under that pressure Chrome can fall back from GPU to
  software raster partway through, which changes the bytes.
- *Every print the same.* Each print paints its own copy of the geometry,
  so per-geometry caches start afresh: a first draw of a freshly computed
  density wash differs by a level or two from a redraw of the cached
  one, which used to make the second print of a plant differ from the
  first.
- *Progress.* The worker reports each band; `PaintedPrintBand` puts it in
  the Model (`printProgress`) and the button counts it up.
- *Fallback.* Without Worker or OffscreenCanvas, if the worker fails to
  load, or if its contexts lack `filter` where the page's canvas has it
  (Safari: OffscreenCanvas 2D since 16.4, `filter` only behind a flag),
  the print is painted on the main thread as before, yielding between
  bands, with the same bytes.
- *Bands shape the bytes.* Each band is painted translated by its top
  row, and float rounding of that translation reaches the anti-aliasing,
  so a different band height gives a different file (on an A3, 6–7% of
  the pixels, nearly all by one level of 255). Taller bands would mean
  fewer walks of the tree, but they are kept as they are so a link keeps
  printing the same file.

Performance, headless Chrome at DPR 2 on an M4, twigs on the GPU: Twig
n=11 (350K segments) plays at ~58 fps (draft frames) and its finished
plate paints in ~70 ms (Ink) / ~95 ms (Leaf) / ~10 ms (Line); Weed n=8
(391K) plays at ~52–55 fps, finished in ~37 / ~47 / ~9 ms; up to ~120K
segments play at 60 fps. The crisp repaint after a gesture is painted in
slices of ~12 ms (see Zoom and pan), so it lands ~200–350 ms after the
gesture with no task over ~40 ms, even deep inside the 350K crown. An A3
print of Twig n=11 (Leaf) takes ~1.2–1.6 s and A2 ~2–2.5 s, in the
worker: no long task on the main thread and no frame longer than ~17 ms

## Generation off the main thread

`generateLSystem` (engine/lsystem.ts) runs the whole build in a Web Worker
(`engine/lsystem.worker.ts`): parse, rewrite, turtle, and the branch
topology (radii, chains, subtree ranges) that the first paint needs.

- **Started at load.** `entry.ts` starts the worker before the app boots,
  and the worker warms its JIT on two small plants, so its start-up is
  hidden and the first real build runs optimised code.
- **Nothing copied.** The typed arrays come back as transferables, and the
  topology goes into the GeometryStore's cache with the geometry, so the
  first paint doesn't compute it again.
- **Same link, same plant, on any thread.** The worker seeds Effect's
  `Random` with `Random.withSeed(seed)` exactly as the main thread did.
- **The newest build wins.** A new request supersedes the one in flight:
  its Effect fails with `Superseded` at once (the Command reports
  `SupersededGenerate`, a no-op), and the worker drops the old build at
  its next stage boundary (after each rewriting iteration, every ~256K
  symbols of the turtle's walk, before the topology, before posting),
  returning to its event loop through a MessageChannel to hear about it.
  Measured, this beats terminating and respawning the worker: a fresh
  worker costs ~15–25 ms to start and its first big build runs ~1.5×
  slower on a cold JIT. While a slider is dragged over a huge plant, the
  plant updates when the drag pauses for about one build's time.
- **Fallback.** Without `Worker` (vitest, happy-dom) or if it fails to
  load, the same build runs inline.
- **The generator itself** (core/lsystem/compiled.ts) never builds the
  derived string: symbols become byte ids, a deterministic grammar is
  walked depth first straight from its productions (symbol counts come
  from per-symbol count vectors), and a stochastic one is rewritten over
  byte buffers, drawing in the same order as before.

"Grown in" is the work itself, wherever it ran: generation plus topology;
its tooltip splits the two.

Measured (headless Chrome, DPR 2, production build, Twig n=11 and Weed
n=8): the main thread no longer runs any long task before the first paint
(~210 ms before), a rebuild's only long task is the paint itself, and a
Line rebuild of the weed has no long task at all (65 ms before).

## Zoom and pan

The plate can be inspected like a print under a loupe, from the fitted
view (100%) to 3200%: scroll or pinch to zoom towards the pointer, drag
(or two fingers) to pan, double-click or **Fit** to go back. With the plate
focused, `+` and `−` zoom by octaves, `0` fits and the arrow keys pan.

- **State.** The camera (`render/camera.ts`) is three numbers in the Model:
  `zoom` and the plate point at the centre, in plate-normalised
  coordinates (0..1 across and down the fitted plate), so it survives
  resizes and rebuilds. A sheet keeps its proportions at every window
  size, so a resize only scales the view; the sheet changes shape only
  at the fitted view (see The sheet, above). All the math is pure and unit-tested there
  (zoom about a point, pan, clamping, steps). A new plant (preset, Reseed)
  resets it; edits keep it, because the plant is refitted and the same
  camera still looks at about the same part of it. It is not in the link.
- **Gestures** are handled by `<tree-canvas>`, which shows each step at
  once and reports it upward as a `camera-move` event at most once a frame
  (`MovedCamera`, left out of DevTools history) and `camera-settle` at the
  end (`SettledCamera`). The round-trip through update holds 60 fps. The
  element recognises its own reports when they come back as the `camera`
  property; any other new camera (buttons, keys, time travel) is eased to.
- **Crisp at every zoom.** While the camera moves, cached pictures are
  stretched; ~130 ms after it stops, the visible part of the plate is
  painted again, in slices: `beginPlate` and `beginInk` (render/plate.ts,
  render/inkBrush.ts) walk the stroke chains until a deadline and lay
  everything down at the end, and `<tree-canvas>` runs them 12 ms per
  task, the paper and the seal in tasks of their own, starting a limb in
  a fresh task. A gesture, a resize or any other paint cancels it. The
  picture that lands is the one painting it at once would give. Painters build their paths in *plate pixels* (device
  pixels of the fitted view) under the view's transform (`Frame.view`), so
  strokes, rims, leaves and fibres are the same marks magnified: the trunk
  is genuinely wider. Brush outlines are resampled so they keep a point
  every 3.5 screen px, twigs that grow wide on screen become brush strokes
  in their own tone, and everything off screen is culled. Paper grain,
  the brush's tooth and the ink's bleed are texture: they stay anchored to
  the sheet but grow only as `zoom^(1/3)`.
- **The frame stays put.** The plate mark, the inscriptions and the zoom
  cartouche are DOM overlays; the ink is clipped to the plate mark (read
  from the same `--plate-mark-*` CSS variables).

At 350K segments, the crisp repaint after a gesture takes ~50–230 ms of
work spread over tasks of at most ~40 ms, and gestures, including during
playback, stay at 60 fps.

