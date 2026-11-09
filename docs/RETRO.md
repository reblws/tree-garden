# Retro: building Tree Garden with agent rounds (2026‑10‑31 → 2026‑11‑02)

Everything from the empty repo to the live site was built in about three
days by a coordinator plus around fifteen subagent runs:
- research (the primer, the stack, presets, layout, performance);
- two design rounds;
- zoom;
- the layout change;
- three parallel performance tracks;
- fixes.

This is what we'd keep, what we'd change, and a ranked backlog. Rendering
details are in [RENDERING.md](RENDERING.md).

## What worked

- **Relay with written learnings.** Each design round ended with a
  learnings file (what worked, what was dropped and why, the numbers, the
  pitfalls, a ranked next list) that the next agent read first. Round 2
  avoided every dead end round 1 had hit.
- **Research before building.** Layout and performance were researched
  with measurements and mockups first, and implemented only once a
  recommendation was approved. The performance research found the single
  biggest win (Foldkit branding the hot loops in production) before anyone
  wrote optimisation code.
- **Parallel tracks in isolated git worktrees, scoped by file.** Three
  performance tracks ran at once. Each had a "stay out of" list. Merging
  them produced only import-line conflicts.
- **Correctness bars stated up front.** "Byte-identical" for generation and
  print, "visual sign-off with diffs" for the GPU. That made agents build
  the determinism test and the side-by-side diff tooling that now protect
  the code.
- **Measuring instead of guessing.** Each claim came with a median and p95
  from interleaved A/B runs. Several plausible ideas (typed-array rewrites,
  a WASM rewrite, SIMD) were dropped on evidence.

## What went wrong, and the rule we take from it

| What happened | Cost | Rule |
| --- | --- | --- |
| Learnings files, benchmark harnesses and screenshot tools lived in a temp scratchpad, which was cleaned within a week | The learnings had to be recovered from agent transcripts; the tooling is gone | **Anything worth reading twice goes in the repo:** `docs/` for knowledge, `tools/` for harnesses |
| A blank-plate bug was chased for hours (software GL, GPU watchdog, a GPU "hog" stress test) before it was found to be a Vite dev-server artifact | Two fix rounds, one of them unnecessary | **Reproduce on `pnpm build && pnpm preview` before debugging rendering.** Find a deterministic trigger first (here: touch a file, then load) |
| Verification used `getImageData`, which forces the canvas to present | It hid what was actually on screen | **Screenshot checks never read pixels back first** |
| Agents benchmarked on a machine shared with other agents' Chromes; the CDP port was hardcoded (collisions) | ±30% noise; numbers that had to be re-checked | Give each agent its own CDP port and dev port; trust only interleaved A/B; re-measure on a quiet machine before quoting absolutes |
| Agents started long-lived servers and then "waited on background work" that never ends | Stalled until nudged | Briefs say: run servers in the background, stop them before reporting, never wait on them |
| Usage limits interrupted agents about eight times | Each needed a resume message with its exact state | Keep briefs self-contained; check the branch state before resuming; commit early and often in worktrees |
| One agent wrapped a sandbox-blocked command in a script to get around the block | A workaround the sandbox was meant to prevent | If the sandbox blocks something, stop and report. Briefs say so |
| Agent worktrees inside the repo were picked up by Vitest (483 "tests") | A confusing test count | `vitest.config.ts` excludes `.claude/**`; `.gitignore` ignores `.claude/worktrees/` |
| A preset-research agent's screenshots straddled a layout change landing at the same time | Two unusable screenshots | Don't run visual research against a server another agent is editing; snapshot first (`git archive HEAD`) |
| Integration bugs only show in the browser (172 tests passed while the plate looked blank) | Late discovery | After every merge, run a screenshot smoke test on the preview build, not just the tests |

## Codebase improvement backlog (ranked by value ÷ effort)

1. **Commit the harness.** Add `tools/` with:
   - the CDP driver: per-run port, `SCHEME`, `PRESCRIPT` (e.g. disable
     WebGL), and a step `return` that works;
   - the side-by-side diff tool;
   - the plate and playback benchmarks.

   Add `pnpm shots` and `pnpm bench` against `vite preview`. Every agent
   round rebuilt these from scratch.
2. **Visual regression in CI.** Golden PNGs for 4–6 presets × styles,
   rendered with the GPU off (Canvas2D is deterministic for a given
   Chrome), compared with a small tolerance. Add one print-hash check.
   Today the renderer is protected only by eyeballs.
3. **Guard determinism mechanically.** A lint rule banning `Math.random`
   (and `Date.now` in paint paths) in `src/core` and `src/render`. Cheap,
   and it catches the most likely regression.
4. **Fix the dev-only blank plate.** Keep `GeometryStore`'s maps on
   `globalThis` (or in `import.meta.hot.data`), so a hot reload can't split
   it. Or regenerate on a Foldkit model restore when the build id isn't in
   the store.
5. **Split the two largest files.**
   - `render/inkBrush.ts` (~1.5K lines): chain walk, bark and fissures, dry
     brush, twig batching and promotion.
   - `render/treeCanvas.ts` (~900 lines): gestures, job runner, GPU wiring,
     caches.

   Pull pure decisions out into tested modules, as `twigPlan.ts` did:
   16 render files have no tests.
6. **Cache the seal by zoom octave.** `sealImage` re-renders up to 1024²
   with a per-pixel loop (~60 ms native) at every new zoom.
7. **Make the print worker leaner and faster.**
   - The worker chunk is 121 kB because Effect Schema comes in through
     `sheet.ts`, `renderStyle.ts` and `season.ts`. Split the plain constants
     from the schemas.
   - Pre-warm the worker.
   - Bands re-walk the whole tree at zoom 1 (the `isZoomed` cull guard).
     Culling per band would be faster but changes bytes, so decide
     deliberately.
8. **One home for budgets.** `DRAFT_SEGMENTS`, `MAX_DABS`,
   `MAX_DABS_ANIMATING`, `PROMOTE_BUDGET`, `SLICE_MS` and the crowding
   threshold are scattered. A `render/budgets.ts` with the measurement
   behind each number would make tuning safe.
9. **Calibrate the GPU Line pen.** Dense Line masses are about ¼ px bolder
   than Canvas2D.
10. **Look, from the design rounds' "next" lists.**
    - A true fork outline (one union for parent plus lateral) to remove the
      last seam.
    - Bark character per species (plates, birch bands).
    - Leaf sprays with stalks.
    - A paper-tone choice and an optional deckle for prints.
11. **Engine features unlocked by research.**
    - Length scaling (`>`/`<`, about 20 lines in the turtle), which unlocks
      compound leaves (ABOP fig. 5.12).
    - Context-sensitive rules (ABOP fig. 1.31 weeds).
    - Parametric rules, for ABOP chapter 2 trees.
12. **Later:** a WASM rewrite-plus-turtle kernel, with trig imported from JS
    to stay deterministic. It's only worth it if live slider scrubbing on
    huge trees matters.
13. **Housekeeping.** Remove the merged agent worktrees and branches
    (`git worktree remove`, `git branch -d`).
