/**
 * Dispatch rules: given the files the user dropped, decide which adapter owns them.
 *
 * Two paths, in order:
 *   1. A file declares `"agentlens_format": "<name>@<version>"` — that wins outright,
 *      confidence 1, no scoring. Our own exports always take this path.
 *   2. Otherwise every candidate's `sniff()` is scored and the highest wins, provided
 *      it clears CONFIDENCE_FLOOR. Below the floor nobody owns the data and the shell
 *      falls back to RawTree.
 *
 * A drop is one dataset, so an adapter's score is the MEAN of its per-file scores:
 * owning one file out of twenty is not owning the drop. `matchedFiles` keeps the
 * spread visible. Ties go to the earlier registration.
 *
 * Pure — no module state, no registry import. `adapters/registry.ts` supplies the
 * candidates.
 *
 * Warnings carry a `Str`, not a string: dispatch warnings are the first thing on
 * a dataset's notice stack, so an English-only one puts English above every
 * Chinese notice under it, and it is exactly the reader who cannot read it who
 * most needs to know their file was not understood. The type makes a
 * monolingual warning a compile error rather than a thing to remember. Names
 * that came out of the drop — file names, format tags, adapter names, an
 * adapter's own thrown message — are interpolated verbatim into both sides.
 */

import type { Adapter, Confidence, ParsedFile } from '../types'
import type { Str } from './lang'

/** Highest score below this and nobody owns the data. */
export const CONFIDENCE_FLOOR = 0.5

/** Records each adapter is shown per file. Adapters must not need more. */
const SNIFF_SAMPLE_SIZE = 5

export interface Candidate {
  adapter: Adapter
  /**
   * `agentlens_format` versions this adapter was built against. A declaration
   * naming an unlisted version still routes here — it is reported, not rejected.
   */
  formatVersions: string[]
  /**
   * Format names this adapter answers to besides `adapter.name`, for a producer
   * whose tag is not the adapter's registry key. The adapter's own name always
   * matches, so this is empty for every adapter whose package agrees with it.
   */
  formatNames?: string[]
}

export interface DeclaredFormat {
  /** The field value verbatim, e.g. `"rm-r1@2"`. */
  raw: string
  name: string
  version?: string
  /** File the declaration was read from. */
  fileName: string
}

export interface AdapterScore {
  name: string
  confidence: Confidence
  /** How many of the inspected files this adapter scored at or above the floor. */
  matchedFiles: number
  /** `sniff()` threw on at least one file; those files scored 0. */
  error?: string
}

export type DispatchWarningKind =
  | 'malformed-declaration'
  | 'conflicting-declarations'
  | 'unknown-format'
  | 'unknown-format-version'
  | 'sniff-failed'

export interface DispatchWarning {
  kind: DispatchWarningKind
  message: Str
}

export interface Dispatch {
  /**
   * `declared` — matched by `agentlens_format`.
   * `sniffed`  — won on score.
   * `unclaimed` — RawTree fallback.
   */
  outcome: 'declared' | 'sniffed' | 'unclaimed'
  adapter?: Adapter
  confidence: Confidence
  declared?: DeclaredFormat
  /** Every candidate, highest first. Empty when a declaration decided it. */
  scores: AdapterScore[]
  /** Always surfaced in the UI — a silent mismatch is a lie about the data. */
  warnings: DispatchWarning[]
}

/** `"rm-r1@2"` → `{ name: 'rm-r1', version: '2' }`. A bare name parses with no version. */
export function parseFormatTag(raw: string): { name: string; version?: string } | null {
  const at = raw.indexOf('@')
  const name = (at === -1 ? raw : raw.slice(0, at)).trim()
  if (name === '') return null
  const version = at === -1 ? '' : raw.slice(at + 1).trim()
  return version === '' ? { name } : { name, version }
}

