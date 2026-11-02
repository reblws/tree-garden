import { type Segments2D, emptyBounds } from '../geometry'
import type { Production } from './grammar'

/**
 * The fast generator: the same plant as `expand` + `interpret`, bit for
 * bit, without building the derived string.
 *
 * Symbols are compiled to dense byte ids. A deterministic grammar (one
 * production per symbol) is never expanded at all: the turtle walks the
 * derivation depth first, straight from the productions, so memory stays
 * O(iterations) and the 2M-symbol string never exists; symbol counts come
 * from per-symbol count vectors. A stochastic grammar is rewritten over
 * byte buffers, drawing from `random` in exactly the order `expand` does,
 * and the turtle then walks the buffer.
 *
 * Every hot loop sits in its own function, apart from the set-up code, and
 * the turtle keeps its state in locals within a slice of its walk.
 */

/** What the turtle does with a symbol. */
const NONE = 0
const DRAW = 1
const MOVE = 2
const LEFT = 3
const RIGHT = 4
const TURN = 5
const PUSH = 6
const POP = 7

const actionOf = (code: number): number =>
  code === 70 /* F */ || code === 71 /* G */
    ? DRAW
    : code === 102 /* f */ || code === 103 /* g */
      ? MOVE
      : code === 43 /* + */
        ? LEFT
        : code === 45 /* - */
          ? RIGHT
          : code === 124 /* | */
            ? TURN
            : code === 91 /* [ */
              ? PUSH
              : code === 93 /* ] */
                ? POP
                : NONE

/** Ids fit in a byte. */
const MAX_ALPHABET = 256

export interface CompiledGrammar {
  /** Code unit of each id. */
  readonly codes: ReadonlyArray<number>
  readonly axiom: Uint8Array
  /** Per id with productions: the successors, cumulative weights and their
   *  total, grouped and accumulated exactly as grammar.ts does. */
  readonly successors: ReadonlyArray<ReadonlyArray<Uint8Array> | undefined>
  readonly cumulative: ReadonlyArray<ReadonlyArray<number> | undefined>
  readonly total: ReadonlyArray<number>
  /** Some symbol has more than one production. */
  readonly isStochastic: boolean
  /** Turtle action per id. */
  readonly action: Uint8Array
}

/** Compile the grammar to byte ids, or `undefined` if its alphabet has
 *  more than 256 symbols (then use the string path). */
export const compileGrammar = (
  axiom: string,
  productions: ReadonlyArray<Production>,
): CompiledGrammar | undefined => {
  const codes: Array<number> = []
  const idOf = new Map<number, number>()
  const id = (code: number): number => {
    let value = idOf.get(code)
    if (value === undefined) {
      value = codes.length
      codes.push(code)
      idOf.set(code, value)
    }
    return value
  }
  const toIds = (text: string): Uint8Array => {
    const ids = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) ids[i] = id(text.charCodeAt(i)) & 0xff
    return ids
  }
  const axiomIds = toIds(axiom)
  const successors: Array<Array<Uint8Array> | undefined> = []
  const cumulative: Array<Array<number> | undefined> = []
  const total: Array<number> = []
  let isStochastic = false
  for (const { predecessor, successor, weight } of productions) {
    // The parser reads a predecessor as one code unit.
    if (predecessor.length !== 1) return undefined
    const p = id(predecessor.charCodeAt(0))
    const ids = toIds(successor)
    const list = successors[p] ?? []
    const bounds = cumulative[p] ?? []
    const sum = (total[p] ?? 0) + weight
    list.push(ids)
    bounds.push(sum)
    successors[p] = list
    cumulative[p] = bounds
    total[p] = sum
    if (list.length > 1) isStochastic = true
  }
  if (codes.length > MAX_ALPHABET) return undefined
  const action = new Uint8Array(MAX_ALPHABET)
  for (let s = 0; s < codes.length; s++) action[s] = actionOf(codes[s] as number)
  return { codes, axiom: axiomIds, successors, cumulative, total, isStochastic, action }
}

// ------------------------------------------------------------- derivation

/** How a derivation went, as `expand` reports it. */
export interface Derivation {
  readonly symbolCount: number
  readonly iterations: number
  readonly truncated: boolean
}

/**
 * Deterministic grammars: how many of each symbol there are after each
 * iteration, stopping (like `expand`) before the length passes
 * `maxSymbols`. Counts stay far below 2^53, so they are exact.
 */
