import { Effect, Random } from 'effect'
import { describe, expect, test } from 'vitest'

import { type BranchTopology, PIPE_EXPONENT, TOPOLOGY_ARRAYS, analyzeBranches, growRadii, pipeRadii } from '../core/branching'
import type { Segments2D } from '../core/geometry'
import { type GenerateResult, generate } from '../core/lsystem'
import { type Build, type BuildRequest, buildNow, buildTransferables } from '../engine/build'
import { presets } from '../params/presets'
import { analyzeBranches as referenceAnalyze, pipeRadii as referencePipeRadii } from './reference/branching'
import { type LSystemSpec, generate as referenceGenerate } from './reference/lsystem'

/**
 * The optimised generator and topology (core/lsystem/compiled.ts,
 * core/branching.ts, the worker's engine/build.ts and its transfer) must
 * give exactly what the code before them gave (src/test/reference/), byte
 * for byte, for every output array and scalar: the same link must grow the
 * same plant on every version and on every thread.
 */

/** The old engine/lsystem.ts: Effect's Random under `Random.withSeed`. */
const referenceBuild = (request: BuildRequest): GenerateResult =>
  Effect.runSync(
    Effect.gen(function* () {
      const random = yield* Random.Random
      return referenceGenerate(request, () => random.nextDoubleUnsafe())
    }).pipe(Random.withSeed(request.seed)),
  )

const preset = (id: string, iterations?: number, overrides: Partial<BuildRequest> = {}): BuildRequest => {
  const found = presets.find(p => p.id === id)
  if (found === undefined) throw new Error(`no preset ${id}`)
  return { ...found.params, ...(iterations === undefined ? {} : { iterations }), seed: 'oak', ...overrides }
}

const TREES: ReadonlyArray<readonly [string, BuildRequest]> = [
  ['Twig n=11 (350K segments)', preset('abop-1-24d', 11)],
  ['Weed n=8 (390K segments)', preset('abop-1-24b', 8)],
  ['Twig n=12, truncated at the 2M-symbol cap', preset('abop-1-24d', 12)],
  ['Stochastic bush n=7', preset('abop-1-27', 7, { seed: 'rowan-4821' })],
  ['Stochastic bush n=12, truncated mid-iteration after drawing', preset('abop-1-27', 12)],
  ['Windswept n=7, angle jitter', preset('windswept', 7, { seed: 'elm-1234' })],
  ['Stochastic parasol n=4 with jitter', preset('stochastic-parasol', 4, { jitter: 0.2, seed: 'ash-1111' })],
  ['Koch snowflake n=6', preset('koch-snowflake', 6)],
  ['Sierpinski triangle n=10', preset('sierpinski', 10)],
  ['Conifer n=10', preset('sfi-conifer', 10)],
  ['Algae n=12', preset('bourke-algae', 12)],
  ['Binary tree n=11', preset('binary-tree', 11)],
  ['Islands and lakes n=2 (moves without drawing)', preset('abop-1-8', 2)],
  ['Pentaplexity n=4 (turn around)', preset('bourke-pentaplexity', 4)],
  [
    'moves inside branches (not depth-first preorder)',
    { axiom: 'F', rules: 'F -> F[+fF]F[-F]F', iterations: 4, angle: 25, jitter: 0.1, seed: 'yew-7' },
  ],
  [
    'more than 256 symbols (the string path)',
    {
      axiom: `F${Array.from({ length: 300 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('')}`,
      rules: 'F -> F[+F]F[-F]F',
      iterations: 4,
      angle: 25.7,
      jitter: 0.25,
      seed: 'oak',
    },
  ],
  ['empty axiom', { axiom: '', rules: 'F -> FF', iterations: 3, angle: 20, jitter: 0, seed: 'oak' }],
  ['n=0', preset('abop-1-24f', 0)],
  ...presets.map(({ id, name }): readonly [string, BuildRequest] => [`preset ${name}`, preset(id)]),
]

const bytes = (array: ArrayBufferView): Uint8Array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength)

/** Where two typed arrays first differ in their bytes, or -1. */
const firstDifference = (actual: ArrayBufferView, expected: ArrayBufferView): number => {
  if (actual.constructor !== expected.constructor) return -2
  const a = bytes(actual)
  const b = bytes(expected)
  if (a.length !== b.length) return -3
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i
  return -1
}

const expectSameGeometry = (actual: Segments2D, expected: Segments2D): void => {
  for (const name of ['coords', 'depth', 'parent', 'arrival'] as const) {
    expect(firstDifference(actual[name], expected[name]), name).toBe(-1)
  }
  for (const name of ['count', 'maxDepth', 'maxArrival'] as const) expect(Object.is(actual[name], expected[name]), name).toBe(true)
  for (const name of ['minX', 'minY', 'maxX', 'maxY'] as const) {
    expect(Object.is(actual.bounds[name], expected.bounds[name]), `bounds.${name}`).toBe(true)
  }
}