export function selectAdapter(files: ParsedFile[], candidates: Candidate[]): Dispatch {
  const warnings: DispatchWarning[] = []
  const declarations = readDeclarations(files, warnings)

  const declared = declarations.at(0)
  if (declared) {
    const distinct = [...new Set(declarations.map((d) => d.raw))]
    if (distinct.length > 1) {
      const listed = distinct.join(', ')
      warnings.push({
        kind: 'conflicting-declarations',
        message: {
          en: `Files declare more than one format (${listed}). Using "${declared.raw}" from ${declared.fileName}.`,
          zh: `这些文件声明了不止一种格式（${listed}）。采用 ${declared.fileName} 里的 "${declared.raw}"。`,
        },
      })
    }

    const match = candidates.find(
      (c) => c.adapter.name === declared.name || (c.formatNames?.includes(declared.name) ?? false),
    )
    if (match) {
      if (
        declared.version !== undefined &&
        match.formatVersions.length > 0 &&
        !match.formatVersions.includes(declared.version)
      ) {
        const known = `${declared.name}@${match.formatVersions.join(', @')}`
        warnings.push({
          kind: 'unknown-format-version',
          message: {
            en: `${declared.fileName} declares ${declared.raw}; this build reads ${known}. Opening it anyway — fields may be missing.`,
            zh: `${declared.fileName} 声明的是 ${declared.raw}；这个版本读的是 ${known}。仍然打开，但可能缺少字段。`,
          },
        })
      }
      return { outcome: 'declared', adapter: match.adapter, confidence: 1, declared, scores: [], warnings }
    }

    warnings.push({
      kind: 'unknown-format',
      message: {
        en: `${declared.fileName} declares format "${declared.name}", which no adapter in this build handles. Falling back to fingerprint matching.`,
        zh: `${declared.fileName} 声明的格式是 "${declared.name}"，这个版本里没有适配器认得它。改用字段指纹匹配。`,
      },
    })
  }

  const scores = candidates
    .map((candidate) => score(candidate, files, warnings))
    // Stable sort: ties go to whichever adapter registered first.
    .sort((a, b) => b.confidence - a.confidence)

  const best = scores.at(0)
  if (best && best.confidence >= CONFIDENCE_FLOOR) {
    const winner = candidates.find((c) => c.adapter.name === best.name)
    if (winner) {
      return { outcome: 'sniffed', adapter: winner.adapter, confidence: best.confidence, scores, warnings }
    }
  }

  return { outcome: 'unclaimed', confidence: best?.confidence ?? 0, scores, warnings }
}

function readDeclarations(files: ParsedFile[], warnings: DispatchWarning[]): DeclaredFormat[] {
  const declarations: DeclaredFormat[] = []
  for (const file of files) {
    const raw = declarationOf(file)
    if (raw === undefined) continue
    const tag = parseFormatTag(raw)
    if (tag === null) {
      warnings.push({
        kind: 'malformed-declaration',
        message: {
          en: `${file.fileName}: agentlens_format "${raw}" is not "<name>@<version>" — ignored.`,
          zh: `${file.fileName}：agentlens_format "${raw}" 不是 "<name>@<version>" 的写法，已忽略。`,
        },
      })
      continue
    }
    declarations.push({ raw, name: tag.name, version: tag.version, fileName: file.fileName })
  }
  return declarations
}

/**
 * The parser reports a top-level declaration on `declaredFormat`. Array files have no
 * top level to declare on, so the first record is the second place to look.
 */
function declarationOf(file: ParsedFile): string | undefined {
  if (typeof file.declaredFormat === 'string' && file.declaredFormat !== '') return file.declaredFormat
  const head = file.records.at(0)?.value
  if (head !== null && typeof head === 'object') {
    const field = (head as Record<string, unknown>).agentlens_format
    if (typeof field === 'string' && field !== '') return field
  }
  return undefined
}

function score(candidate: Candidate, files: ParsedFile[], warnings: DispatchWarning[]): AdapterScore {
  const { name } = candidate.adapter
  let total = 0
  let matchedFiles = 0
  let error: string | undefined

  for (const file of files) {
    let confidence = 0
    try {
      confidence = clamp(candidate.adapter.sniff(file.fileName, sampleOf(file)))
    } catch (cause) {
      // One broken adapter must not take dispatch down with it.
      error ??= cause instanceof Error ? cause.message : String(cause)
    }
    total += confidence
    if (confidence >= CONFIDENCE_FLOOR) matchedFiles += 1
  }

  if (error !== undefined) {
    warnings.push({
      kind: 'sniff-failed',
      message: {
        en: `Adapter "${name}" failed to inspect a file: ${error}`,
        zh: `适配器 "${name}" 在检查文件时出错：${error}`,
      },
    })
  }

  return {
    name,
    confidence: files.length === 0 ? 0 : total / files.length,
    matchedFiles,
    error,
  }
}

function sampleOf(file: ParsedFile): unknown[] {
  return file.records.slice(0, SNIFF_SAMPLE_SIZE).map((record) => record.value)
}

function clamp(value: Confidence): Confidence {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
