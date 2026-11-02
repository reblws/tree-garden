import { describe, expect, it } from 'vitest'

import { SOFTWARE_RENDERER, createGpuInk } from './gpuInk'

describe('createGpuInk', () => {
  it('declines without WebGL2, so the painters stay on Canvas2D', () => {
    // happy-dom has no WebGL.
    expect(createGpuInk(() => undefined)).toBeUndefined()
  })

  it('knows software rasterisers by name', () => {
    for (const name of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader',
      'llvmpipe (LLVM 15.0.7, 256 bits)',
      'Microsoft Basic Render Driver',
    ]) {
      expect(SOFTWARE_RENDERER.test(name)).toBe(true)
    }
    for (const name of ['ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)', 'WebKit WebGL', 'Mali-G78', 'Adreno (TM) 740']) {
      expect(SOFTWARE_RENDERER.test(name)).toBe(false)
    }
  })
})
