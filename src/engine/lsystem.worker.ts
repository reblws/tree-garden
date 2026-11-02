import { type Build, type BuildRequest, buildNow, buildSteps, buildTransferables } from './build'

/**
 * The generator's Web Worker: builds plants (parse, rewrite, turtle and
 * branch topology) off the main thread and transfers the typed arrays
 * back, so nothing is copied.
 *
 * One build at a time, and only the newest is wanted: a `build` message
 * replaces any build still waiting or running. A running build gives way
 * at its next stage boundary (after parsing, after each rewriting
 * iteration, every few milliseconds of the turtle's walk, before the
 * topology, before posting); the worker returns to its event loop there
 * through a MessageChannel, which costs a few hundredths of a millisecond
 * and lets messages from the page in (`scheduler.yield()` would not: its
 * continuation runs first). See engine/lsystem.ts for the other end.
 *
 * Measured alternative: terminating the busy worker and starting a fresh
 * one costs more than the stage it saves (~15–25 ms to start, and its
 * first big build runs ~1.5× slower on a cold JIT), so the worker is kept.
 */

export type WorkerRequest =
  | { readonly type: 'build'; readonly id: number; readonly request: BuildRequest }
  | { readonly type: 'cancel'; readonly id: number }

export interface WorkerResponse {
  readonly id: number
  readonly build: Build
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse, transfer: Array<Transferable>) => void
}
const scope = globalThis as unknown as WorkerScope

/** The build to finish, -1 for none. */
let wanted = -1
let waiting: { readonly id: number; readonly request: BuildRequest } | undefined
let isRunning = false

/** Resolve in a new task, after any messages already queued. */
const tick = (() => {
  const channel = new MessageChannel()
  let resolve: () => void = () => undefined
  channel.port1.onmessage = () => resolve()
  return () =>
    new Promise<void>(done => {
      resolve = done
      channel.port2.postMessage(null)
    })
})()

const run = async (id: number, request: BuildRequest): Promise<void> => {
  const steps = buildSteps(request)
  for (;;) {
    if (id !== wanted) return
    const step = steps.next()
    if (step.done === true) {
      // Hear about any newer request that came in during the last stage.
      await tick()
      if (id === wanted) scope.postMessage({ id, build: step.value }, buildTransferables(step.value))
      return
    }
    await tick()
  }
}

const drain = async (): Promise<void> => {
  isRunning = true
  while (waiting !== undefined) {
    const { id, request } = waiting
    waiting = undefined
    await run(id, request)
  }
  isRunning = false
}

scope.onmessage = ({ data }) => {
  if (data.type === 'build') {
    wanted = data.id
    waiting = data
    if (!isRunning) void drain()
  } else if (data.id === wanted) {
    wanted = -1
    waiting = undefined
  }
}

// Warm the JIT on small plants (one deterministic, one stochastic with
// jitter) while the app boots, so the first real build runs optimised code
// instead of compiling its hot loops mid-flight.
buildNow({ axiom: 'X', rules: 'X -> F-[[X]+X]+F[+FX]-X\nF -> FF', iterations: 4, angle: 22.5, jitter: 0, seed: 'warm' })
buildNow({ axiom: 'F', rules: 'F (1) -> F[+F]F[-F]F\nF (1) -> F[-F]F', iterations: 4, angle: 25.7, jitter: 0.3, seed: 'warm' })
