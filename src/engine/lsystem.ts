import { Effect, Random } from 'effect'

import { type GenerateResult, generate } from '../core/lsystem'
import type { LSystemParams } from '../params/lsystem'

/**
 * Run the L-system with a Random generator seeded from `params.seed`, so the
 * same link always grows the same plant.
 *
 * Effect handles only the edges: it supplies the seeded service, and the
 * pure core then calls `nextDoubleUnsafe()` in its own loop. Running the
 * rewrite itself as an Effect generator would allocate for every symbol.
 *
 * This runs on the main thread for now. Moving it into a Web Worker means
 * swapping this function for one that posts to a worker, with no change to
 * the core.
 */
export const generateLSystem = (params: LSystemParams): Effect.Effect<GenerateResult> =>
  Effect.gen(function* () {
    const random = yield* Random.Random
    return generate(params, () => random.nextDoubleUnsafe())
  }).pipe(Random.withSeed(params.seed))
