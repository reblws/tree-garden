import { Schema } from 'effect'

export const Theme = Schema.Literals(['Light', 'Dark'])
export type Theme = typeof Theme.Type

const STORAGE_KEY = 'tree-garden-theme'

/** The proposal opens in dark mode; an explicit choice survives visits. */
export const readTheme = (): Theme => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'Light' ? 'Light' : 'Dark'
  } catch {
    return 'Dark'
  }
}

export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme.toLowerCase()
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // Private browsing may disable storage; the switch still works.
  }
}
