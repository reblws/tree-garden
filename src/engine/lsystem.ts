import { Data, Effect } from 'effect'

import type { LSystemParams } from '../params/lsystem'
import { type Build, buildNow } from './build'
import { GeometryStore } from './geometryStore'
import type { WorkerRequest, WorkerResponse } from './lsystem.worker'

export type { Build, BuildTiming } from './build'

/**
 * Grow the plant for `params`: parse, rewrite, turtle and branch topology,
 * with a Random seeded from `params.seed`, so the same link always grows
 * the same plant, byte for byte.
 *
 * The work runs in a Web Worker (lsystem.worker.ts), started at app load
 * by `startLSystemWorker` so its start-up is hidden behind the app's. The
 * typed arrays are transferred back, not copied, and the topology is put
 * in the GeometryStore with the geometry, so the first paint doesn't
 * compute it again. Where there is no Worker (tests, happy-dom) or it
 * fails to start, the same build runs inline.
 *
 * One plant at a time: requesting a build supersedes the one in flight,
 * which fails with `Superseded` at once; the worker drops it at its next
 * stage boundary, so old work never holds up the new build. Interrupting
 * the Effect cancels its build the same way.
 */
export class Superseded extends Data.TaggedError('Superseded')<{}> {}

export const generateLSystem = (params: LSystemParams): Effect.Effect<Build, Superseded> =>
  Effect.callback<Build, Superseded>(resume => {
    const target = startWorker()
    if (target === undefined) {
      resume(Effect.sync(() => buildNow(requestOf(params))))
      return
    }
    current?.resume(Effect.fail(new Superseded()))
    const job: Job = { id: ++lastJobId, params, resume }
    current = job
    post(target, { type: 'build', id: job.id, request: requestOf(params) })
    return Effect.sync(() => {
      if (current !== job) return
      current = undefined
      if (worker !== undefined) post(worker, { type: 'cancel', id: job.id })
    })
  }).pipe(
    Effect.tap(build =>
      Effect.sync(() => {
        if (build.ok) GeometryStore.setTopology(build.geometry, build.topology)
      }),
    ),
  )

/** Start the worker now, so it is ready by the first build. Safe to call
 *  more than once; does nothing where there are no Workers. */
export const startLSystemWorker = (): void => {
  startWorker()
}

interface Job {
  readonly id: number
  readonly params: LSystemParams
  readonly resume: (effect: Effect.Effect<Build, Superseded>) => void
}

let worker: Worker | undefined
let isUnavailable = false
/** The build the worker is on, the only one whose result is wanted. */
let current: Job | undefined
let lastJobId = 0

/** Plain data only: the Model's params are frozen Schema values. */
const requestOf = (params: LSystemParams) => ({
  axiom: params.axiom,
  rules: params.rules,
  iterations: params.iterations,
  angle: params.angle,
  jitter: params.jitter,
  seed: params.seed,
})

const post = (target: Worker, message: WorkerRequest): void => target.postMessage(message)

const startWorker = (): Worker | undefined => {
  if (worker !== undefined || isUnavailable) return worker
  if (typeof Worker !== 'function') {
    isUnavailable = true
    return undefined
  }
  try {
    worker = new Worker(new URL('./lsystem.worker.ts', import.meta.url), { type: 'module', name: 'lsystem' })
  } catch {
    isUnavailable = true
    return undefined
  }
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    // A result for anything but the current build is stale: drop it.
    const job = current
    if (job === undefined || data.id !== job.id) return
    current = undefined
    job.resume(Effect.succeed(data.build))
  }
  // If the worker can't load or breaks, build inline from now on, starting
  // with the build it was on.
  const fallBack = (event: Event) => {
    event.preventDefault()
    worker?.terminate()
    worker = undefined
    isUnavailable = true
    const job = current
    current = undefined
    job?.resume(Effect.sync(() => buildNow(requestOf(job.params))))
  }
  worker.onerror = fallBack
  worker.onmessageerror = fallBack
  return worker
}
