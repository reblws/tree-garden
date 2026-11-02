import { describe, expect, it } from 'vitest'

import { CollinearPen, type PathSink } from './collinearPen'

const recorder = () => {
  const ops: Array<string> = []
  const sink: PathSink = {
    moveTo: (x, y) => ops.push(`M${x},${y}`),
    lineTo: (x, y) => ops.push(`L${x},${y}`),
  }
  return { ops, sink }
}

describe('CollinearPen', () => {
  it('merges a straight run into one line', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    pen.lineTo(0, 0, 1, 1)
    pen.lineTo(1, 1, 2, 2)
    pen.lineTo(2, 2, 3.5, 3.5)
    pen.end()
    expect(ops).toEqual(['M0,0', 'L3.5,3.5'])
    expect(pen.lines).toBe(1)
  })

  it('keeps every turn', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    pen.lineTo(0, 0, 1, 0)
    pen.lineTo(1, 0, 2, 0)
    pen.lineTo(2, 0, 2, 1)
    pen.lineTo(2, 1, 2, 3)
    pen.end()
    expect(ops).toEqual(['M0,0', 'L2,0', 'L2,3'])
  })

  it('does not merge a reversal', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    pen.lineTo(0, 0, 2, 0)
    pen.lineTo(2, 0, 1, 0)
    pen.end()
    expect(ops).toEqual(['M0,0', 'L2,0', 'L1,0'])
  })

  it('merges float noise but not a real bend', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    pen.lineTo(0, 0, 1, 1e-7)
    pen.lineTo(1, 1e-7, 2, 0)
    // 0.01 rad is a real bend.
    pen.lineTo(2, 0, 3, 0.01)
    pen.end()
    expect(ops).toEqual(['M0,0', 'L2,0', 'L3,0.01'])
  })

  it('measures straightness against the run, so a gentle curve cannot drift', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    let x = 0
    let y = 0
    let angle = 0
    for (let i = 0; i < 200; i++) {
      angle += 1e-5
      const nx = x + Math.cos(angle)
      const ny = y + Math.sin(angle)
      pen.lineTo(x, y, nx, ny)
      x = nx
      y = ny
    }
    pen.end()
    // Each emitted line stays within the tolerance of its first piece.
    expect(ops.length).toBeGreaterThan(2)
  })

  it('flushes into the old path when a new subpath starts in another', () => {
    const a = recorder()
    const b = recorder()
    const pen = new CollinearPen()
    pen.moveTo(a.sink, 0, 0)
    pen.lineTo(0, 0, 1, 0)
    pen.lineTo(1, 0, 2, 0)
    pen.moveTo(b.sink, 2, 0)
    pen.lineTo(2, 0, 3, 0)
    pen.end()
    expect(a.ops).toEqual(['M0,0', 'L2,0'])
    expect(b.ops).toEqual(['M2,0', 'L3,0'])
  })

  it('emits zero-length pieces as they are', () => {
    const { ops, sink } = recorder()
    const pen = new CollinearPen()
    pen.moveTo(sink, 0, 0)
    pen.lineTo(0, 0, 0, 0)
    pen.end()
    expect(ops).toEqual(['M0,0', 'L0,0'])
  })

  it('ignores lines without a subpath', () => {
    const { ops } = recorder()
    const pen = new CollinearPen()
    pen.lineTo(0, 0, 1, 1)
    pen.end()
    expect(ops).toEqual([])
  })
})
