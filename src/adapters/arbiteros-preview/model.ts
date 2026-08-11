/**
 * The pure half of the adapter: fingerprint, model, record resolution.
 *
 * No React and no DOM in this file, so every rule below can be exercised from
 * plain node. `index.tsx` adds the view and the registered `Adapter` object.
 */

import type { Confidence, ParsedFile, ParsedRecord } from '../../types'

export interface RedteamCase {
  /**
   * What `?record=` matches. `<file>:<index>`, never `<file>#<index>`: a '#' in a
   * URL is a fragment, so the browser strips it before the query is read and the
   * emailed link silently opens the wrong record.
   */
  id: string
  /** Index within its source file, 0-based — the same number `ParsedRecord` carries. */
  index: number
  traceId: string
  fileName: string
  /** Steps already replayed before `current`. */
  priorSteps: number
  /** What `current` is about to do: the tool call(s), or a plain reply. */
  action: string
  /** Read off the trace id, which is how the suite names its cases. */
  verdict?: 'safe' | 'unsafe'
}

export interface ArbiterosPreviewModel {
  cases: RedteamCase[]
  /** Records that carried no `trace_id` and were dropped. */
  skipped: number
  /** One source file, so a bare `?record=<index>` is unambiguous. */
  singleFile: boolean
}

const TOOL_CALL_WEIGHT = 0.25
const PRIOR_WEIGHT = 0.3
const TRACE_ID_WEIGHT = 0.4

export function sniff(_fileName: string, firstRecords: unknown[]): Confidence {
  if (firstRecords.length === 0) return 0
  let total = 0
  for (const record of firstRecords) {
    const fields = asObject(record)
    if (!fields) continue
    if (typeof fields.trace_id === 'string') total += TRACE_ID_WEIGHT
    if (Array.isArray(fields.prior)) total += PRIOR_WEIGHT
    if (asObject(fields.current)) total += TOOL_CALL_WEIGHT
  }
  return total / firstRecords.length
}

export function parse(files: ParsedFile[]): ArbiterosPreviewModel {
  const cases: RedteamCase[] = []
  let skipped = 0
  for (const file of files) {
    for (const record of file.records) {
      const one = toCase(file.fileName, record)
      if (one) cases.push(one)
      else skipped += 1
    }
  }
  return { cases, skipped, singleFile: files.length === 1 }
}

/** The one place record ids are minted. Kept in step with `shell/RecordBrowser`. */
export function caseId(fileName: string, index: number): string {
  return `${fileName}:${index}`
}

/**
 * Position of `?record=` in `model.cases`, or -1 if the link misses. A miss is a
 * value the caller must show: a dead outreach link that looks fine is worse than
 * one that errors.
 *
 * Three forms are accepted, because all three get typed by hand into an email:
 * the minted id, the trace id (self-describing, and what the case is called
 * upstream), and a bare index when there is only one file to index into.
 */
export function caseIndexFor(model: ArbiterosPreviewModel, recordId: string | undefined): number {
  if (recordId === undefined || recordId === '') return -1
  return model.cases.findIndex(
    (one) =>
      one.id === recordId ||
      one.traceId === recordId ||
      (model.singleFile && String(one.index) === recordId),
  )
}

function toCase(fileName: string, record: ParsedRecord): RedteamCase | null {
  const fields = asObject(record.value)
  if (!fields || typeof fields.trace_id !== 'string') return null
  return {
    id: caseId(fileName, record.index),
    index: record.index,
    traceId: fields.trace_id,
    fileName,
    priorSteps: Array.isArray(fields.prior) ? fields.prior.length : 0,
    action: actionOf(asObject(fields.current)),
    verdict: verdictOf(fields.trace_id),
  }
}

function actionOf(current: Record<string, unknown> | null): string {
  const calls = current?.tool_calls
  if (Array.isArray(calls) && calls.length > 0) {
    const names = calls.map((call) => {
      const fn = asObject(asObject(call)?.function)
      return typeof fn?.name === 'string' ? fn.name : 'unnamed tool'
    })
    return names.join(', ')
  }
  return typeof current?.content === 'string' ? 'reply' : 'unknown'
}

function verdictOf(traceId: string): RedteamCase['verdict'] {
  if (traceId.includes('-unsafe-')) return 'unsafe'
  if (traceId.includes('-safe-')) return 'safe'
  return undefined
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