export const countDerivation = (
  grammar: CompiledGrammar,
  iterations: number,
  maxSymbols: number,
): Derivation & { readonly counts: Float64Array } => {
  const k = grammar.codes.length
  let counts = new Float64Array(k)
  for (const s of grammar.axiom) counts[s] = (counts[s] as number) + 1
  let length = grammar.axiom.length
  for (let step = 0; step < iterations; step++) {
    const next = new Float64Array(k)
    for (let s = 0; s < k; s++) {
      const n = counts[s] as number
      if (n === 0) continue
      const successor = grammar.successors[s]?.[0]
      if (successor === undefined) next[s] = (next[s] as number) + n
      else for (const t of successor) next[t] = (next[t] as number) + n
    }
    let nextLength = 0
    for (let s = 0; s < k; s++) nextLength += next[s] as number
    // Every replacement adds to the length, so the partial sums `expand`
    // checks pass `maxSymbols` exactly when the total does.
    if (nextLength > maxSymbols) return { counts, symbolCount: length, iterations: step, truncated: true }
    counts = next
    length = nextLength
  }
  return { counts, symbolCount: length, iterations, truncated: false }
}

/** Successors flattened for the depth-first walk: id `s` rewrites to
 *  `data[start[s] .. start[s + 1])`; the axiom sits at the end. */
export interface ProductionTable {
  readonly data: Uint8Array
  readonly start: Int32Array
  readonly hasRule: Uint8Array
  readonly axiomStart: number
  readonly axiomEnd: number
}

export const productionTable = (grammar: CompiledGrammar): ProductionTable => {
  const k = grammar.codes.length
  const start = new Int32Array(k + 1)
  const hasRule = new Uint8Array(MAX_ALPHABET)
  let size = 0
  for (let s = 0; s < k; s++) {
    start[s] = size
    const successor = grammar.successors[s]?.[0]
    if (successor !== undefined) {
      hasRule[s] = 1
      size += successor.length
    }
  }
  start[k] = size
  const data = new Uint8Array(size + grammar.axiom.length)
  for (let s = 0; s < k; s++) {
    const successor = grammar.successors[s]?.[0]
    if (successor !== undefined) data.set(successor, start[s])
  }
  data.set(grammar.axiom, size)
  return { data, start, hasRule, axiomStart: size, axiomEnd: size + grammar.axiom.length }
}

/** The first `length` symbols of a deterministic derivation, by the same
 *  depth-first walk. */
export const derivationPreview = (grammar: CompiledGrammar, iterations: number, length: number): string => {
  const out: Array<number> = []
  const walk = (s: number, depth: number): boolean => {
    const successor = grammar.successors[s]?.[0]
    if (depth === iterations || successor === undefined) {
      out.push(grammar.codes[s] as number)
      return out.length < length
    }
    for (const t of successor) if (!walk(t, depth + 1)) return false
    return true
  }
  for (const s of grammar.axiom) if (!walk(s, 0)) break
  return String.fromCharCode(...out)
}

/** A rewritten stochastic derivation: ids in `buffer[0 .. length)`. */
export interface BufferDerivation extends Derivation {
  readonly buffer: Uint8Array
}

/** One iteration's result, or `undefined` when it would pass the cap. */
interface Rewrite {
  readonly buffer: Uint8Array
  readonly length: number
}

/**
 * Stochastic grammars: rewrite over byte buffers, as `expand` does over
 * strings. A generator, yielding after each iteration, so a caller can
 * stop between them.
 */
export function* rewriteBuffers(
  grammar: CompiledGrammar,
  iterations: number,
  random: () => number,
  maxSymbols: number,
): Generator<void, BufferDerivation> {
  let current = grammar.axiom
  let length = current.length
  let longest = 1
  for (const list of grammar.successors) for (const successor of list ?? []) longest = Math.max(longest, successor.length)
  let spare: Uint8Array | undefined
  for (let step = 0; step < iterations; step++) {
    const capacity = Math.max(16, Math.min(maxSymbols, length * longest))
    const target = spare !== undefined && spare.length >= capacity ? spare : new Uint8Array(capacity)
    const next = rewriteOnce(grammar, current, length, target, random, maxSymbols)
    if (next < 0) return { buffer: current, symbolCount: length, iterations: step, truncated: true }
    spare = current === grammar.axiom ? undefined : current
    current = target
    length = next
    yield
  }
  return { buffer: current, symbolCount: length, iterations, truncated: false }
}

/** Rewrite `source[0 .. length)` into `target`; the new length, or -1 if
 *  it would pass `maxSymbols` (like `expand`, after drawing for the symbol
 *  that passes it). */
