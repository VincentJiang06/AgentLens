/**
 * Chain-of-Rubrics parsing: the judge's pseudo-XML in, a `CorDocument` out.
 *
 * The input is one language model's raw output, so it is not XML and nothing
 * guarantees it closes. Measured over the released 32B RewardBench log (2,985
 * records): 181 records have a tag whose open and close counts disagree, and
 * 176 of those are a single orphan closing tag appended after the verdict — a
 * record really does end `<answer>[[A]]</answer>\n</answer>`. So the scanner
 * below never rejects input; it records what it could not account for and says
 * so, and `raw` is always the untouched original.
 *
 * Pure — no React, no DOM. `cor.test.ts` drives it under `node --test`,
 * including against the real logs.
 */

import type { CorDocument, CorEvidence } from './contract'

/* -------------------------------------------------------------- vocabulary */

/**
 * The judge's tag set. `type`/`rubric`/`solution`/`eval`/`answer` are siblings
 * at the top level ("the spine"); `justify` nests inside `rubric` and the four
 * evidence tags nest inside `eval`.
 */
const SPINE = ['type', 'rubric', 'solution', 'eval', 'answer'] as const
const EVIDENCE = ['quote_A', 'quote_B', 'summary_A', 'summary_B'] as const

export type CorTag = (typeof SPINE)[number] | 'justify' | (typeof EVIDENCE)[number]

/** Canonical spelling by lower-cased name, so `<QUOTE_a>` still lands. */
const TAGS = new Map<string, CorTag>(
  ([...SPINE, 'justify', ...EVIDENCE] as CorTag[]).map((tag) => [tag.toLowerCase(), tag]),
)

const TAG_RE = /<(\/?)([A-Za-z_][A-Za-z0-9_]*)\s*>/g
const VERDICT_RE = /\[\[\s*([AB])\s*\]\]/g

const isSpine = (tag: CorTag): boolean => (SPINE as readonly string[]).includes(tag)

/* ------------------------------------------------------------------ issues */

export type CorIssueKind =
  /** A tag was still open at the end of input, or when a sibling opened. */
  | 'unclosed-tag'
  /** A closing tag matched a frame further down the stack, not the open one. */
  | 'mismatched-close'
  /** A closing tag matched nothing open. Closes nothing, loses nothing. */
  | 'stray-close'
  | 'missing-type'
  | 'missing-eval'
  | 'missing-verdict'
  /** No text, or no tag we recognise anywhere in it. */
  | 'empty'

export interface CorIssue {
  kind: CorIssueKind
  tag?: CorTag
  /** Character offset in `raw` where the problem was noticed. */
  at: number
}

/**
 * Kinds that mean structure was lost. `stray-close` is deliberately absent: an
 * orphan `</answer>` after the verdict closes nothing and consumes nothing, and
 * calling that record degraded — "raw is all a view can trust" — would be a
 * false statement about 176 of the 181 malformed records in the real log.
 * `parseCorDetailed` reports it so a view can still badge it.
 */
const LOSSY: readonly CorIssueKind[] = [
  'unclosed-tag',
  'mismatched-close',
  'missing-type',
  'missing-eval',
  'missing-verdict',
  'empty',
]

export interface CorParse {
  doc: CorDocument
  issues: CorIssue[]
}

/* ---------------------------------------------------------------- segments */

/** `<eval>` prose split so a view can colour the judge's marked spans in place. */
export type CorSegment = { kind: 'text'; text: string } | { kind: 'evidence'; evidence: CorEvidence }

/* ----------------------------------------------------------------- scanner */

interface Section {
  tag: CorTag
  /** Content bounds — between the tags, not including them. */
  start: number
  end: number
  /** Index into `sections` of the enclosing section, or -1. */
  parent: number
}

interface Frame {
  tag: CorTag
  section: number
  /** Offset of the `<` that opened it, for implicit-close bookkeeping. */
  openedAt: number
}

interface Scan {
  sections: Section[]
  issues: CorIssue[]
  sawTag: boolean
}

/**
 * One left-to-right pass with a stack.
 *
 * Two leniencies, both driven by what the real logs do:
 *  - opening a spine tag while another spine tag is open implicitly closes the
 *    open one at that point, so an unclosed `<solution>` costs the solution's
 *    end rather than swallowing the eval and the verdict after it;
 *  - a closing tag that matches nothing open is dropped, which is the doubled
 *    `</answer>`.
 * Both are recorded as issues either way.
 */
