import { afterEach, expect, test, vi } from 'vitest'

import { readPalette } from './palette'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

test.each([
  { scheme: 'light', systemDark: true, isDark: false, blend: 'multiply', union: 'darken' },
  { scheme: 'dark', systemDark: false, isDark: true, blend: 'screen', union: 'lighten' },
])('the $scheme selection controls ink compositing even with the opposite system theme', ({ scheme, systemDark, isDark, blend, union }) => {
  vi.stubGlobal('matchMedia', () => ({ matches: systemDark }))
  const element = document.createElement('div')
  element.style.colorScheme = scheme
  document.body.append(element)
  const palette = readPalette(element)
  expect(palette.isDark).toBe(isDark)
  expect(palette.blend).toBe(blend)
  expect(palette.union).toBe(union)
})
