import { describe, expect, test } from 'vitest'

import type { Segments2D } from '../core/geometry'
import { makeCanvas } from './canvas'
import { crc32, printBands, printPixels, sheetPixels, withResolution } from './print'
import { transferableCopy } from './printProtocol'

describe('printBands', () => {
  test('an A3 sheet is seven bands that tile it exactly, each padded for the blurs inside the sheet', () => {
    const { width, height } = printPixels('A3')
    const bands = printBands(width, height)
    expect(bands).toHaveLength(7)
    expect(bands[0]?.top).toBe(0)
    expect(bands.at(-1)?.bottom).toBe(height)
    for (const [i, band] of bands.entries()) {
      if (i > 0) expect(band.top).toBe(bands[i - 1]?.bottom)
      expect(band.from).toBe(Math.max(0, band.top - 64))
      expect(band.to).toBe(Math.min(height, band.bottom + 64))
      expect(width * (band.bottom - band.top)).toBeLessThanOrEqual(2_500_000)
    }
  })

  test('the partition is the one the prints have always used (it shapes the bytes)', () => {
    expect(printBands(...Object.values(printPixels('A4')) as [number, number]).map(b => b.top)).toEqual([0, 1008, 2016, 3024])
    const a2 = printPixels('A2')
    expect(printBands(a2.width, a2.height)).toHaveLength(14)
    const landscape = sheetPixels('A3', 'Landscape')
    expect(landscape).toEqual({ width: 4961, height: 3508 })
    expect(printBands(landscape.width, landscape.height)).toHaveLength(7)
  })
})

describe('withResolution', () => {
  // A 1 × 1 PNG: signature, IHDR, IDAT, IEND.
  const png = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    c => c.charCodeAt(0),
  )

  test('a pHYs chunk for 300 dpi goes straight after the header; the rest is untouched', async () => {
    const tagged = new Uint8Array(await (await withResolution(new Blob([png]), 300)).arrayBuffer())
    expect(tagged.length).toBe(png.length + 21)
    expect(tagged.subarray(0, 33)).toEqual(png.subarray(0, 33))
    expect(tagged.subarray(54)).toEqual(png.subarray(33))
    const chunk = new DataView(tagged.buffer, 33, 21)
    expect(chunk.getUint32(0)).toBe(9)
    expect(String.fromCharCode(...tagged.subarray(37, 41))).toBe('pHYs')
    expect(chunk.getUint32(8)).toBe(11811) // 300 dpi in px per metre
    expect(chunk.getUint32(12)).toBe(11811)
    expect(tagged[49]).toBe(1)
    expect(chunk.getUint32(17)).toBe(crc32(tagged.subarray(37, 50)))
  })

  test('anything that isn’t a PNG is passed through', async () => {
    const blob = new Blob(['not a png at all, but long enough to have a header'])
    expect(await withResolution(blob, 300)).toBe(blob)
  })

  test('crc32 is the PNG one', () => {
    expect(crc32(new TextEncoder().encode('IEND'))).toBe(0xae426082)
  })
})

describe('transferableCopy', () => {
  test('copies every array, so transferring it leaves the store’s geometry whole', () => {
    const geometry: Segments2D = {
      count: 2,
      coords: Float32Array.of(0, 0, 0, 1, 0, 1, 1, 2),
      depth: Uint16Array.of(0, 1),
      parent: Int32Array.of(-1, 0),
      arrival: Float32Array.of(0, 1),
      maxDepth: 1,
      maxArrival: 2.4,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 2 },
    }
    const { geometry: copy, transfer } = transferableCopy(geometry)
    expect(copy).toEqual(geometry)
    expect(transfer).toHaveLength(4)
    for (const key of ['coords', 'depth', 'parent', 'arrival'] as const) {
      expect(copy[key]).not.toBe(geometry[key])
      expect(transfer).toContain(copy[key].buffer)
    }
    structuredClone(copy, { transfer })
    expect(geometry.coords).toHaveLength(8)
  })
})

describe('makeCanvas', () => {
  test('with a DOM, a canvas element of the size asked for', () => {
    const canvas = makeCanvas(7, 5)
    expect(canvas.tagName).toBe('CANVAS')
    expect([canvas.width, canvas.height]).toEqual([7, 5])
  })
})