const rewriteOnce = (
  grammar: CompiledGrammar,
  source: Uint8Array,
  length: number,
  target: Uint8Array,
  random: () => number,
  maxSymbols: number,
): number => {
  const { successors, cumulative, total } = grammar
  let o = 0
  for (let i = 0; i < length; i++) {
    const s = source[i] as number
    const list = successors[s]
    if (list === undefined) {
      if (o + 1 > maxSymbols) return -1
      target[o++] = s
      continue
    }
    let successor: Uint8Array
    if (list.length === 1) {
      successor = list[0] as Uint8Array
    } else {
      // Same as grammar.ts `pick`: one draw, the first bound above it.
      const bounds = cumulative[s] as ReadonlyArray<number>
      const draw = random() * (total[s] as number)
      let k = 0
      while (k < bounds.length && !(draw < (bounds[k] as number))) k++
      successor = list[k === bounds.length ? list.length - 1 : k] as Uint8Array
    }
    if (o + successor.length > maxSymbols) return -1
    target.set(successor, o)
    o += successor.length
  }
  return o
}

/** The first `length` ids of `buffer`, as text. */
export const bufferPreview = (grammar: CompiledGrammar, buffer: Uint8Array, length: number): string => {
  const out: Array<number> = []
  for (let i = 0; i < length; i++) out.push(grammar.codes[buffer[i] as number] as number)
  return String.fromCharCode(...out)
}

/** Draw commands in `buffer[0 .. length)`: the turtle's capacity. */
export const countDraws = (action: Uint8Array, buffer: Uint8Array, length: number): number => {
  let draws = 0
  for (let i = 0; i < length; i++) if (action[buffer[i] as number] === DRAW) draws++
  return draws
}

/** Draw commands in a deterministic derivation, from its counts. */
export const countDrawsOf = (grammar: CompiledGrammar, counts: Float64Array): number => {
  let draws = 0
  for (let s = 0; s < grammar.codes.length; s++) if (grammar.action[s] === DRAW) draws += counts[s] as number
  return draws
}

// ------------------------------------------------------------------ turtle

export interface TurtleWalk {
  readonly angleDegrees: number
  readonly angleJitter: number
  readonly headingDegrees: number
}

const DEG = Math.PI / 180

/** Symbols per slice of a walk: a few milliseconds of work. */
export const WALK_SLICE = 1 << 18

/**
 * The turtle of turtle.ts over a depth-first walk: symbols `data[from ..
 * to)` are read in order, and while `depth < depthLimit`, a symbol with a
 * production is replaced by its successor `data[start[s] .. start[s + 1])`
 * one level down. With `depthLimit` 0 it simply reads a buffer.
 *
 * Every number is computed by the same expression in the same order as
 * turtle.ts, so the output is identical. Runs of `F` share a heading and
 * reuse its cosine and sine (same input, same result).
 *
 * The walk can be done in slices (`walk(budget)`), so a caller can stop
 * between them; the state is kept in fields between slices and in locals
 * within one.
 */
export class TurtleWalker {
  readonly #data: Uint8Array
  readonly #start: Int32Array
  readonly #hasRule: Uint8Array
  readonly #depthLimit: number
  readonly #action: Uint8Array
  readonly #delta: number
  readonly #jitter: number
  readonly #random: () => number
  readonly #coords: Float32Array
  readonly #depth: Uint16Array
  readonly #parent: Int32Array
  readonly #arrival: Float32Array
  readonly #positions: Int32Array
  readonly #ends: Int32Array

  #x = 0
  #y = 0
  #heading: number
  #level = 0
  #distance = 0
  #last = -1
  #stack = new Float64Array(6 * 64)
  #sp = 0
  #count = 0
  #maxDepth = 0
  #maxArrival = 0
  #minX = 0
  #minY = 0
  #maxX = 0
  #maxY = 0
  #cosHeading: number
  #sinHeading: number
  #trigHeading: number
  #d = 0
  #p: number
  #e: number
  #isDone = false

  constructor(
    data: Uint8Array,
    from: number,
    to: number,
    start: Int32Array,
    hasRule: Uint8Array,
    depthLimit: number,
    action: Uint8Array,
    capacity: number,
    options: TurtleWalk,
    random: () => number,
  ) {
    this.#data = data
    this.#start = start
    this.#hasRule = hasRule
    this.#depthLimit = depthLimit
    this.#action = action
    this.#delta = options.angleDegrees * DEG
    this.#jitter = options.angleJitter
    this.#random = random
    this.#coords = new Float32Array(capacity * 4)
    this.#depth = new Uint16Array(capacity)
    this.#parent = new Int32Array(capacity)
    this.#arrival = new Float32Array(capacity)
    this.#positions = new Int32Array(depthLimit + 1)
    this.#ends = new Int32Array(depthLimit + 1)
    this.#heading = options.headingDegrees * DEG
    this.#trigHeading = this.#heading
    this.#cosHeading = Math.cos(this.#heading)
    this.#sinHeading = Math.sin(this.#heading)
    this.#p = from
    this.#e = to
  }

