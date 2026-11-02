// @vitest-environment node
import { Effect, Exit, Fiber } from 'effect'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { LSystemParams } from '../params/lsystem'
import { type Build, buildNow } from './build'
import type { WorkerRequest, WorkerResponse } from './lsystem.worker'

const twig = (seed: string, iterations = 6): LSystemParams => ({
  axiom: 'X',
  rules: 'X -> F[+X]F[-X]+X\nF -> FF',
  iterations,
  angle: 20,
  jitter: 0.1,
  seed,
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the worker', () => {
  /** Load lsystem.worker.ts in this thread with a fake `postMessage`. */
  const startWorker = async () => {
    const posted: Array<{ message: WorkerResponse; transfer: Array<Transferable> }> = []
    vi.stubGlobal('postMessage', (message: WorkerResponse, transfer: Array<Transferable>) => posted.push({ message, transfer }))
    await import('./lsystem.worker')
    const send = (data: WorkerRequest) =>
      (globalThis as unknown as { onmessage: (event: { data: WorkerRequest }) => void }).onmessage({ data })
    const settle = async () => {
      for (let i = 0; i < 200; i++) await flush()
    }
    return { posted, send, settle }
  }

  test('builds the plant and transfers every buffer', async () => {
    const { posted, send, settle } = await startWorker()
    send({ type: 'build', id: 1, request: twig('oak') })
    await settle()
    expect(posted.map(p => p.message.id)).toEqual([1])
    const { build } = posted[0]?.message ?? {}
    const expected = buildNow(twig('oak'))
    if (build?.ok !== true || !expected.ok) throw new Error('expected plants')
    expect(Array.from(build.geometry.coords)).toEqual(Array.from(expected.geometry.coords))
    expect(Array.from(build.topology.radius)).toEqual(Array.from(expected.topology.radius))
    // Four geometry arrays and ten topology arrays.
    expect(posted[0]?.transfer).toHaveLength(14)
  })

  test('a newer build replaces the one running; only the newest is posted', async () => {
    const { posted, send, settle } = await startWorker()
    send({ type: 'build', id: 1, request: twig('oak', 8) })
    send({ type: 'build', id: 2, request: twig('ash', 8) })
    send({ type: 'build', id: 3, request: twig('elm', 5) })
    await settle()
    expect(posted.map(p => p.message.id)).toEqual([3])
  })

  test('a cancelled build is dropped', async () => {
    const { posted, send, settle } = await startWorker()
    send({ type: 'build', id: 1, request: twig('oak', 8) })
    send({ type: 'cancel', id: 1 })
    await settle()
    expect(posted).toEqual([])
    send({ type: 'build', id: 2, request: twig('oak', 4) })
    await settle()
    expect(posted.map(p => p.message.id)).toEqual([2])
  })

  test('parse errors come back as errors', async () => {
    const { posted, send, settle } = await startWorker()
    send({ type: 'build', id: 1, request: { ...twig('oak'), rules: '???' } })
    await settle()
    expect(posted[0]?.message.build.ok).toBe(false)
  })
})

describe('generateLSystem', () => {
  /** A Worker that records what it is sent and answers when told. */
  class FakeWorker {
    static last: FakeWorker | undefined
    sent: Array<WorkerRequest> = []
    onmessage: ((event: { data: WorkerResponse }) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessageerror: ((event: Event) => void) | null = null
    isTerminated = false
    constructor() {
      FakeWorker.last = this
    }
    postMessage(message: WorkerRequest) {
      this.sent.push(message)
    }
    terminate() {
      this.isTerminated = true
    }
    /** Answer build `id` as the real worker would. */
    answer(id: number) {
      const request = this.sent.find(m => m.type === 'build' && m.id === id)
      if (request?.type !== 'build') throw new Error(`no build ${id}`)
      this.onmessage?.({ data: { id, build: buildNow(request.request) } })
    }
  }

  const load = async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const engine = await import('./lsystem')
    const { GeometryStore } = await import('./geometryStore')
    engine.startLSystemWorker()
    const worker = FakeWorker.last
    if (worker === undefined) throw new Error('no worker')
    return { ...engine, GeometryStore, worker }
  }

  test('posts the build to the worker and seeds the topology cache', async () => {
    const { generateLSystem, GeometryStore, worker } = await load()
    const fiber = Effect.runFork(generateLSystem(twig('oak')))
    await flush()
    expect(worker.sent).toEqual([{ type: 'build', id: 1, request: twig('oak') }])
    worker.answer(1)
    const build = await Effect.runPromise(Fiber.join(fiber))
    if (!build.ok) throw new Error('expected a plant')
    expect(GeometryStore.topologyOf(build.geometry)).toBe(build.topology)
  })

  test('a newer build supersedes the one in flight, and its late result is dropped', async () => {
    const { generateLSystem, worker } = await load()
    const first = Effect.runFork(generateLSystem(twig('oak')))
    await flush()
    const second = Effect.runFork(generateLSystem(twig('ash')))
    await flush()
    const firstExit = await Effect.runPromise(Fiber.await(first))
    expect(Exit.isFailure(firstExit) && JSON.stringify(firstExit.cause).includes('Superseded')).toBe(true)
    // The old build's result arrives anyway: ignored.
    worker.answer(1)
    await flush()
    worker.answer(2)
    const build: Build = await Effect.runPromise(Fiber.join(second))
    const expected = buildNow(twig('ash'))
    if (!build.ok || !expected.ok) throw new Error('expected plants')
    expect(Array.from(build.geometry.coords)).toEqual(Array.from(expected.geometry.coords))
  })

  test('interrupting the Effect cancels its build in the worker', async () => {
    const { generateLSystem, worker } = await load()
    const fiber = Effect.runFork(generateLSystem(twig('oak')))
    await flush()
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(worker.sent.at(-1)).toEqual({ type: 'cancel', id: 1 })
  })

  test('if the worker fails, the build runs inline, and so do later ones', async () => {
    const { generateLSystem, worker } = await load()
    const fiber = Effect.runFork(generateLSystem(twig('oak')))
    await flush()
    worker.onerror?.(new Event('error'))
    expect(worker.isTerminated).toBe(true)
    const build = await Effect.runPromise(Fiber.join(fiber))
    expect(build.ok).toBe(true)
    const later = await Effect.runPromise(generateLSystem(twig('ash')))
    expect(later.ok).toBe(true)
    expect(worker.sent).toHaveLength(1)
  })

  test('without Workers, builds run inline', async () => {
    vi.stubGlobal('Worker', undefined)
    const { generateLSystem } = await import('./lsystem')
    const build = await Effect.runPromise(generateLSystem(twig('oak')))
    const expected = buildNow(twig('oak'))
    if (!build.ok || !expected.ok) throw new Error('expected plants')
    expect(Array.from(build.geometry.parent)).toEqual(Array.from(expected.geometry.parent))
  })
})
