import { useSyncExternalStore } from 'react'
import type { RouteState } from '../types'

/**
 * The entire URL surface is two query parameters (`?demo=…&record=…`), so this
 * is a hand-written router rather than a dependency. It is browser-only: the
 * app never renders on a server.
 *
 * Deep links are how AgentLens reaches people, so the rules here are strict:
 * every href we emit is built from `import.meta.env.BASE_URL` ('/' in dev,
 * '/agentlens/' on GitHub Pages), and an unrecognised `demo` never discards the
 * `record` that came with it.
 */

const DEMO_PARAM = 'demo'
const RECORD_PARAM = 'record'

/** A pasted URL is untrusted input; drop absurd values instead of rendering them. */
const MAX_VALUE_LENGTH = 200

function clean(value: string | null | undefined): string | undefined {
  if (value == null) return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_VALUE_LENGTH) return undefined
  return trimmed
}

export function parseRoute(search: string = window.location.search): RouteState {
  // Tolerates being handed a whole href, not just `location.search`.
  const query = search.slice(search.indexOf('?') + 1).split('#')[0]
  const params = new URLSearchParams(query)
  const route: RouteState = {}
  const demo = clean(params.get(DEMO_PARAM))
  const record = clean(params.get(RECORD_PARAM))
  if (demo) route.demo = demo
  if (record) route.record = record
  return route
}

/** `'?demo=<id>&record=<id>'`, or `''` for the landing page. */
export function routeToSearch(route: RouteState): string {
  const params = new URLSearchParams()
  const demo = clean(route.demo)
  const record = clean(route.record)
  if (demo) params.set(DEMO_PARAM, demo)
  if (record) params.set(RECORD_PARAM, record)
  const query = params.toString()
  return query ? `?${query}` : ''
}

function basePath(): string {
  const base = import.meta.env.BASE_URL
  // A relative base ('./') has no absolute form; the current directory is then
  // the only honest answer.
  return base && base.startsWith('/') ? base : window.location.pathname
}

/** Root-relative href for `<a>` so middle-click and ctrl-click still work. */
export function buildHref(route: RouteState): string {
  return `${basePath()}${routeToSearch(route)}`
}

/**
 * Absolute URL, for the dataset header's "Copy link" and for an outreach email.
 * `record` is whatever the adapter published as a record id; it is encoded by
 * `URLSearchParams`, so the copied link survives a paste even if an id ever
 * carries a character that a query string reserves.
 */
export function shareUrl(route: RouteState): string {
  return `${window.location.origin}${buildHref(route)}`
}

/* ------------------------------------------------------------------- store */

const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

window.addEventListener('popstate', notify)

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

let cachedSearch: string | null = null
let cachedRoute: RouteState = {}

/** Cached by search string: useSyncExternalStore needs a stable snapshot. */
export function currentRoute(): RouteState {
  const search = window.location.search
  if (search !== cachedSearch) {
    cachedSearch = search
    cachedRoute = parseRoute(search)
  }
  return cachedRoute
}

export function useRoute(): RouteState {
  return useSyncExternalStore(subscribe, currentRoute)
}

/* -------------------------------------------------------------- navigation */

export interface NavigateOptions {
  replace?: boolean
}

export function navigate(route: RouteState, options: NavigateOptions = {}): void {
  const href = buildHref(route)
  if (href === window.location.pathname + window.location.search) return
  if (options.replace) window.history.replaceState(null, '', href)
  else window.history.pushState(null, '', href)
  notify()
}

export function openDemo(demo: string, record?: string): void {
  navigate({ demo, record })
}

/**
 * Record selection is view state, not a destination: it replaces so that Back
 * leaves the demo instead of stepping through every row the reader clicked.
 */
export function selectRecord(record: string | undefined): void {
  navigate({ ...currentRoute(), record }, { replace: true })
}

export function goHome(options: NavigateOptions = {}): void {
  navigate({}, options)
}

/* --------------------------------------------------------------- resolving */

export interface ResolvedRoute extends RouteState {
  /** Set when `?demo=` names something no adapter registered. */
  unknownDemo?: string
}

/**
 * Checks `?demo=` against the ids the registry actually knows. The bad name is
 * handed back rather than swallowed so the landing page can say which link
 * broke; `record` survives, because the reader may still drop the matching file.
 */
export function resolveRoute(route: RouteState, knownDemos: readonly string[]): ResolvedRoute {
  if (route.demo && !knownDemos.includes(route.demo)) {
    return { record: route.record, unknownDemo: route.demo }
  }
  return route
}
