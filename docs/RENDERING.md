# Rendering: what we learned

The README says *what* the renderer does. This file records *why* it is the
way it is: what worked, what was tried and dropped, the measured numbers,
and the traps. It is distilled from six agent rounds (two design rounds,
zoom, layout, three performance tracks) between 2026‑10‑31 and 2026‑11‑02.
Read it before changing anything in `src/render/` or `src/core/branching.ts`.

## 1. Invariants (break these and things go wrong quietly)

| Invariant | Why | Where it's enforced |
| --- | --- | --- |
| Geometry never enters the Foldkit Model; the Model holds a build id | The Model is copied, diffed and time-travelled on every update | `engine/geometryStore.ts` |
| `parent[i] < i` (segments in DFS preorder; a child's arrival = parent's + 1) | Topology, prefix-sum radii and stroke chains all rely on it | `core/lsystem/turtle.ts`, `compiled.ts` |
| No `Math.random` in `render/` or `core/`; all noise is `hash(segment)` / `hash2(chain, k)` | Frames must not flicker; the same link must paint the same plate | review; `src/test/determinism.test.ts` covers core |
| Noise is keyed on **plate-space distance along the chain** | Otherwise texture swims when you pan or zoom | `render/noise.ts` walkers, `inkBrush.ts` |
| Marks are sized in **plate units** (they magnify); only level-of-detail decisions use screen px | A print under a loupe: the trunk really gets wider | `render/frame.ts` (`View`, `texture`, `detail`) |
| Same link → same plant, byte for byte, in the worker and inline | Share links and prints are promises | `src/test/determinism.test.ts` (47 plants, one-ulp sensitive) |
| `BAND_PIXELS` (print band height) is fixed | Float rounding of each band's offset reaches the anti-aliasing; another band size gives a different file | `render/print.ts` |
| The screen plate and the print share proportions, margins and orientation | What you see is what you print | `render/sheet.ts`, `plateMargins`, `orientationOf` |

## 2. The look: what made it read as ink on paper

In order of impact.

1. **Topology first.** Pipe-model radii (`r^e = Σ r_child^e`, tips = 1,
   e = `PIPE_EXPONENT` = 2.3) turn a stick figure into a tree: a thick trunk
   down to hairline twigs. Stroke chains follow the heaviest child (ties go
   to the straightest), so a limb is one stroke, not a string of pieces.
2. **Width law** `w = tip · r^k`, with k chosen so the trunk is about 2.5% of
   the sheet's short side (capped at 1.5, so few-tipped plants still get a
   trunk). *Never cap the trunk by turtle step length*: `F → FF` makes steps
   tiny at high n, and the trunk collapses to a hairline.
3. **Bodies are opaque mid-tone washes (~0.62–0.72), joined with `darken`**
   (`lighten` on dark paper). The darks are *marks* drawn on top. A dense
   body leaves no room for texture, and translucent bodies pool into seams
   at every fork.
4. **Volume:** a Lambert cylinder lit from the upper left (`core/shading.ts`),
   drawn as *polygon bands* across the stroke whose inner edges wander on
   noise. Gradients can't follow a curving stroke in Canvas2D; polygons cost
   the same and read as brush hairs.
5. **Bark:** fissures are three octaves of tracks along the stroke that weave
   (fbm) and break into dashes. They are filled ribbons tapered by the
   threshold excess, and wider on the shadow side. Octaves 2–3 fade in with
   `View.detail`, so detail *emerges* as you zoom. Old (wide) wood is
   furrowed; young wood is smooth, with lenticels.
6. **Dry brush ("flying white"):** straight hair tracks, broken by dash
   noise, gathered on the lit side and towards the stroke's end, and **filled
   through the paper-tooth pattern** stretched along the stroke, so each hair
   breaks into grains. Only on strokes of 8 CSS px and up.
7. **Wet rim:** drawn just *inside* the two long edges, never the caps, with
   width `1.05·dpr·texture/zoom`, so it stays a paper-scale mark.
8. **Twigs:** batched polylines per (tone class, width class). Alpha is
   diluted by density, and above `crowding > 2.2` a blurred density-field
   wash goes down first, so huge crowns read as mist rather than a black
   mass.
9. **Paper:** a base tone, cloud noise, a grain tile, a lit cold-press relief
   (strength 0.052; at 0.07 it looked like stucco), fibres and a vignette.
   The ink is multiplied (`screen` in dark mode) over it, plus a blurred copy
   for bleed.
10. **Foliage:** lanceolate bent leaves (up to 5 per tip), two washes per
    pigment so overlaps deepen, a shade glaze, a dried rim, granulation.
    Blossom has separate petals, filaments and anthers when zoom allows, and
    fallen petals. Some leaves and petals *cut* the ink layer, per petal,
    so twigs pass behind them.
