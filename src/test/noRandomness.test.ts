import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

/**
 * Same link, same plant, same print: the generator and the renderer must
 * never draw on an unseeded source of randomness or on the clock for what
 * they paint. Randomness comes from Effect's seeded `Random` (engine) or is
 * hashed from segment and chain indices (render). `performance.now()` is
 * allowed: it only schedules work (slices, budgets), never what is drawn.
 *
 * A cheap tripwire rather than a proof: it reads the source, with comments
 * stripped, so it can't see randomness that arrives through an import from
 * elsewhere.
 */
const ROOTS = ['src/core', 'src/render', 'src/engine']
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['crypto.getRandomValues', /\bgetRandomValues\b/],
  ['crypto.randomUUID', /\brandomUUID\b/],
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date()', /\bnew\s+Date\s*\(/],
]

const sourceFiles = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })

/** Blank out comments, keeping line numbers. Strings are left alone; none of
 *  the forbidden names belong in a string in these modules either. */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')

describe('no unseeded randomness in core, render or engine', () => {
  const root = process.cwd()
  const files = ROOTS.flatMap(dir => sourceFiles(join(root, dir)))

  test('finds the modules to check', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  test.each(files.map(file => [relative(root, file), file] as const))('%s', (_name, file) => {
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n')
    const hits = lines.flatMap((line, index) =>
      FORBIDDEN.filter(([, pattern]) => pattern.test(line)).map(([name]) => `line ${index + 1}: ${name}`),
    )
    expect(hits).toEqual([])
  })
})
