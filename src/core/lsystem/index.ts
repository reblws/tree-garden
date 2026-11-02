import type { Segments2D } from '../geometry'
import {
  TurtleWalker,
  bufferPreview,
  compileGrammar,
  countDerivation,
  countDraws,
  countDrawsOf,
  derivationPreview,
  productionTable,
  rewriteBuffers,
  walkInSlices,
} from './compiled'
import { type ParseError, expand, parseProductions } from './grammar'
import { interpret } from './turtle'

export { expand, parseProductions } from './grammar'
export type { Expansion, Grammar, ParseError, Production } from './grammar'
export { interpret } from './turtle'

export interface LSystemSpec {
  readonly axiom: string
  readonly rules: string
  readonly iterations: number
  readonly angle: number
  readonly jitter: number
}

export interface LSystemOutput {
  readonly geometry: Segments2D
  readonly symbolCount: number
  readonly iterationsApplied: number
  readonly truncated: boolean
  /** The start of the derived string, for display. */
  readonly preview: string
}

export type GenerateResult =
  | ({ readonly ok: true } & LSystemOutput)
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

/** Strings longer than this stop growing; 2M symbols draws in well under a
 *  second on a laptop. */
export const MAX_SYMBOLS = 2_000_000
const PREVIEW_LENGTH = 600
const HEADING = 90

/** Parse, rewrite and interpret in one call. `random` is consumed by
 *  stochastic productions first and then by angle jitter. */
export const generate = (spec: LSystemSpec, random: () => number, maxSymbols = MAX_SYMBOLS): GenerateResult => {
  const steps = generateSteps(spec, random, maxSymbols)
  for (;;) {
    const step = steps.next()
    if (step.done === true) return step.value
  }
}

/**
 * `generate`, as a generator that yields between stages (after parsing,
 * after each rewriting iteration, and every `WALK_SLICE` symbols of the
 * turtle's walk, a few milliseconds apart), so a caller can give up on a
 * build that is no longer wanted. Draining it gives exactly
 * `generate`'s result.
 *
 * The derived string is never built (see compiled.ts) unless the
 * grammar's alphabet is too large for byte ids; then it falls back to
 * `expand` and `interpret`.
 */
export function* generateSteps(
  spec: LSystemSpec,
  random: () => number,
  maxSymbols = MAX_SYMBOLS,
): Generator<void, GenerateResult> {
  const parsed = parseProductions(spec.rules)
  if (!parsed.ok) {
    return parsed
  }
  const axiom = spec.axiom.replace(/\s+/g, '')
  const turtle = { angleDegrees: spec.angle, angleJitter: spec.jitter, headingDegrees: HEADING }
  const grammar = compileGrammar(axiom, parsed.productions)
  yield

  if (grammar === undefined) {
    const expansion = expand({ axiom, productions: parsed.productions }, spec.iterations, random, maxSymbols)
    yield
    return {
      ok: true,
      geometry: interpret(expansion.result, turtle, random),
      symbolCount: expansion.result.length,
      iterationsApplied: expansion.iterations,
      truncated: expansion.truncated,
      preview: expansion.result.slice(0, PREVIEW_LENGTH),
    }
  }

  if (!grammar.isStochastic) {
    // Deterministic: walk the derivation straight from the productions.
    const derivation = countDerivation(grammar, spec.iterations, maxSymbols)
    const table = productionTable(grammar)
    const walker = new TurtleWalker(
      table.data,
      table.axiomStart,
      table.axiomEnd,
      table.start,
      table.hasRule,
      derivation.iterations,
      grammar.action,
      countDrawsOf(grammar, derivation.counts),
      turtle,
      random,
    )
    const geometry = yield* walkInSlices(walker)
    return {
      ok: true,
      geometry,
      symbolCount: derivation.symbolCount,
      iterationsApplied: derivation.iterations,
      truncated: derivation.truncated,
      preview: derivationPreview(grammar, derivation.iterations, PREVIEW_LENGTH),
    }
  }

  // Stochastic: rewrite over byte buffers, then walk the result.
  const derivation = yield* rewriteBuffers(grammar, spec.iterations, random, maxSymbols)
  const { buffer, symbolCount } = derivation
  yield
  const walker = new TurtleWalker(
    buffer,
    0,
    symbolCount,
    new Int32Array(1),
    new Uint8Array(256),
    0,
    grammar.action,
    countDraws(grammar.action, buffer, symbolCount),
    turtle,
    random,
  )
  const geometry = yield* walkInSlices(walker)
  return {
    ok: true,
    geometry,
    symbolCount,
    iterationsApplied: derivation.iterations,
    truncated: derivation.truncated,
    preview: bufferPreview(grammar, buffer, Math.min(PREVIEW_LENGTH, symbolCount)),
  }
}
