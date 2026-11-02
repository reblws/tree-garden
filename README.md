# Tree Garden

Interactive showcase of algorithms that grow literal trees. It starts with a
2D L-system playground built on [Foldkit](https://foldkit.dev) and
[Effect](https://effect.website).

```sh
pnpm install
pnpm dev           # http://localhost:5173
pnpm test          # vitest: core, URL codec, Foldkit story tests
pnpm typecheck
pnpm build
```

## Deployment

Every push to `main` runs the tests, builds with `--base=/tree-garden/` and
publishes to GitHub Pages: https://reblws.github.io/tree-garden/ (see
`.github/workflows/pages.yml`). A failing test skips the deploy.

## Layout

```
src/
  core/          pure TypeScript, no Effect, no DOM; the hot loops live here
    geometry.ts    Segments2D: typed-array branch segments shared by all 2D generators
    branching.ts   pipe-model radii and stroke chains from the parent links
    lsystem/       grammar parsing + parallel rewriting, turtle interpretation
  params/        Effect Schema per algorithm: Model type, URL codec, slider ranges; presets
  engine/        Effect at the edges: seeded Random, geometry store keyed by build id
  render/        <tree-canvas> custom element: imperative Canvas2D renderer
  ui/            Foldkit app: model, messages, update, commands, subscriptions, view
```

## Rendering

`Segments2D` carries a `parent` link per segment (the turtle pushes and pops
the last segment it drew on `[` and `]`). From it, `core/branching.ts`
derives, in pure and unit-tested loops:

- **Pipe-model radii** (Leonardo's rule): `r_parent^e = Σ r_child^e`, tips = 1,
  `e = 2.3`. During playback only the visible part counts, so the trunk
  thickens as the crown appears.
- **Stroke chains**: from every fork the stroke continues into the heaviest
  child; the other children start chains of their own. A chain is painted
  as one tapering brush stroke.

`<tree-canvas>` paints the plate in one of four styles (`RenderStyle`,
a Model field, not part of the link):

| Style     | What it paints |
| --------- | -------------- |
| `Leaf`    | ink brush plus a watercolour wash of leaves, in a `Season` palette (Spring, Summer, Autumn) |
| `Blossom` | ink brush plus plum blossom, buds and fallen petals |
| `Ink`     | the ink brush alone |
| `Line`    | a plain technical pen in four weights (no ground, no seal) |

`render/plate.ts` is shared by the screen and the print: it places the
plant (resting low, set across by the centre of its ink rather than its
box, so a leaning crown keeps air on the side it reaches to; a figure
with no ground, such as Koch or Hilbert, sits at the optical centre),
builds the Frame, and lays the layers together: paper, colour wash, ink,
seal.

**The sheet** (`render/sheet.ts`). Every plate is an A-series sheet,
portrait, or landscape for a plant at least 1.1× wider than tall
(`orientationOf`; of the presets, Koch's snowflake and the Conifer). The
screen and the print share it: the on-screen sheet is sized (styles.css,
from `MARK_RATIO`) so its plate mark has exactly the print's proportions,
and `plateMargins` keeps the same room inside the mark on both, head
room by the mark's height and side room by its width. What you see is
what you print, short of the print's wider paper margins.

The page is a folio (`ui/view.ts`, `.folio` in styles.css). On a wide
screen the stage holds the left of the page: the sheet as tall as the
window allows (never under 32rem, a shorter window scrolls; a landscape
sheet at most 1100px wide), with Play and the growth scrubber under it,
held in place while the rail beside it scrolls (masthead, specimen, plate
style, grammar, growth, link, print, record). On a narrow screen they
stack, the sheet straight after the title.

The sheet turns only at quiet moments, never under the finger. The Model
keeps `orientation` and `isEditing`: a slider drag or typing in a field
leaves the sheet as it is; releasing the slider or leaving the field
(`CommittedEdit`), a new plant, or a new seed lets it turn, once the
build has landed and as long as the view is fitted. Zoomed in, the turn
waits until the view goes back to Fit, so the camera never has to be
carried across a change of shape. Playback never moves the plant: it is
fitted to the finished build.

**The ink brush** (`render/inkBrush.ts`). Chains wider than ~2 px are
filled outlines with seeded, wobbling edges; thinner twigs are polylines
batched by width and tone class.

- *Tone and joins.* Each body is an opaque tone of ink combined with the
  others by `darken` (`lighten` in the dark theme), so a branch flows out
  of its limb without a seam. A branch starts in its parent's tone (a
  short gradient) and swells into a collar where it leaves it.
- *Aerial perspective.* `core/branching.ts` gives every chain an order and
  a hashed recession (how far back it sits); further out and further back
  is lighter and cooler, as thinned sumi ink turns blue-grey.
- *Bark.* A cylinder lit from the upper left (`core/shading.ts`, pure and
  tested): a half-shadow and a core shadow inside the shadow edge, leaving
  reflected light at the rim; ink lifted short of the lit edge; a wet rim
  just inside both edges whose width follows the paper, not the zoom.
  Fissures run along the stroke and weave, wider in the shade, so the
  texture models the form; old (wide) wood is furrowed, young wood smooth
  with lenticels. Three fissure octaves and a fine edge roughness fade in
  with the zoom (`View.detail`), so the bark gains detail under the loupe.
- *Flying white.* Dry brush is hair tracks, straight, tapered and broken,
  on the lit side and towards the end of wide strokes (≥ 8 CSS px only),
  lifted through the paper's tooth so it breaks into grains. Coarse hairs
  give way to fine ones as you zoom.
- *Ground.* A dry horizontal sweep through the foot of the trunk, a
  fainter echo, and a few moss dots (`render/ground.ts`).
- *Crowds.* Above a crowding threshold the crown is first laid in as a
  soft, cool density wash (`render/densityWash.ts`: twig ink rasterised on
  a 3 CSS px grid, blurred, saturated softly, cached), and the twigs over
  it are thinned further, so a 390K-segment weed reads as a misty crown.

**Foliage** (`render/foliage.ts`). Lanceolate, slightly bent leaves set
alternately along the last segments of each twig and at its tip, angled
out and drooping, in two washes per pigment so overlaps deepen, with a
dried edge, the half turned from the light glazed darker, midribs once
they are big enough on screen, and granulation through the tooth. Some
leaves in front lift the ink of the twigs behind them. Blossom: five
separate petals with fine outlines, stamens with anthers (dots until the
zoom can show filaments), side-on cups on a dark calyx, buds, and petals
fallen and falling.

**Paper** (`render/paper.ts`): tone, cloudiness, grain, a cold-press
relief lit like the plate, fibres and a faint vignette. **Seal**
(`render/seal.ts`): a vermilion chop, 森 in carved seal script, pressed in
the lower corner away from the plant's mass.

All noise is hashed from chain indices and plate-space distance along the
chain, so frames never flicker and marks never swim under the camera.

**Print** (`render/print.ts`, Command `DownloadPrint`). A PNG at 300 dpi
on A4, A3 or A2 (3508 × 4961 px for A3), portrait or landscape by the
plant's shape (`orientationOf`, the same as the screen's sheet, taken
from the plant so the same link always prints the same way, even while
the screen's turn waits for a zoom to end), always ink on paper. It is the screen's renderer at a
higher `dpr` (the sheet is ~1100 CSS px on its long side, so proportions
match the screen) and a higher `detail` (fine bark and stamens show). It
paints in bands of ~2.5 Mpx, yielding between them, then adds the plate
mark (a plate tone and a bevelled edge) and pencilled inscriptions with
the seed; the file carries a pHYs chunk so it opens at 300 dpi. Same
link, style, season and size give the same print.

Performance, headless Chrome at DPR 2 on a laptop: Twig n=11 (350K
segments) plays at ~56 fps (draft frames) and its finished plate paints
in ~65 ms (Ink) / ~140–185 ms (Leaf); Weed n=8 (391K) plays at ~38 fps,
finished in ~80 / ~125 ms; up to ~120K segments play at 60 fps. The crisp
repaint after a gesture is ~70–150 ms on ordinary plants and up to
~300 ms at 5× deep inside the 350K crown (tens of thousands of twigs
promoted to brush strokes). An A3 print takes about a second, with no
frame longer than ~140 ms.

Rules of thumb:

- **Geometry never enters the Foldkit Model.** The Model holds params, a
  build id and playback state; the geometry lives in `engine/geometryStore.ts`
  and the canvas element looks it up by id.
- **Hot loops are plain TypeScript.** Effect provides a seeded `Random` service;
  the core calls `nextDoubleUnsafe()` from an ordinary loop.
- **Same link, same plant.** The params, including the seed, are encoded in
  the query string.

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
  painted again. Painters build their paths in *plate pixels* (device
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

At 350K segments, the crisp repaint after a gesture takes ~70–140 ms
(less than the fitted plate's, since most of the tree is culled), and
gestures, including during playback, stay at 60 fps.

## Pinned versions

Foldkit is pre-1.0 and can break in minor releases, so `foldkit` and
`effect` are pinned to exact versions. Upgrade them together on purpose.
