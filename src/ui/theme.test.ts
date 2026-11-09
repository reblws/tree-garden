import { afterEach, expect, test, vi } from 'vitest'

import { applyTheme, readTheme } from './theme'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

test('the explicit theme survives a new visit', () => {
  applyTheme('Light')
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(readTheme()).toBe('Light')
  applyTheme('Dark')
  expect(document.documentElement.dataset.theme).toBe('dark')
  expect(readTheme()).toBe('Dark')
})

test('a first visit or an invalid saved preference opens in dark mode', () => {
  expect(readTheme()).toBe('Dark')
  localStorage.setItem('tree-garden-theme', 'invalid')
  expect(readTheme()).toBe('Dark')
})

test('the switch still works when storage is unavailable', () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Storage disabled') })
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
  expect(readTheme()).toBe('Dark')
  expect(() => applyTheme('Light')).not.toThrow()
  expect(document.documentElement.dataset.theme).toBe('light')
})
