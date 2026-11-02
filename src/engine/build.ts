import { Effect, Random } from 'effect'

import { type BranchTopology, PIPE_EXPONENT, TOPOLOGY_ARRAYS, analyzeBranches } from '../core/branching'
import { type LSystemOutput, type LSystemSpec, type ParseError, generateSteps } from '../core/lsystem'

/**
 * One build of a plant: generation (parse, rewrite, turtle) and the branch
 * topology the first paint needs, with how long each took. Shared by the
 * generator's Web Worker and the inline fallback, so both give the same
 * plant, byte for byte.
 */

export interface BuildTiming {
  /** Parse, rewrite and turtle. */
  readonly generateMs: number
  /** Pipe radii and stroke chains (`analyzeBranches`). */
  readonly topologyMs: number
}

export type Build =
  | ({ readonly ok: true; readonly topology: BranchTopology; readonly timing: BuildTiming } & LSystemOutput)
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

export interface BuildRequest extends LSystemSpec {
  readonly seed: string
}

/**
 * The app's seeded Random as a plain function: Effect's `Random` service
 * under `Random.withSeed(seed)`, the same mechanism on the main thread and
 * in the worker, so the same link always grows the same plant. The core
 * calls it from its own loops.
 */
export const seededRandom = (seed: string): (() => number) => {
  const random = Effect.runSync(
    Effect.gen(function* () {
      return yield* Random.Random
    }).pipe(Random.withSeed(seed)),
  )
  return () => random.nextDoubleUnsafe()
}

/**
 * A build as a generator that yields between stages (see `generateSteps`;
 * the topology is one more), so the worker can drop a build that a newer
 * one has replaced. Times count only the work, not the pauses.
 */
export function* buildSteps(request: BuildRequest, maxSymbols?: number): Generator<void, Build> {
  const steps = generateSteps(request, seededRandom(request.seed), maxSymbols)
  let generateMs = 0
  for (;;) {
    const startedAt = performance.now()
    const step = steps.next()
    generateMs += performance.now() - startedAt
    if (step.done === true) {
      const result = step.value
      if (!result.ok) return result
      yield
      const topologyStartedAt = performance.now()
      const topology = analyzeBranches(result.geometry, PIPE_EXPONENT)
      const topologyMs = performance.now() - topologyStartedAt
      return { ...result, topology, timing: { generateMs, topologyMs } }
    }
    yield
  }
}

/** A whole build, now, on this thread. */
export const buildNow = (request: BuildRequest, maxSymbols?: number): Build => {
  const steps = buildSteps(request, maxSymbols)
  for (;;) {
    const step = steps.next()
    if (step.done === true) return step.value
  }
}

/** Every buffer behind a build's typed arrays, to transfer it to another
 *  thread instead of copying it. */
export const buildTransferables = (build: Build): Array<ArrayBuffer> => {
  if (!build.ok) return []
  const { geometry, topology } = build
  const buffers = new Set<ArrayBuffer>()
  for (const array of [geometry.coords, geometry.depth, geometry.parent, geometry.arrival]) {
    buffers.add(array.buffer as ArrayBuffer)
  }
  for (const name of TOPOLOGY_ARRAYS) buffers.add(topology[name].buffer as ArrayBuffer)
  return [...buffers]
}
