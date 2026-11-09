# Tree Garden: notes for agents

An L-system playground that paints plants as ink plates. It uses Foldkit
(Elm architecture on Effect 4), Vite 8, pnpm, Canvas2D plus WebGL2, and Web
Workers. Every push to `main` deploys to GitHub Pages.

Read before you change things:
- `README.md`: what it is, the commands, the architecture.
- `docs/RENDERING.md`: invariants, what made the look work, performance
  findings and pitfalls. Required before touching `src/render/` or
  `src/core/branching.ts`.
- `docs/RETRO.md`: process lessons and the ranked improvement backlog.

## Rules
- **Model:** geometry never goes in the Foldkit Model; it holds a build id.
  Follow the existing Foldkit conventions: fact-named Messages,
  `modifyFields`, `Command.define`, story tests.
- **Core:** `src/core` stays pure TypeScript with no Effect and no DOM. Hot
  loops are plain loops over typed arrays.
- **Determinism:** same link → same plant and same print, byte for byte.
  There is no `Math.random` in `core/` or `render/`. Noise is keyed on
  plate-space chain distance. `src/test/determinism.test.ts` must stay
  green.
- **Units:** marks are sized in plate units. Only level-of-detail decisions
  use screen pixels.
- **Before you finish:** run `pnpm typecheck`, `pnpm test` and
  `pnpm build --base=/tree-garden/`.

## Verifying rendering
- **Use production:** reproduce on `pnpm build && pnpm preview`, not the dev
  server. Right after a source edit, the dev server can show a blank plate,
  which is a dev-only module duplication.
- **Screenshots:** take them without any `getImageData` first; a readback
  forces the canvas to present and hides bugs.
- **Colour scheme:** emulate it (`Emulation.setEmulatedMedia`), because
  headless Chrome follows the macOS appearance.
- **Benchmarks:** interleaved A/B in one browser process, median and p95,
  reused canvases, flush with a 1-px copy. Use your own CDP and dev ports,
  one Chrome at a time.
- **Housekeeping:** stop the servers you start before reporting. If the
  sandbox blocks a command, report it instead of working around it.
- **Commits:** don't push unless asked; pushing deploys.