function scan(raw: string): Scan {
  const sections: Section[] = []
  const issues: CorIssue[] = []
  const stack: Frame[] = []
  let sawTag = false

  const closeFrame = (frame: Frame, at: number) => {
    sections[frame.section].end = at
  }

  TAG_RE.lastIndex = 0
  for (let match = TAG_RE.exec(raw); match !== null; match = TAG_RE.exec(raw)) {
    const tag = TAGS.get(match[2].toLowerCase())
    if (tag === undefined) continue // prose that merely looks like markup
    sawTag = true
    const closing = match[1] === '/'
    const from = match.index
    const to = from + match[0].length

    if (!closing) {
      if (isSpine(tag)) {
        while (stack.length > 0) {
          const open = stack.pop() as Frame
          closeFrame(open, from)
          issues.push({ kind: 'unclosed-tag', tag: open.tag, at: open.openedAt })
        }
      }
      sections.push({ tag, start: to, end: raw.length, parent: stack.length ? stack[stack.length - 1].section : -1 })
      stack.push({ tag, section: sections.length - 1, openedAt: from })
      continue
    }

    const depth = lastIndexOfTag(stack, tag)
    if (depth === -1) {
      issues.push({ kind: 'stray-close', tag, at: from })
      continue
    }
    if (depth !== stack.length - 1) issues.push({ kind: 'mismatched-close', tag, at: from })
    while (stack.length > depth + 1) {
      const inner = stack.pop() as Frame
      closeFrame(inner, from)
      issues.push({ kind: 'unclosed-tag', tag: inner.tag, at: inner.openedAt })
    }
    closeFrame(stack.pop() as Frame, from)
  }

  while (stack.length > 0) {
    const open = stack.pop() as Frame
    closeFrame(open, raw.length)
    issues.push({ kind: 'unclosed-tag', tag: open.tag, at: open.openedAt })
  }

  return { sections, issues, sawTag }
}

function lastIndexOfTag(stack: Frame[], tag: CorTag): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) return i
  return -1
}

/* ------------------------------------------------------------------ public */

/** Never throws. Anything that is not a string parses as an empty, degraded document. */
export function parseCor(raw: unknown): CorDocument {
  return parseCorDetailed(raw).doc
}

/**
 * `parseCor` plus the issue list behind `degraded`.
 *
 * A view wants the difference: an orphan `</answer>` deserves a badge, a
 * truncated generation deserves the raw text.
 */
export function parseCorDetailed(raw: unknown): CorParse {
  const text = typeof raw === 'string' ? raw : ''
  try {
    return build(text)
  } catch {
    // The scanner is written not to throw. If it ever does, the record is still
    // readable as raw text, and that is worth more than a thrown adapter.
    return { doc: emptyDoc(text), issues: [{ kind: 'empty', at: 0 }] }
  }
}

function build(raw: string): CorParse {
  const { sections, issues, sawTag } = scan(raw)
  if (raw.trim() === '' || !sawTag) issues.push({ kind: 'empty', at: 0 })

  const content = (s: Section) => raw.slice(s.start, s.end)
  const first = (tag: CorTag) => sections.find((s) => s.tag === tag)
  const all = (tag: CorTag) => sections.filter((s) => s.tag === tag)

  const typeSection = first('type')
  if (!typeSection) issues.push({ kind: 'missing-type', at: 0 })

  const evalSections = all('eval')
  if (evalSections.length === 0) issues.push({ kind: 'missing-eval', at: 0 })

  const rubric = first('rubric')
  const justify = first('justify')
  const solution = first('solution')

  const answers = all('answer')
  const verdictText = answers.length > 0 ? answers.map(content).join('\n') : raw
  const { verdict, ambiguous } = readVerdict(verdictText)
  if (verdict === null && !ambiguous) issues.push({ kind: 'missing-verdict', at: raw.length })

  const evidence: CorEvidence[] = sections
    .filter((s) => isEvidence(s.tag))
    .map((s) => ({ ...evidenceKind(s.tag), text: stripTags(content(s)).trim() }))

  return {
    doc: {
      route: routeOf(typeSection ? content(typeSection) : ''),
      criteria: rubric ? criteriaOf(raw, rubric, sections) : [],
      justification: justify ? blank(stripTags(content(justify)).trim()) : undefined,
      solution: solution ? blank(stripTags(content(solution)).trim()) : undefined,
      evaluation: evalSections.length
        ? blank(evalSections.map((s) => stripTags(content(s)).trim()).join('\n\n'))
        : undefined,
      evidence,
      verdict,
      ambiguous,
      degraded: issues.some((issue) => LOSSY.includes(issue.kind)),
      raw,
    },
    issues,
  }
}