  /** Walk up to `budget` symbols; true once the walk is complete. */
  walk(budget: number): boolean {
    if (this.#isDone) return true
    const data = this.#data
    const start = this.#start
    const hasRule = this.#hasRule
    const depthLimit = this.#depthLimit
    const action = this.#action
    const delta = this.#delta
    const jitter = this.#jitter
    const random = this.#random
    const coords = this.#coords
    const depth = this.#depth
    const parent = this.#parent
    const arrival = this.#arrival
    const positions = this.#positions
    const ends = this.#ends
    let x = this.#x
    let y = this.#y
    let heading = this.#heading
    let level = this.#level
    let distance = this.#distance
    let last = this.#last
    let stack = this.#stack
    let sp = this.#sp
    let count = this.#count
    let maxDepth = this.#maxDepth
    let maxArrival = this.#maxArrival
    let minX = this.#minX
    let minY = this.#minY
    let maxX = this.#maxX
    let maxY = this.#maxY
    let cosHeading = this.#cosHeading
    let sinHeading = this.#sinHeading
    let trigHeading = this.#trigHeading
    let d = this.#d
    let p = this.#p
    let e = this.#e
    let left = budget
    let isDone = false

    for (;;) {
      if (left === 0) break
      left--
      if (p === e) {
        if (d === 0) {
          isDone = true
          break
        }
        d--
        p = positions[d] as number
        e = ends[d] as number
        continue
      }
      const s = data[p++] as number
      if (d < depthLimit && hasRule[s] === 1) {
        positions[d] = p
        ends[d] = e
        d++
        p = start[s] as number
        e = start[s + 1] as number
        continue
      }
      const a = action[s] as number
      if (a === NONE) continue
      if (a === DRAW || a === MOVE) {
        if (heading !== trigHeading) {
          trigHeading = heading
          cosHeading = Math.cos(heading)
          sinHeading = Math.sin(heading)
        }
        const nx = x + cosHeading
        const ny = y + sinHeading
        if (a === DRAW) {
          const o = count * 4
          coords[o] = x
          coords[o + 1] = y
          coords[o + 2] = nx
          coords[o + 3] = ny
          depth[count] = level
          parent[count] = last
          arrival[count] = distance
          last = count
          count++
          if (level > maxDepth) maxDepth = level
          if (distance + 1 > maxArrival) maxArrival = distance + 1
        } else {
          // A move without drawing breaks the stroke.
          last = -1
        }
        x = nx
        y = ny
        distance += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      } else if (a === LEFT) {
        heading += jitter > 0 ? delta * (1 + jitter * (2 * random() - 1)) : delta
      } else if (a === RIGHT) {
        heading -= jitter > 0 ? delta * (1 + jitter * (2 * random() - 1)) : delta
      } else if (a === TURN) {
        heading += Math.PI
      } else if (a === PUSH) {
        if (sp + 6 > stack.length) {
          const grown = new Float64Array(stack.length * 2)
          grown.set(stack)
          stack = grown
        }
        stack[sp] = x
        stack[sp + 1] = y
        stack[sp + 2] = heading
        stack[sp + 3] = level
        stack[sp + 4] = distance
        stack[sp + 5] = last
        sp += 6
        level++
      } else if (sp > 0) {
        sp -= 6
        x = stack[sp] as number
        y = stack[sp + 1] as number
        heading = stack[sp + 2] as number
        level = stack[sp + 3] as number
        distance = stack[sp + 4] as number
        last = stack[sp + 5] as number
      }
    }

    this.#x = x
    this.#y = y
    this.#heading = heading
    this.#level = level
    this.#distance = distance
    this.#last = last
    this.#stack = stack
    this.#sp = sp
    this.#count = count
    this.#maxDepth = maxDepth
    this.#maxArrival = maxArrival
    this.#minX = minX
    this.#minY = minY
    this.#maxX = maxX
    this.#maxY = maxY
    this.#cosHeading = cosHeading
    this.#sinHeading = sinHeading
    this.#trigHeading = trigHeading
    this.#d = d
    this.#p = p
    this.#e = e
    this.#isDone = isDone
    return isDone
  }

  /** The segments drawn so far (all of them, once the walk is complete). */
  result(): Segments2D {
    const count = this.#count
    return {
      count,
      coords: this.#coords,
      depth: this.#depth,
      parent: this.#parent,
      arrival: this.#arrival,
      maxDepth: this.#maxDepth,
      maxArrival: this.#maxArrival,
      bounds: count === 0 ? emptyBounds : { minX: this.#minX, minY: this.#minY, maxX: this.#maxX, maxY: this.#maxY },
    }
  }
}

/** Walk a TurtleWalker in slices, yielding between them. */
export function* walkInSlices(walker: TurtleWalker): Generator<void, Segments2D> {
  while (!walker.walk(WALK_SLICE)) yield
  return walker.result()
}