11. **Composition:** placement uses the ink's centre of mass, not the
    bounding box. Ground strokes are painted *after* the tree (painted
    before, the trunk looked pasted on). Aerial perspective: recessed chains
    are lighter and cooler.
12. **Dark mode is chalk on charcoal.** Darks must *remove* chalk
    (`destination-out`) and lights add it. Without that swap, the bark reads
    lit from the wrong side.

### Tried and dropped

| Attempt | Why it failed |
| --- | --- |
| Dry-brush streaks as solid `destination-out` lines | Read as chrome highlights on a metal pipe |
| Hair streaks without the tooth pattern | Clean white lines: still chrome |
| Unoriented per-pixel tooth | TV static or sandpaper |
| A few thick bristles at fixed offsets | Dashed lines |
| Rim stroked around the whole outline | Cartoon "cylinder bottom" at the trunk base |
| Root flare ×1.5 | Bulbous (now ×1.32 with a flat cap) |
| Translucent per-stroke ink (alpha 0.8) | Seams at every fork; replaced by opaque tones + `darken` |
| Wash ellipse under the ground | A grey cushion |
| Mist painted with `destination-over` after the strokes | Dry brush and lifted lights showed the mist as grey bars |
| One sample budget shared by limbs and promoted twigs | Zoomed into a crown, the twigs ate it and the limbs became grey ghost polylines |
| 24K foliage dabs | 8–22 fps on dense trees; now 10K final / 3.5K animating (`MAX_DABS`) |

## 3. Performance: where time goes and what fixed it

Measured in headless Chrome 156, DPR 2, Apple M4. Absolutes drift ±20–30%
under load; only interleaved A/B runs in one process are trustworthy.

### Where the time went (before the performance tracks)

On a 350K-segment tree (Twig n=11): generation took ~57 ms, topology
14–26 ms at the first paint, and the finished Ink plate ~150 ms. Of that
paint, ~100 ms was **JavaScript building paths** (lineTo, the chain walk,
noise, `pow`) and only ~45 ms rasterising. The bottleneck was path
construction, not drawing.

### What moved the needle

| Change | Effect | Note |
| --- | --- | --- |
| Skip Foldkit's `foldkit:view-identity` branding for `src/(core\|render\|engine)` (`vite.config.ts`) | Generation −35%, paint −20–25% | The plugin wraps every `return` in `brandViewResult`, **in production too**. Ten lines of config. Check `dist` with `grep 'src/core/' dist/assets/*.js` |
| Never build the derived string (`core/lsystem/compiled.ts`): byte ids, count vectors, depth-first walk | Twig n=11 generate 55–69 → 19–32 ms | Stochastic grammars rewrite over byte buffers in the same random order |
| Generation + topology in a Web Worker, typed arrays transferred | 0 main-thread blocking before the first paint (was ~210 ms) | Transfer of 17–21 MB costs 0.1 ms; a structured clone costs 5–7 ms. Newest build wins; stale ones are dropped at stage boundaries |
| Grow radii by prefix sums over subtree ranges | Per-frame radii 4–7 → 2–4.6 ms | Needs `subtreeEnd`; falls back if a move breaks the ordering |
| Twigs on the GPU (`render/gpuInk.ts`) | Twig n=11 Ink 132 → 71 ms, Line 38 → 10; Weed playback 40 → 55 fps | See section 4 |
| Collinear merge of twig runs (Canvas2D fallback and print) | About ⅓ fewer `lineTo` | ≤ 0.07% of pixels differ |
| Crisp repaint as a resumable job in 12 ms slices (`SLICE_MS`) | Longest task after a zoom ~300 → 15–50 ms | The settled image is bit-identical; nothing blocks, but the wall time is the same |
| Print in a worker on OffscreenCanvas | 0 long tasks during A3/A2 export | Same bytes as the main-thread print |

### Measured and *not* worth it (yet)

- **WebAssembly** (AssemblyScript prototype, 7.6 KB gzipped): rewrite plus
  turtle 32 → 6.6 ms in Chrome. But WASM's `cos`/`sin` differ from V8's in
  1–1.6% of inputs, which breaks determinism, so trig must be imported from
  JS. Paint dominates anyway, and generation is already off the main thread.
  Revisit only for live slider scrubbing on huge trees.
- **Typed-array rewrites measured in Node:** 2–3× faster in Node 24, about
  the same in Chrome. **Node is not a proxy for Chrome** on typed-array
  loops; always confirm in the browser.
- **SIMD / threads:** the turtle is a serial dependency chain, and threads
  need COOP/COEP headers, which GitHub Pages can't send.
- **Splitting hot loops into many small functions:** V8 sometimes ran them
  up to 2× slower. Big first calls get OSR-compiled and then deoptimise;
  warm up on small inputs instead.