/**
 * `<eval>` prose with the marked spans in place, for a view that highlights
 * quotes inline. Re-scans `doc.raw`, so it costs one pass over one record.
 */
export function corEvalSegments(doc: CorDocument): CorSegment[] {
  const raw = doc.raw
  const { sections } = scan(raw)
  const segments: CorSegment[] = []

  for (const evaluation of sections.filter((s) => s.tag === 'eval')) {
    const spans = sections
      .filter((s) => isEvidence(s.tag) && s.start >= evaluation.start && s.end <= evaluation.end)
      .sort((a, b) => a.start - b.start)
    let cursor = evaluation.start
    for (const span of spans) {
      if (span.start < cursor) continue // nested inside a span already emitted
      pushText(segments, stripTags(raw.slice(cursor, span.start)))
      segments.push({
        kind: 'evidence',
        evidence: { ...evidenceKind(span.tag), text: stripTags(raw.slice(span.start, span.end)).trim() },
      })
      cursor = span.end
    }
    pushText(segments, stripTags(raw.slice(cursor, evaluation.end)))
  }
  return segments
}

/* ------------------------------------------------------------------ pieces */

function pushText(segments: CorSegment[], text: string): void {
  if (text.trim() !== '') segments.push({ kind: 'text', text })
}

function isEvidence(tag: CorTag): boolean {
  return (EVIDENCE as readonly string[]).includes(tag)
}

function evidenceKind(tag: CorTag): { side: 'A' | 'B'; kind: 'quote' | 'summary' } {
  return {
    side: tag.endsWith('_B') ? 'B' : 'A',
    kind: tag.startsWith('quote') ? 'quote' : 'summary',
  }
}

function stripTags(text: string): string {
  return text.replace(TAG_RE, (whole, _slash: string, name: string) =>
    TAGS.has(name.toLowerCase()) ? '' : whole,
  )
}

function blank(text: string): string | undefined {
  return text === '' ? undefined : text
}

function routeOf(text: string): CorDocument['route'] {
  const word = stripTags(text).trim().toLowerCase()
  if (word.startsWith('chat')) return 'chat'
  if (word.startsWith('reasoning')) return 'reasoning'
  return 'unknown'
}

/**
 * One criterion per line, as the judge numbered them — including the sub-bullets
 * 27 of the 1,382 real rubrics hang under a numbered line. Nothing is dropped or
 * renumbered: the judge's own weights ("(40%)") live in that text.
 */
function criteriaOf(raw: string, rubric: Section, sections: Section[]): string[] {
  const nested = sections.filter((s) => s.tag === 'justify' && s.start >= rubric.start && s.end <= rubric.end)
  let text = ''
  let cursor = rubric.start
  for (const child of nested.sort((a, b) => a.start - b.start)) {
    if (child.start < cursor) continue
    text += raw.slice(cursor, child.start)
    cursor = child.end
  }
  text += raw.slice(cursor, rubric.end)

  return stripTags(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * `[[A]]` / `[[B]]` inside `<answer>`, or anywhere in the record when there is
 * no `<answer>` at all. Both markers present is the case RM-R1's own reward
 * function scores as a failure, so it yields no verdict rather than the first
 * one seen — it occurs zero times in the released 32B logs.
 */
function readVerdict(text: string): { verdict: 'A' | 'B' | null; ambiguous: boolean } {
  const seen = new Set<string>()
  VERDICT_RE.lastIndex = 0
  for (let match = VERDICT_RE.exec(text); match !== null; match = VERDICT_RE.exec(text)) seen.add(match[1])
  if (seen.size > 1) return { verdict: null, ambiguous: true }
  if (seen.has('A')) return { verdict: 'A', ambiguous: false }
  if (seen.has('B')) return { verdict: 'B', ambiguous: false }
  return { verdict: null, ambiguous: false }
}

function emptyDoc(raw: string): CorDocument {
  return {
    route: 'unknown',
    criteria: [],
    evidence: [],
    verdict: null,
    ambiguous: false,
    degraded: true,
    raw,
  }
}
