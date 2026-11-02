// REFERENCE: a frozen copy of src/core/lsystem/grammar.ts as of commit 0648f8c,
// before the performance work. src/test/determinism.test.ts checks the
// optimised code against it byte for byte. Do not optimise or edit it.
/**
 * L-system grammar: parsing production rules and rewriting strings.
 *
 * Pure TypeScript, no Effect, no DOM. Randomness is injected as a plain
 * `() => number` so callers decide where it comes from (a seeded Effect
 * Random service in the app, a fixed sequence in tests).
 */

/** A single production `predecessor -> successor`, chosen with `weight` when
 *  several productions share a predecessor (a stochastic L-system). */
export interface Production {
  readonly predecessor: string
  readonly successor: string
  readonly weight: number
}

export interface Grammar {
  readonly axiom: string
  readonly productions: ReadonlyArray<Production>
}

export interface ParseError {
  readonly line: number
  readonly message: string
}

export type ParseResult =
  | { readonly ok: true; readonly productions: ReadonlyArray<Production> }
  | { readonly ok: false; readonly errors: ReadonlyArray<ParseError> }

// `F -> FF`, `F (0.33) -> F[+F]F`, also accepts `=`, `→` and `:` as arrows.
const RULE = /^(\S)\s*(?:\(\s*([0-9]*\.?[0-9]+)\s*\))?\s*(?:->|→|=|:)\s*(.*)$/

/**
 * Parse one production per line. Blank lines and lines starting with `#` or
 * `//` are ignored. Whitespace inside a successor is dropped, so
 * `F[+F] F[-F] F` reads the same as `F[+F]F[-F]F`.
 */
export const parseProductions = (text: string): ParseResult => {
  const productions: Array<Production> = []
  const errors: Array<ParseError> = []

  text.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('//')) {
      return
    }
    const match = RULE.exec(line)
    if (match === null) {
      errors.push({
        line: index + 1,
        message: `Expected "A -> successor" or "A (0.5) -> successor", got "${line}"`,
      })
      return
    }
    const [, predecessor = '', weightText, successor = ''] = match
    const weight = weightText === undefined ? 1 : Number(weightText)
    if (!(weight > 0)) {
      errors.push({ line: index + 1, message: 'Weight must be greater than 0' })
      return
    }
    productions.push({
      predecessor,
      successor: successor.replace(/\s+/g, ''),
      weight,
    })
  })

  return errors.length > 0 ? { ok: false, errors } : { ok: true, productions }
}

/** Productions grouped by predecessor with cumulative weights, so picking a
 *  stochastic successor is one random draw plus a short scan. */
interface RuleTable {
  readonly get: (symbol: string) => CompiledRule | undefined
}

interface CompiledRule {
  readonly successors: ReadonlyArray<string>
  readonly cumulative: ReadonlyArray<number>
  readonly total: number
}

const compile = (productions: ReadonlyArray<Production>): RuleTable => {
  const grouped = new Map<string, { successors: Array<string>; cumulative: Array<number>; total: number }>()
  for (const { predecessor, successor, weight } of productions) {
    const rule = grouped.get(predecessor) ?? { successors: [], cumulative: [], total: 0 }
    rule.total += weight
    rule.successors.push(successor)
    rule.cumulative.push(rule.total)
    grouped.set(predecessor, rule)
  }
  return { get: symbol => grouped.get(symbol) }
}

const pick = (rule: CompiledRule, random: () => number): string => {
  if (rule.successors.length === 1) {
    return rule.successors[0] ?? ''
  }
  const target = random() * rule.total
  const index = rule.cumulative.findIndex(bound => target < bound)
  return rule.successors[index === -1 ? rule.successors.length - 1 : index] ?? ''
}

export interface Expansion {
  /** The derived string after the last completed iteration. */
  readonly result: string
  /** Length of the string after each iteration, starting with the axiom. */
  readonly lengths: ReadonlyArray<number>
  /** Iterations actually applied; lower than requested when `truncated`. */
  readonly iterations: number
  /** True when the next iteration would have exceeded `maxSymbols`. */
  readonly truncated: boolean
}

/**
 * Apply the productions to the axiom `iterations` times, rewriting every
 * symbol in parallel (that parallelism is what separates L-systems from
 * Chomsky grammars). Symbols without a production are copied unchanged.
 *
 * Stops early, keeping the last complete string, if an iteration would
 * produce more than `maxSymbols` symbols.
 */
export const expand = (
  grammar: Grammar,
  iterations: number,
  random: () => number,
  maxSymbols: number,
): Expansion => {
  const rules = compile(grammar.productions)
  let current = grammar.axiom
  const lengths = [current.length]

  for (let step = 0; step < iterations; step++) {
    const parts: Array<string> = []
    let length = 0
    for (let i = 0; i < current.length; i++) {
      const symbol = current[i] ?? ''
      const rule = rules.get(symbol)
      const replacement = rule === undefined ? symbol : pick(rule, random)
      length += replacement.length
      if (length > maxSymbols) {
        return { result: current, lengths, iterations: step, truncated: true }
      }
      parts.push(replacement)
    }
    current = parts.join('')
    lengths.push(current.length)
  }

  return { result: current, lengths, iterations, truncated: false }
}