### Budgets

- Playback: 60 fps up to ~120K segments; draft frames above
  `DRAFT_SEGMENTS` (60K): no bristles, no bleed, a coarser brush.
- Finished plate: ≤ ~150 ms for 350K segments, then cached (idle costs one
  `drawImage`).
- No main-thread task over ~50 ms after a gesture settles.

## 4. GPU twigs: how parity with Canvas2D was reached

The Canvas2D painter strokes one path per (tone, width) class. *Within* a
path, overlaps are a union; *separate* paths pool. A dense crown's tone
comes from how many class layers overlap (32 layers at alpha ~0.09 ≈ 95%
ink), so the class structure must be reproduced exactly, not approximated.

- One coverage channel ("slot") per class, combined with
  `blendEquation(MAX)`, then a resolve pass composites the slots in the
  painter's order. Four RGBA8 targets per pass was fastest.
- **Joints:** split same-class joints along the bisector of the two pieces,
  so no pixel is covered twice. Keep round caps where the class changes,
  because the canvas starts a new path there and the ink pools.
  Alternatives measured: `max` alone was too light, a screen union too dark,
  cap removal lost the AA fringe.
- Off-by-one slot ranges merged classes and made crowns 3–5 levels lighter.
  The range must be exact.
- Uploading radii with `texSubImage2D` stalled on ANGLE Metal; staging
  through a `PIXEL_UNPACK_BUFFER` fixed it.
- Frames go to the 2D layer via `OffscreenCanvas.transferToImageBitmap`.
- Software WebGL (SwiftShader, llvmpipe) is refused by renderer name: it can
  lock the page for seconds, and `failIfMajorPerformanceCaveat` alone does
  not stop an explicitly chosen SwiftShader. Any GL failure repaints the
  whole ink layer on Canvas2D in the same paint.
- Residual differences: Ink and Leaf are within about 2 levels; Line draws
  dense masses about ¼ px bolder.

## 5. Canvas and browser facts we paid for

- `stroke(path)` paints the union of its subpaths once: overlapping
  subpaths **don't** accumulate alpha. Use separate paths where you want
  pooling.
- `destination-out` cuts everything beneath, including other strokes, so
  paint and cut per stroke, thin to thick.
- **Chrome 156:** a rotated `Path2D.ellipse()` and `closePath()` cost time
  proportional to the *whole path so far*. Use the Bézier `addEllipse` helper
  in `foliage.ts`, and avoid `closePath` on big batched paths.
- Allocating fresh full-size canvases per repetition exhausts Chrome's
  accelerated-canvas budget and silently drops to software raster (2–6×
  slower). Reuse canvases.
- **`getImageData` changes what you measure:** it forces a flush *and*
  presents the canvas, and it can demote a canvas to software raster. To
  time a paint, flush by copying one pixel into a 1-px canvas. To check what
  is on screen, take a screenshot with no readback before it.
- `lastDrawMs` counts JavaScript only; Canvas2D rasterises lazily.
- `ctx.filter = 'blur()'` needs Safari 18+, and OffscreenCanvas contexts in
  Safari lack it. The print falls back to the main thread where the worker
  can't blur.
- Print determinism holds on one GPU path. Two prints overlapping (or
  memory pressure) can force GPU → software raster, which gives different
  bytes. Prints therefore run one at a time in one worker.
- Native long tasks (e.g. `sealImage` doing `getImageData` and a per-pixel
  loop, ~60 ms) don't show as JS in a CPU profile. Time phases with
  `performance.now()` laps.

## 6. Testing the renderer: methods that worked

- **Determinism:** compare byte for byte against a frozen copy of the old
  code (`src/test/reference/`), over many grammars, including truncation at
  the 2M cap, stochastic rules, jitter, moves inside branches, a >256-symbol
  alphabet, an empty axiom and parse errors. Prove the test is sharp: a
  one-ulp change in the turtle should fail most cases.
- **Visual sign-off:** baseline | new | diff ×4 side-by-sides, full plate
  plus the auto-picked worst window at 4×, light and dark. Report the mean
  signed difference in 8-bit levels and the share of pixels more than 8
  levels off.
- **Benchmarks:** interleaved A/B in one browser process, median and p95,
  canvas pools, the 1-px flush, one Chrome at a time with its own CDP port,
  and an emulated colour scheme (headless follows the macOS appearance).
- **The dev server is not production.** Right after a source file changes,
  a fresh tab on the Vite dev server can load two copies of a module, so
  `GeometryStore` is written in one and read from the other, and the plate
  stays blank (with `gpuActive` false). Production is unaffected. Before
  chasing a rendering bug, reproduce it on `pnpm build && pnpm preview`.
