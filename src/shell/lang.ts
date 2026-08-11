import { useSyncExternalStore } from 'react'

/**
 * Interface language, built to the same shape as `theme.ts`: resolved before the
 * first paint, defaulting to the browser's own preference, with an explicit
 * choice that persists and wins in both directions.
 *
 * ── The one rule that matters ────────────────────────────────────────────────
 * `t()` is for AgentLens's own words. It is never for data.
 *
 * Subset names (`alpacaeval-easy`), RM-Bench domains, file names, format ids,
 * and every word the judged model or the judge itself wrote are somebody's
 * research record. Translating those would misquote their logs — the opposite
 * of what a viewer is for. If a string came out of a dropped file, it renders
 * exactly as it arrived, in whatever language it arrived in.
 *
 * ── Why bilingual literals and not a key catalogue ───────────────────────────
 * A `Str` requires both languages to construct, so TypeScript refuses to compile
 * a half-translated string. That is a stronger completeness guarantee than any
 * lint over a catalogue of keys, and it keeps each translation next to the code
 * that shows it, where it can be judged in context.
 */

export type Lang = 'en' | 'zh'
export type LangPreference = Lang | 'system'

/** A phrase in both languages. Both fields are required — that is the point. */
export interface Str {
  en: string
  zh: string
}

const STORAGE_KEY = 'agentlens.lang'

const listeners = new Set<() => void>()

/**
 * Anything under the `zh` umbrella (zh, zh-CN, zh-Hant, zh-TW…) gets Chinese;
 * everything else gets English. The four groups this tool was built for read
 * both, so guessing from the browser beats picking a default for them.
 */
function detect(): Lang {
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
  for (const tag of tags) {
    if (!tag) continue
    const primary = tag.toLowerCase().split('-')[0]
    if (primary === 'zh') return 'zh'
    if (primary) return 'en'
  }
  return 'en'
}

function readStoredPreference(): LangPreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === 'en' || stored === 'zh' ? stored : 'system'
  } catch {
    // Private-mode Safari throws on storage access; detection still works.
    return 'system'
  }
}

function storePreference(preference: LangPreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    // Persistence is a nicety, not a requirement.
  }
}

function resolve(preference: LangPreference): Lang {
  return preference === 'system' ? detect() : preference
}

let preference: LangPreference = readStoredPreference()
let lang: Lang = resolve(preference)

function apply(): void {
  // Screen readers, hyphenation and font fallback all key off this.
  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en'
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

export function setLangPreference(next: LangPreference): void {
  preference = next
  lang = resolve(next)
  storePreference(next)
  apply()
  notify()
}

export function toggleLang(): void {
  setLangPreference(lang === 'zh' ? 'en' : 'zh')
}

export function getLang(): Lang {
  return lang
}

export function getLangPreference(): LangPreference {
  return preference
}

/** Idempotent; importing this module already did it. Call from main.tsx to be explicit. */
export function initLang(): void {
  apply()
}

/** Pick one side of a `Str` outside React, where the hook is not available. */
export function translate(str: Str, at: Lang = lang): string {
  return str[at]
}

export interface LangControls {
  lang: Lang
  /** What the reader asked for — 'system' until they touch the toggle. */
  preference: LangPreference
  setPreference: (next: LangPreference) => void
  toggle: () => void
  /** `t({ en: 'Judgements', zh: '判例' })` */
  t: (str: Str) => string
}

export function useLang(): LangControls {
  const current = useSyncExternalStore(subscribe, getLang)
  const currentPreference = useSyncExternalStore(subscribe, getLangPreference)
  return {
    lang: current,
    preference: currentPreference,
    setPreference: setLangPreference,
    toggle: toggleLang,
    t: (str: Str) => str[current],
  }
}

/**
 * `t` alone, for the common case. Re-renders on a language change like any hook.
 */
export function useT(): (str: Str) => string {
  const current = useSyncExternalStore(subscribe, getLang)
  return (str: Str) => str[current]
}

apply()
