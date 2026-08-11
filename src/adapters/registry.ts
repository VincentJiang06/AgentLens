/**
 * The plug-in point. M1..M4 each add one directory under `adapters/` and call
 * `register(theirAdapter)` — nothing else in the shell changes.
 */

import type { Adapter, DemoPackage, ParsedFile } from '../types'
import { selectAdapter, type Candidate, type Dispatch } from '../shell/sniff'

export interface RegisterOptions {
  /**
   * `agentlens_format` versions this adapter reads, e.g. `['1']`. Data declaring an
   * unlisted version still routes here — dispatch reports the mismatch instead of
   * dropping the file. Omit if the adapter only ever handles third-party logs.
   */
  formatVersions?: string[]
  /**
   * Format *names* this adapter answers to, beyond its own registry key.
   *
   * `agentlens_format` is `<name>@<version>` and dispatch matches `<name>`
   * against `adapter.name`, so a producer that writes a tag which is not the
   * adapter key — `arbiteros-trace@1` for the `arbiteros` adapter — would have
   * its package reported as handled by nobody and scored by fingerprint
   * instead. Listing the tag here is a statement about what this adapter reads,
   * not a rename: the adapter's own name always matches and never needs listing.
   */
  formatNames?: string[]
}

/** Insertion-ordered, which is what makes tie-breaking deterministic. */
const candidates = new Map<string, Candidate>()

/**
 * `Adapter<Model>` is invariant in `Model` — `parse` produces it and `View` consumes
 * it — so a registry that holds several adapters can only hold them model-blind.
 * The erasure is sound because the shell never separates the two: an adapter's
 * `View` is only ever handed that same adapter's `parse()` output.
 */
export function register<Model>(adapter: Adapter<Model>, options: RegisterOptions = {}): void {
  if (import.meta.env.DEV && candidates.has(adapter.name)) {
    console.warn(`[agentlens] adapter "${adapter.name}" registered twice; replacing.`)
  }
  candidates.set(adapter.name, {
    adapter: adapter as unknown as Adapter,
    formatVersions: options.formatVersions ?? [],
    formatNames: options.formatNames ?? [],
  })
}

export function all(): Adapter[] {
  return [...candidates.values()].map((candidate) => candidate.adapter)
}

export function byName(name: string): Adapter | undefined {
  return candidates.get(name)?.adapter
}

/** `?demo=<id>` — demo ids are global, so the first adapter declaring one owns it. */
export function demoById(id: string): { adapter: Adapter; demo: DemoPackage } | undefined {
  for (const { adapter } of candidates.values()) {
    const demo = adapter.demos?.find((candidate) => candidate.id === id)
    if (demo) return { adapter, demo }
  }
  return undefined
}

/** Which adapter owns these files. `outcome: 'unclaimed'` means render RawTree. */
export function dispatch(files: ParsedFile[]): Dispatch {
  return selectAdapter(files, [...candidates.values()])
}

export type { Dispatch }
