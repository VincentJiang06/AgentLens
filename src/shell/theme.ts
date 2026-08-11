import { useSyncExternalStore } from 'react'

/**
 * Theme lives outside React so the first paint is already correct: importing
 * this module applies `data-theme` to :root, and `index.css` keys its palette
 * off that attribute.
 *
 * `'system'` follows `prefers-color-scheme` live. Choosing 'light' or 'dark' is
 * an explicit override that persists and beats the media query in *both*
 * directions — light on a dark OS is a real choice, not a mistake to correct.
 */

export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

const STORAGE_KEY = 'agentlens.theme'

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    // Private-mode Safari throws on storage access; the media query still works.
    return 'system'
  }
}

function storePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Persistence is a nicety, not a requirement.
  }
}

function resolve(preference: ThemePreference): Theme {
  if (preference !== 'system') return preference
  return darkQuery.matches ? 'dark' : 'light'
}

let preference: ThemePreference = readStoredPreference()
let theme: Theme = resolve(preference)

function apply(): void {
  const root = document.documentElement
  root.dataset.theme = theme
  // Keeps scrollbars, form controls and other UA-painted chrome in step.
  root.style.colorScheme = theme
}

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

darkQuery.addEventListener('change', () => {
  if (preference !== 'system') return
  theme = resolve(preference)
  apply()
  notify()
})

export function setThemePreference(next: ThemePreference): void {
  preference = next
  theme = resolve(next)
  storePreference(next)
  apply()
  notify()
}

export function toggleTheme(): void {
  setThemePreference(theme === 'dark' ? 'light' : 'dark')
}

export function getTheme(): Theme {
  return theme
}

export function getThemePreference(): ThemePreference {
  return preference
}

/** Idempotent; importing this module already did it. Call from main.tsx to be explicit. */
export function initTheme(): void {
  apply()
}

export interface ThemeControls {
  /** What is actually painted right now. */
  theme: Theme
  /** What the reader asked for — 'system' until they touch the toggle. */
  preference: ThemePreference
  setPreference: (next: ThemePreference) => void
  toggle: () => void
}

export function useTheme(): ThemeControls {
  const current = useSyncExternalStore(subscribe, getTheme)
  const currentPreference = useSyncExternalStore(subscribe, getThemePreference)
  return {
    theme: current,
    preference: currentPreference,
    setPreference: setThemePreference,
    toggle: toggleTheme,
  }
}

apply()