const expectSameResult = (actual: GenerateResult, expected: GenerateResult): void => {
  expect(actual.ok).toBe(expected.ok)
  if (!actual.ok || !expected.ok) {
    expect(actual).toEqual(expected)
    return
  }
  expectSameGeometry(actual.geometry, expected.geometry)
  for (const name of ['symbolCount', 'iterationsApplied', 'truncated', 'preview'] as const) {
    expect(Object.is(actual[name], expected[name]), name).toBe(true)
  }
}

const REFERENCE_ARRAYS = TOPOLOGY_ARRAYS.filter(name => name !== 'subtreeEnd')

const expectSameTopology = (actual: BranchTopology, expected: ReturnType<typeof referenceAnalyze>): void => {
  for (const name of REFERENCE_ARRAYS) expect(firstDifference(actual[name], expected[name]), name).toBe(-1)
  expect(Object.is(actual.maxRadius, expected.maxRadius), 'maxRadius').toBe(true)
  expect(actual.chainCount).toBe(expected.chainCount)
}

/** Reveal fractions for the growing radii, including both ends. */
const FRACTIONS = [0, 0.02, 0.2, 0.37, 0.5, 0.6, 0.77, 0.93, 0.999, 1, 1.01]

const expectSameGrowingRadii = (geometry: Segments2D, topology: BranchTopology): void => {
  const { count, arrival } = geometry
  // Longer than needed, as the renderer's scratch can be: the tail must be
  // left alone.
  const actual = new Float32Array(count + 3).fill(7)
  const expected = new Float32Array(count + 3).fill(7)
  for (const fraction of FRACTIONS) {
    const threshold = fraction * geometry.maxArrival
    const max = growRadii(geometry, topology, PIPE_EXPONENT, actual, threshold)
    const referenceMax = referencePipeRadii(geometry, PIPE_EXPONENT, expected, count, i => (arrival[i] ?? 0) < threshold)
    expect(Object.is(max, referenceMax), `grow ${fraction} max`).toBe(true)
    expect(firstDifference(actual, expected), `grow ${fraction}`).toBe(-1)

    const visible = Math.ceil(fraction * count)
    const traceMax = pipeRadii(geometry, PIPE_EXPONENT, actual, visible)
    const referenceTraceMax = referencePipeRadii(geometry, PIPE_EXPONENT, expected, visible)
    expect(Object.is(traceMax, referenceTraceMax), `trace ${fraction} max`).toBe(true)
    expect(firstDifference(actual, expected), `trace ${fraction}`).toBe(-1)
  }
}

/** What the main thread receives from the worker: the build, structured-
 *  cloned with its buffers transferred. */
const transferred = (build: Build): Build => {
  const buffers = buildTransferables(build)
  const received = structuredClone({ id: 1, build }, { transfer: buffers }).build
  // Transferred, not copied: the sender's buffers are now empty.
  for (const buffer of buffers) expect(buffer.byteLength).toBe(0)
  return received
}

describe('the optimised generator and topology match the reference byte for byte', () => {
  test.each(TREES)('%s', (_name, request) => {
    const expected = referenceBuild(request)
    const build = buildNow(request)
    expectSameResult(build, expected)

    // The core on its own, with a plain seeded function.
    const random = Effect.runSync(
      Effect.gen(function* () {
        return yield* Random.Random
      }).pipe(Random.withSeed(request.seed)),
    )
    expectSameResult(generate(request as LSystemSpec, () => random.nextDoubleUnsafe()), expected)

    if (!build.ok || !expected.ok) return
    const referenceTopology = referenceAnalyze(expected.geometry, PIPE_EXPONENT)
    expectSameTopology(build.topology, referenceTopology)
    expectSameTopology(analyzeBranches(expected.geometry), referenceTopology)
    expectSameGrowingRadii(expected.geometry, build.topology)

    // Across the thread boundary.
    const received = transferred(build)
    expectSameResult(received, expected)
    if (received.ok) expectSameTopology(received.topology, referenceTopology)
  }, 60_000)

  test('the subtree ranges are used where the geometry allows them, and not where it does not', () => {
    const tree = buildNow(preset('abop-1-24d', 6))
    const moves = buildNow({ axiom: 'F', rules: 'F -> F[+fF]F[-F]F', iterations: 3, angle: 25, jitter: 0, seed: 'oak' })
    if (!tree.ok || !moves.ok) throw new Error('expected plants')
    expect(tree.topology.subtreeEnd.length).toBe(tree.geometry.count)
    expect(moves.topology.subtreeEnd.length).toBe(0)
  })
})
