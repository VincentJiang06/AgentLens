/**
 * The pure half of the ArbiterOS adapter: fingerprint, normalise, propagate.
 *
 * The package this reads is written by `scripts/arbiteros-runner/run.py`, which
 * replays ArbiterOS's own red-team cases through ArbiterOS's own policy kernel
 * with no model, no gateway and no network. Two things in it are easy to get
 * wrong and both are handled here rather than in a view:
 *
 *   1. The result of the suite is a PAIR: `refused` (a policy composed an actual
 *      refusal, naming the rule and the reason — see `hasRefusal`) and
 *      `intercepted` (the registry let it act). Two larger numbers in the
 *      package read like the first and are not: `wouldBlock` counts a field the
 *      kernel fills in itself when a gated policy states no reason, and
 *      `flagged` counts a recorded policy name, almost all of which are argument
 *      re-serialisations that change nothing. `refused` is reported with the
 *      suite's own safe/unsafe split, because it is simultaneously a hit rate
 *      and a false-positive rate. `parse()` keeps the package's own sentence
 *      about this verbatim (`howToReadTheCounts`) and states the same facts
 *      bilingually, with denominators, in `notes`.
 *   2. `propTrust`/`propConf` are inherited labels — trust is the MINIMUM along
 *      the chain, confidentiality the MAXIMUM. When a step's inherited label
 *      differs from its own, some ancestor did it, and naming that ancestor is
 *      the whole value of the graph. `buildPropagationGraph` derives it over
 *      both relations the package records — `parentId` and the
 *      `reference_tool_id` list inside each tool call's own arguments — and
 *      says so when neither explains a label rather than guessing.
 *
 * No React and no DOM, so every rule below is exercised from plain node by
 * `model.test.ts`, including against the committed 105-case package.
 */

import type { Confidence, ParsedFile } from '../../types'
// Type-only: `Str` is the shell's bilingual literal, and nothing in that module
// runs here — `model.ts` is exercised from plain node with no DOM.
import type { Str } from '../../shell/lang'
import type { ArbiterosModel, Counts, PolicyRegistration, Provenance, Step, Taint, Trace, Verdict } from './contract'

/* --------------------------------------------------------------- record ids */

/**
 * `<caseId>` for a case, `<caseId>:<stepIndex>` for one instruction inside it,
 * where `stepIndex` is 0-based position in `trace.steps` — the same convention
 * as the RM-R1 adapter's `<file>:<index>`.
 *
 * Never `<caseId>#<n>`: a browser eats a `#` as a fragment before the query is
 * read, so an emailed deep link would silently open the wrong record. Case ids
 * out of the manifest carry no `:` of their own, which is what makes the split
 * below unambiguous.
 */
export function traceRecordId(traceId: string): string {
  return traceId
}

export function stepRecordId(traceId: string, stepIndex: number): string {
  return `${traceId}:${stepIndex}`
}

/** `"a_case:3"` → `{ traceId: 'a_case', stepIndex: 3 }`. A bare id has no step. */
export function parseRecordId(recordId: string): { traceId: string; stepIndex?: number } {
  const at = recordId.lastIndexOf(':')
  if (at <= 0) return { traceId: recordId }
  const tail = recordId.slice(at + 1)
  // Only a run of digits is a step index; anything else belongs to the case id.
  if (!/^\d+$/.test(tail)) return { traceId: recordId }
  return { traceId: recordId.slice(0, at), stepIndex: Number(tail) }
}

/** Index into `model.traces`, or -1. Accepts a step id as well as a case id. */
export function traceIndexFor(model: ArbiterosModel, recordId: string | undefined): number {
  if (recordId === undefined || recordId === '') return -1
  const { traceId } = parseRecordId(recordId)
  return model.traces.findIndex((trace) => trace.id === traceId)
}

/**
 * What a `?record=` link points at: the case, and the step within it when the
 * link named one. `stepIndex` is -1 when the link named no step or named one
 * this package does not have — a dead link is reported, not silently rounded to
 * the first step.
 */
export function locate(
  model: ArbiterosModel,
  recordId: string | undefined,
): { trace?: Trace; traceIndex: number; step?: Step; stepIndex: number } {
  const traceIndex = traceIndexFor(model, recordId)
  if (traceIndex === -1) return { traceIndex: -1, stepIndex: -1 }
  const trace = model.traces[traceIndex]
  const wanted = recordId === undefined ? undefined : parseRecordId(recordId).stepIndex
  const stepIndex = wanted !== undefined && wanted < trace.steps.length ? wanted : -1
  return { trace, traceIndex, step: stepIndex === -1 ? undefined : trace.steps[stepIndex], stepIndex }
}

/* --------------------------------------------------------------- vocabulary */

/** `LOW < UNKNOWN < HIGH`, with the kernel's own numbers (`types.py:LEVEL_ORDER`). */
export const LEVEL_ORDER = { LOW: 0, UNKNOWN: 10, HIGH: 20 } as const

export type Level = keyof typeof LEVEL_ORDER

/** `Object.hasOwn`, not `in`: a label called `toString` is not a level. */
export function levelOf(value: string | undefined): Level | undefined {
  return value !== undefined && Object.hasOwn(LEVEL_ORDER, value) ? (value as Level) : undefined
}

/**
 * What the runner counts as "carrying taint", repeated here so the view and the
 * package agree on one rule: a LOW trust or a HIGH confidentiality *after*
 * propagation. Both are the dangerous end of their own scale.
 */
export function isTaintedStep(step: Step): boolean {
  return step.taint.propTrust === 'LOW' || step.taint.propConf === 'HIGH'
}

export function isTaintedTrace(trace: Trace): boolean {
  return trace.steps.some(isTaintedStep)
}

/** The kernel rewrote the response, or substituted a refusal for it. */
export function isIntercepted(trace: Trace): boolean {
  return trace.verdict.modified || (trace.verdict.errorType ?? '') !== ''
}

/**
 * `inactivate_error_type` is non-empty. NOT a detection predicate, whatever the
 * name suggests — on the committed package it is true of 87 cases while only 38
 * of those hold anything a policy wrote. Use `hasRefusal` to count detections;
 * this exists to compute the gap between the two and to report it.
 */
export function wouldBlock(trace: Trace): boolean {
  return (trace.verdict.wouldBlock ?? '').trim() !== ''
}

/**
 * Either half of the pair: something was recorded against this case, whether or
 * not the kernel was allowed to act. A union rather than a sum, because a case
 * can be both — one enforcing policy rewriting the response while a gated one
 * has its own verdict written down.
 */
export function stopWasJudged(trace: Trace): boolean {
  return wouldBlock(trace) || isIntercepted(trace)
}

/**
 * The kernel's stand-in when an observe-only policy reports a change but hands
 * over no message (`policy_check.py: apply_policy_enforcement_mode`). A
 * `wouldBlock` made only of this line records that a policy would have acted,
 * not what it would have said, and the two are worth counting apart.
 */
export const WOULD_BLOCK_PLACEHOLDER = 'policy would have modified the response'

/** True when `wouldBlock` carries a message beyond the kernel's placeholder. */
export function wouldBlockHasText(trace: Trace): boolean {
  return hasText(trace.verdict.wouldBlock)
}

function hasText(raw: string | null | undefined): boolean {
  return (raw ?? '')
    .split('\n')
    .some((line) => line.trim() !== '' && line.trim() !== WOULD_BLOCK_PLACEHOLDER)
}

/**
 * THE DETECTION PREDICATE: some policy composed an actual refusal, naming the
 * rule and the reason.
 *
 * This is the one to count, and getting here took four passes. `wouldBlock`
 * being non-empty looks like the detection signal and is not: most of it is the
 * kernel's stand-in, written when a gated policy reported a change and stated
 * nothing. Counting that as detection roughly doubles the claim.
 *
 * Both fields are consulted because the two halves live in different places: a
 * policy the registry gated writes its refusal to `wouldBlock`, a policy it let
 * through writes the same thing to `errorType`. Reading only `wouldBlock` drops
 * the one case that was actually enforced, which is exactly the case a reader
 * most wants counted.
 */
export function hasRefusal(trace: Trace): boolean {
  return hasText(trace.verdict.errorType) || hasText(trace.verdict.wouldBlock)
}

/* -------------------------------------------------------------- fingerprint */

/**
 * The committed package declares `agentlens_format`, so in practice dispatch
 * never reaches this function — `shell/sniff.ts` matches the declaration
 * against `adapter.name` and stops. It exists for the other case: someone runs
 * `scripts/arbiteros-runner/run.py` themselves, or dumps the kernel's own
 * trace files, and drops the result with no declaration on it.
 *
 * 1 is returned only for a declaration, which is the shell's own rule for
 * `Confidence`; a fingerprint match is 0.95, high enough to win but never
 * claiming the certainty a declared format has.
 */
const ENVELOPE_CONFIDENCE = 0.95
const TRACE_CONFIDENCE = 0.9

export function sniff(_fileName: string, firstRecords: unknown[]): Confidence {
  if (firstRecords.length === 0) return 0
  let total = 0
  for (const record of firstRecords) {
    const fields = asObject(record)
    if (fields === null) continue
    const declared = fields.agentlens_format
    if (typeof declared === 'string' && declared.startsWith('arbiteros')) return 1
    if (isEnvelope(fields)) total += ENVELOPE_CONFIDENCE
    else if (isTraceShaped(fields)) total += TRACE_CONFIDENCE
  }
  return total / firstRecords.length
}

/** The whole package in one object: replayed cases, plus what the run counted. */
function isEnvelope(fields: Record<string, unknown>): boolean {
  if (!Array.isArray(fields.traces)) return false
  const head = asObject(fields.traces[0])
  if (head !== null && isTraceShaped(head)) return true
  // An empty run is still this package's shape, if it says what it counted.
  return asObject(fields.counts) !== null || asObject(fields.source) !== null
}

/**
 * One replayed case: a verdict, and instructions carrying the labels that only
 * exist after a replay. `propTrust`/`propConf` are the discriminating fields —
 * nothing else in AgentLens has them, and a case file straight off disk has
 * neither, which is exactly why the replay exists.
 */
function isTraceShaped(fields: Record<string, unknown>): boolean {
  const steps = fields.steps
  if (!Array.isArray(steps) || steps.length === 0) return false
  const verdict = asObject(fields.verdict)
  // Either spelling, so a raw kernel dump fingerprints the same as a replay package.
  if (verdict === null || !Array.isArray(verdict.policies ?? verdict.policy_names)) return false
  return steps.some((step) => {
    const taint = taintFieldsOf(asObject(step))
    return taint !== null && ('propTrust' in taint || 'prop_trustworthiness' in taint)
  })
}

/* -------------------------------------------------------------------- parse */

export function parse(files: ParsedFile[]): ArbiterosModel {
  const notes: Str[] = []
  const traces: Trace[] = []
  const failures: { id: string; why: string }[] = []
  let provenance: Provenance | undefined
  let howToReadTheCounts: string | undefined
  let declaredCounts: Counts | undefined
  let enforcement: PolicyRegistration[] | undefined
  let skipped = 0

  for (const file of files) {
    for (const record of file.records) {
      const fields = asObject(record.value)
      if (fields === null) {
        skipped += 1
        continue
      }
      if (isEnvelope(fields)) {
        // First envelope wins for the single-valued fields: two packages in one
        // drop are two runs, and merging their provenance would credit neither.
        provenance ??= readProvenance(fields)
        // Verbatim, both of them. `how_to_read_the_counts` is the package's own
        // sentence about which of its four counts is a detection; a paraphrase
        // of it is the one edit this adapter must never make.
        if (howToReadTheCounts === undefined && typeof fields.how_to_read_the_counts === 'string') {
          howToReadTheCounts = fields.how_to_read_the_counts
        }
        declaredCounts ??= readCounts(asObject(fields.counts))
        // The registry this replay ran under. Rows without a usable name are
        // dropped rather than shown as an unnamed policy in some mode.
        if (enforcement === undefined) {
          const rows = asArray(fields.enforcement)
            .map(asObject)
            .filter((one): one is Record<string, unknown> => one !== null)
            .filter((one) => typeof one.name === 'string' && one.name !== '')
            .map((one) => ({ name: one.name as string, enabled: one.enabled === true }))
          if (rows.length > 0) enforcement = rows
        }
        for (const entry of asArray(fields.failures)) {
          const one = asObject(entry)
          if (one !== null) {
            failures.push({ id: str(one.id, ''), why: str(one.why, '') })
          }
        }
        for (const entry of asArray(fields.traces)) {
          // Inside the envelope everything is a case by construction, so the
          // bar is only that it has an id and a step list: a case that replayed
          // to nothing is still a case, and dropping it would quietly change
          // the denominator.
          const entryFields = asObject(entry)
          const trace = entryFields !== null && Array.isArray(entryFields.steps) ? readTrace(entryFields) : null
          if (trace === null) skipped += 1
          else traces.push(trace)
        }
        continue
      }
      // Loose records have nothing vouching for them, so they must look like a
      // replayed case — labels that only a replay produces — before we claim them.
      const loose = isTraceShaped(fields) ? readTrace(fields) : null
      if (loose === null) skipped += 1
      else traces.push(loose)
    }
  }

  // Recomputed from the traces in hand, always — a package's own counts are a
  // claim about a file, and this is the file. Where the two disagree the note
  // below carries both numbers rather than picking a winner silently.
  const counts = countOf(traces, failures.length)
  const graphs = traces.map(buildPropagationGraph)

  noteSalvage(files, notes)
  noteCounts(counts, traces, declaredCounts, howToReadTheCounts, notes)
  noteWouldBlockText(counts, traces, notes)
  noteReplay(counts, notes)
  noteTaint(counts, graphs, notes)
  noteGraphProblems(graphs, notes)
  noteFailures(failures, counts, notes)
  if (provenance === undefined && traces.length > 0) {
    notes.push({
      en: 'These traces arrived without the package envelope, so nothing in the drop says who produced them or how. The counts here are recomputed from the records.',
      zh: '这些 trace 没有带数据包外层，所以文件里没有说明是谁、怎么产生的。这里的计数是从记录本身重算的。',
    })
  }
  if (skipped > 0) {
    notes.push({
      en: `${skipped} record${skipped === 1 ? '' : 's'} of ${skipped + traces.length} matched no ArbiterOS replay shape and ${skipped === 1 ? 'is' : 'are'} not shown.`,
      zh: `${skipped + traces.length} 条记录里有 ${skipped} 条不符合 ArbiterOS 回放的结构，没有显示出来。`,
    })
  }

  return {
    traces,
    counts,
    provenance: provenance ?? { what: '', upstream: '', how: '' },
    howToReadTheCounts,
    failures,
    enforcement: enforcement ?? [],
    policies: policiesOf(traces, counts),
    categories: categoriesOf(traces),
    notes: distinct(notes),
  }
}

/* ---------------------------------------------------------- normalisation */

function readProvenance(fields: Record<string, unknown>): Provenance | undefined {
  const source = asObject(fields.source)
  if (source === null) return undefined
  // Every sentence verbatim: this is the credit that travels with the data, and
  // an adapter that rewords it is republishing somebody's work under new words.
  const provenance: Provenance = {
    what: str(source.what, ''),
    upstream: str(source.upstream, ''),
    how: str(source.how, ''),
  }
  const license = source.license
  if (typeof license === 'string') provenance.license = license
  // The runner writes `why_a_run`; the contract calls it `whyARun`.
  const why = source.why_a_run ?? source.whyARun
  if (typeof why === 'string') provenance.whyARun = why
  return provenance
}

function readCounts(fields: Record<string, unknown> | null): Counts | undefined {
  if (fields === null) return undefined
  const byPolicy: Record<string, number> = {}
  const declared = asObject(fields.byPolicy ?? fields.by_policy)
  if (declared !== null) {
    for (const [name, value] of Object.entries(declared)) {
      if (typeof value === 'number' && Number.isFinite(value)) byPolicy[name] = value
    }
  }
  // `refusedByCategory` is read but never trusted as a source: the split is
  // recomputed from the records like every other count, and a declared one that
  // disagrees shows up as a disagreement note rather than silently winning.
  const byCategory: Record<string, { cases: number; refused: number }> = {}
  const declaredSplit = asObject(fields.refusedByCategory ?? fields.refused_by_category)
  if (declaredSplit !== null) {
    for (const [name, value] of Object.entries(declaredSplit)) {
      const row = asObject(value)
      if (row !== null) byCategory[name] = { cases: num(row.cases), refused: num(row.refused) }
    }
  }
  return {
    cases: num(fields.cases),
    steps: num(fields.steps),
    refused: num(fields.refused),
    refusedByCategory: byCategory,
    wouldModifyOnly: num(fields.wouldModifyOnly ?? fields.would_modify_only),
    wouldBlock: num(fields.wouldBlock ?? fields.would_block),
    flagged: num(fields.flagged),
    intercepted: num(fields.intercepted),
    withTaint: num(fields.withTaint ?? fields.with_taint),
    failed: num(fields.failed),
    byPolicy,
  }
}

function readTrace(fields: Record<string, unknown> | null): Trace | null {
  if (fields === null || typeof fields.id !== 'string' || fields.id === '') return null
  const trace: Trace = {
    id: str(fields.id, ''),
    file: str(fields.file, ''),
    verdict: readVerdict(asObject(fields.verdict)),
    steps: asArray(fields.steps)
      .map((step) => readStep(asObject(step)))
      .filter((step): step is Step => step !== null),
  }
  const category = fields.category
  if (typeof category === 'string') trace.category = category
  const traceId = fields.traceId ?? fields.trace_id
  if (typeof traceId === 'string') trace.traceId = traceId
  return trace
}

function readVerdict(fields: Record<string, unknown> | null): Verdict {
  const policySources: Record<string, string> = {}
  const sources = asObject(fields?.policySources ?? fields?.policy_sources)
  if (sources !== null) {
    for (const [name, where] of Object.entries(sources)) {
      if (typeof where === 'string') policySources[name] = where
    }
  }
  const errorType = fields?.errorType ?? fields?.error_type
  // The runner's `wouldBlock`, or the kernel's own `inactivate_error_type`.
  // An empty string is the kernel having nothing to say, so it normalises to
  // null and cannot be counted as a detection by a `!== undefined` test.
  const wouldBlockText = fields?.wouldBlock ?? fields?.inactivate_error_type
  return {
    modified: fields?.modified === true,
    errorType: typeof errorType === 'string' ? errorType : null,
    wouldBlock: typeof wouldBlockText === 'string' && wouldBlockText.trim() !== '' ? wouldBlockText : null,
    policies: asStrings(fields?.policies ?? fields?.policy_names),
    policySources,
  }
}

/**
 * The runner camel-cases the kernel's fields on the way out; the kernel's own
 * `{trace_id}.json` does not. Both spellings are read, so a replay package and a
 * raw kernel dump of the same instructions normalise to one shape.
 */
function readStep(fields: Record<string, unknown> | null): Step | null {
  if (fields === null) return null
  const parentId = fields.parentId ?? fields.parent_id
  const step: Step = {
    id: str(fields.id, ''),
    parentId: typeof parentId === 'string' && parentId !== '' ? parentId : null,
    content: contentOf(fields.content),
    taint: readTaint(taintFieldsOf(fields)),
  }
  const runtimeStep = fields.step ?? fields.runtime_step
  if (typeof runtimeStep === 'number' && Number.isFinite(runtimeStep)) step.step = runtimeStep
  const category = fields.category ?? fields.instruction_category
  if (typeof category === 'string') step.category = category
  const type = fields.type ?? fields.instruction_type
  if (typeof type === 'string') step.type = type
  return step
}

/** The runner's `taint`, or the kernel's `security_type` under its own name. */
function taintFieldsOf(fields: Record<string, unknown> | null): Record<string, unknown> | null {
  if (fields === null) return null
  return asObject(fields.taint) ?? asObject(fields.security_type)
}

function readTaint(fields: Record<string, unknown> | null): Taint {
  const taint: Taint = {}
  if (fields === null) return taint
  const put = (key: 'trust' | 'conf' | 'propTrust' | 'propConf', ...names: string[]): void => {
    for (const name of names) {
      const value = fields[name]
      // Levels are data: an unrecognised one is kept as it arrived, so a kernel
      // that grows a fourth level shows up on screen instead of vanishing.
      if (typeof value === 'string' && value !== '') {
        taint[key] = value
        return
      }
    }
  }
  put('trust', 'trust', 'trustworthiness')
  put('conf', 'conf', 'confidentiality')
  put('propTrust', 'propTrust', 'prop_trustworthiness')
  put('propConf', 'propConf', 'prop_confidentiality')
  if (typeof fields.reversible === 'boolean') taint.reversible = fields.reversible
  if (typeof fields.risk === 'string') taint.risk = fields.risk
  if (typeof fields.authority === 'string') taint.authority = fields.authority
  return taint
}

/**
 * Instruction content is prose for a message and an object for a tool call. The
 * runner serialises the object; a raw dump does not, so it is serialised here
 * the same way. Never translated, never reformatted beyond that.
 */
function contentOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ counts */

function countOf(traces: Trace[], failed: number): Counts {
  const byPolicy: Record<string, number> = {}
  for (const trace of traces) {
    // A policy that fired twice in one case is one case on this tally, which is
    // what the runner counts and what "65 of 105 cases" has to mean.
    for (const name of new Set(trace.verdict.policies)) {
      byPolicy[name] = (byPolicy[name] ?? 0) + 1
    }
  }
  // The refusals split by the suite's own safe/unsafe label. The same number is
  // a hit rate on one side and a false-positive rate on the other, so neither
  // half is allowed to travel without its denominator.
  const refusedByCategory: Record<string, { cases: number; refused: number }> = {}
  for (const trace of traces) {
    const key = trace.category ?? 'unclassified'
    const row = (refusedByCategory[key] ??= { cases: 0, refused: 0 })
    row.cases += 1
    if (hasRefusal(trace)) row.refused += 1
  }
  const wouldBlocked = traces.filter(wouldBlock)
  return {
    cases: traces.length,
    steps: traces.reduce((total, trace) => total + trace.steps.length, 0),
    refused: traces.filter(hasRefusal).length,
    refusedByCategory,
    wouldModifyOnly: wouldBlocked.filter((trace) => !wouldBlockHasText(trace)).length,
    wouldBlock: wouldBlocked.length,
    flagged: traces.filter((trace) => trace.verdict.policies.length > 0).length,
    intercepted: traces.filter(isIntercepted).length,
    withTaint: traces.filter(isTaintedTrace).length,
    failed,
    byPolicy,
  }
}

/** Most-hit policy first, so the filter bar leads with what actually fired. */
function policiesOf(traces: Trace[], counts: Counts): string[] {
  const names = new Set<string>()
  for (const trace of traces) for (const name of trace.verdict.policies) names.add(name)
  return [...names].sort((a, b) => (counts.byPolicy[b] ?? 0) - (counts.byPolicy[a] ?? 0) || a.localeCompare(b))
}

function categoriesOf(traces: Trace[]): string[] {
  const categories = new Set<string>()
  for (const trace of traces) if (trace.category !== undefined && trace.category !== '') categories.add(trace.category)
  return [...categories].sort()
}

/* ------------------------------------------------------- propagation graph */

export interface GraphNode {
  step: Step
  /** 0-based position in `trace.steps`, and the `<caseId>:<stepIndex>` id. */
  index: number
  recordId: string
  id: string
  parentId: string | null
  childIds: string[]
  /**
   * `arguments.reference_tool_id` as the tool call declares it: the earlier
   * calls this one says it used. This is the relation the kernel aggregates
   * labels over (`instruction_parsing/types.py:compute_prop_taint_for_instruction`),
   * and the package does record it — inside the serialised content, which is
   * why it has to be parsed back out here.
   */
  refIds: string[]
  /**
   * Those references resolved to steps of this trace. A `tool_call_id` is
   * shared by a call and its result, so the LAST step carrying the id before
   * this one wins: that is the step that had already run. Same rule as
   * `TaintGraph.tsx`, so the graph and these numbers cannot disagree.
   */
  refIndexes: number[]
  /**
   * Other steps carrying the SAME `tool_call_id`. The kernel's third relation
   * and the one this adapter shipped without: `compute_prop_taint_for_instruction`
   * (`instruction_parsing/types.py`) aggregates over own + same-id + referenced-id
   * instructions, so a tool call and its result — two instructions, one id — pass
   * labels to each other along an edge that is neither a parent link nor a
   * reference. Four labels in the shipped package are reachable only this way,
   * and without it they were reported as explained by nothing.
   */
  sameCallIndexes: number[]
  /** Steps from the root, or `undefined` when the walk up hit a cycle or a gap. */
  depth?: number
  /** This step's parent chain closes on itself; nothing above it can be trusted. */
  inCycle: boolean
}

export type AttributionKind =
  /** The nearest ancestor whose OWN label is the value this step inherited. */
  | 'origin'
  /**
   * The nearest ancestor that carries the value inherited it too, and no
   * ancestor on either recorded relation claims it. The label entered above
   * everything this case records.
   */
  | 'inherited'
  /**
   * No step reachable from this one — up the parent chain or back along
   * `reference_tool_id` — claims this value as its own. Named, not invented.
   */
  | 'unexplained'
  /** The move contradicts min-for-trust / max-for-confidentiality. */
  | 'inconsistent'
  /** A label is not one of LOW / UNKNOWN / HIGH, so it cannot be ordered. */
  | 'unreadable'

export interface Attribution {
  dimension: 'trust' | 'conf'
  stepId: string
  stepIndex: number
  /** What the step claims for itself. */
  own?: string
  /** What it inherited. Differs from `own`, which is why this record exists. */
  inherited?: string
  kind: AttributionKind
  /** The ancestor held responsible, when one was found. */
  ancestorId?: string
  ancestorIndex?: number
  /** Hops to that ancestor along `via`; 1 is one step away. */
  distance?: number
  /** Step's neighbour down to the ancestor inclusive — what a view highlights. */
  chain: string[]
  /**
   * Which relation the ancestor was found along. `parent` is the recorded
   * lineage; `reference` means the parent chain did not explain the label and
   * the tool call's own `reference_tool_id` did.
   */
  via?: 'parent' | 'reference'
}

/** What the package records of the relation the kernel actually aggregates over. */
export interface ReferenceStats {
  /** Steps that are a tool call carrying a `reference_tool_id` key at all. */
  withField: number
  /** Of those, the ones whose list is not empty. */
  withRefs: number
  /** Reference entries in total, across those lists. */
  entries: number
  /** Entries that resolve to a step of the same case. */
  resolved: number
  /** Resolved entries pointing somewhere other than the step's own parent. */
  beyondParent: number
}

export interface PropagationGraph {
  traceId: string
  nodes: GraphNode[]
  byId: Map<string, GraphNode>
  /** Steps with no parent, plus any whose parent is missing — both start a tree. */
  roots: string[]
  /** One per (step, dimension) whose inherited label differs from its own. */
  attributions: Attribution[]
  /** `parentId` naming a step this trace does not contain. Data, not a crash. */
  dangling: { stepId: string; stepIndex: number; parentId: string }[]
  /** Each cycle, in walk order. A model can emit a bad reference; we report it. */
  cycles: string[][]
  /** Ids used by more than one step; the first occurrence wins in `byId`. */
  duplicateIds: string[]
  /** How much `reference_tool_id` this case actually carries. */
  references: ReferenceStats
}

/**
 * The `reference_tool_id` list a step declares, and its own `tool_call_id`.
 *
 * A step's content is prose for a message and serialised JSON for a tool call,
 * so the references are inside a string and have to be parsed back out. Nothing
 * is repaired: content that will not parse yields no references, and the step
 * simply has none. Same reader as `TaintGraph.tsx`.
 */
function readToolCall(content: string): { toolCallId: string | null; refIds: string[]; hasField: boolean } {
  if (!content.startsWith('{')) return { toolCallId: null, refIds: [], hasField: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { toolCallId: null, refIds: [], hasField: false }
  }
  const record = asObject(parsed)
  if (record === null) return { toolCallId: null, refIds: [], hasField: false }
  const args = asObject(record.arguments) ?? {}
  const raw = args.reference_tool_id
  return {
    toolCallId: typeof record.tool_call_id === 'string' ? record.tool_call_id : null,
    refIds: Array.isArray(raw) ? raw.filter((one): one is string => typeof one === 'string') : [],
    hasField: Object.hasOwn(args, 'reference_tool_id'),
  }
}

/**
 * Both recorded relations, plus the derivation that is this adapter's real
 * work: for every step whose inherited label differs from its own, which
 * ancestor is responsible.
 *
 * Trust takes the MINIMUM along the chain and confidentiality the MAXIMUM, so
 * an inherited trust can only be lower than the step's own and an inherited
 * confidentiality only higher. The responsible ancestor is the nearest one
 * whose OWN label is that value — the one that introduced it. The parent chain
 * is searched first because it is the lineage this layout is built on; where it
 * explains nothing, the search continues over `reference_tool_id`, which is the
 * relation the kernel itself aggregates over and which this package does carry
 * inside each tool call's serialised arguments. Only when neither relation
 * reaches a step that claims the value is the result `inherited` (some ancestor
 * carries it, none claims it) or `unexplained` (nothing reachable carries it at
 * all). Neither is dressed up as an answer.
 *
 * Cheap enough to call per render: the committed package is 500 steps in total.
 */
export function buildPropagationGraph(trace: Trace): PropagationGraph {
  const nodes: GraphNode[] = []
  const byId = new Map<string, GraphNode>()
  const duplicateIds: string[] = []

  // A `tool_call_id` belongs to a call and to its result, so a reference can
  // match two steps. The last match BEFORE the referring step is the one taken.
  const tools = trace.steps.map((step) => readToolCall(step.content))
  const lastSeen = new Map<string, number>()
  const references: ReferenceStats = { withField: 0, withRefs: 0, entries: 0, resolved: 0, beyondParent: 0 }
  const resolvedRefs: number[][] = []
  // Every step that declares a `tool_call_id`, grouped by it. Built in the same
  // pass as `lastSeen` but kept separate: `lastSeen` answers "which step does
  // this reference point at", and this answers "which steps ARE this call".
  const byCallId = new Map<string, number[]>()
  trace.steps.forEach((_, index) => {
    const tool = tools[index]
    if (tool.hasField) references.withField += 1
    if (tool.refIds.length > 0) references.withRefs += 1
    const resolved: number[] = []
    for (const refId of tool.refIds) {
      references.entries += 1
      const at = lastSeen.get(refId)
      if (at === undefined) continue
      references.resolved += 1
      if (!resolved.includes(at)) resolved.push(at)
    }
    resolvedRefs.push(resolved)
    if (tool.toolCallId !== null) {
      lastSeen.set(tool.toolCallId, index)
      const sharing = byCallId.get(tool.toolCallId)
      if (sharing === undefined) byCallId.set(tool.toolCallId, [index])
      else sharing.push(index)
    }
  })

  trace.steps.forEach((step, index) => {
    const node: GraphNode = {
      step,
      index,
      recordId: stepRecordId(trace.id, index),
      id: step.id,
      parentId: step.parentId,
      childIds: [],
      refIds: tools[index].refIds,
      refIndexes: resolvedRefs[index],
      sameCallIndexes: [],
      inCycle: false,
    }
    nodes.push(node)
    if (byId.has(step.id)) duplicateIds.push(step.id)
    else byId.set(step.id, node)
  })

  // Filled after the nodes exist, so a step's siblings are indexes into a list
  // that is already complete. A step is never its own sibling.
  for (const node of nodes) {
    const id = tools[node.index].toolCallId
    if (id === null) continue
    node.sameCallIndexes = (byCallId.get(id) ?? []).filter((at) => at !== node.index)
  }

  // "Beyond the parent" needs the parent as an index, which needs every node
  // built first. A reference that IS the parent link is the same edge twice.
  for (const node of nodes) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)
    for (const at of node.refIndexes) {
      if (parent === undefined || parent.index !== at) references.beyondParent += 1
    }
  }

  const dangling: PropagationGraph['dangling'] = []
  const roots: string[] = []
  for (const node of nodes) {
    if (node.parentId === null) {
      roots.push(node.id)
      continue
    }
    const parent = byId.get(node.parentId)
    if (parent === undefined) {
      dangling.push({ stepId: node.id, stepIndex: node.index, parentId: node.parentId })
      roots.push(node.id)
      continue
    }
    parent.childIds.push(node.id)
  }

  const cycles = findCycles(nodes, byId)
  for (const cycle of cycles) {
    for (const id of cycle) {
      const node = byId.get(id)
      if (node !== undefined) node.inCycle = true
    }
  }
  for (const node of nodes) node.depth = depthOf(node, byId)

  const attributions: Attribution[] = []
  for (const node of nodes) {
    for (const attribution of attribute(node, byId, nodes)) attributions.push(attribution)
  }

  return { traceId: trace.id, nodes, byId, roots, attributions, dangling, cycles, duplicateIds, references }
}

/** Root → step. Stops at a missing parent or a cycle, so it always terminates. */
export function chainOf(graph: PropagationGraph, stepId: string): GraphNode[] {
  const chain: GraphNode[] = []
  const seen = new Set<string>()
  let node = graph.byId.get(stepId)
  while (node !== undefined && !seen.has(node.id)) {
    seen.add(node.id)
    chain.push(node)
    node = node.parentId === null ? undefined : graph.byId.get(node.parentId)
  }
  return chain.reverse()
}

/** The attributions for one step: at most one per dimension. */
export function attributionsOf(graph: PropagationGraph, stepId: string): Attribution[] {
  return graph.attributions.filter((one) => one.stepId === stepId)
}

/**
 * Where a step's inherited label came from, per dimension.
 *
 * `aggregate` is the kernel's own: `min` for trust, `max` for confidentiality.
 * A move in the other direction cannot come from the chain at all, and is
 * reported as `inconsistent` rather than attributed to somebody.
 *
 * Two relations are searched, parent lineage first and then `reference_tool_id`
 * — nearest first in both, because with several upstream LOWs the minimum is
 * still the minimum and the closest one is the one a reader can go and check.
 */
function attribute(node: GraphNode, byId: Map<string, GraphNode>, nodes: GraphNode[]): Attribution[] {
  const out: Attribution[] = []
  const dimensions = [
    { dimension: 'trust' as const, own: node.step.taint.trust, inherited: node.step.taint.propTrust, aggregate: Math.min },
    { dimension: 'conf' as const, own: node.step.taint.conf, inherited: node.step.taint.propConf, aggregate: Math.max },
  ]

  for (const { dimension, own, inherited, aggregate } of dimensions) {
    if (inherited === undefined || own === inherited) continue
    const base: Attribution = {
      dimension,
      stepId: node.id,
      stepIndex: node.index,
      own,
      inherited,
      kind: 'unexplained',
      chain: [],
    }
    const ownLevel = levelOf(own)
    const inheritedLevel = levelOf(inherited)
    if (ownLevel === undefined || inheritedLevel === undefined) {
      out.push({ ...base, kind: 'unreadable' })
      continue
    }
    if (aggregate(LEVEL_ORDER[ownLevel], LEVEL_ORDER[inheritedLevel]) !== LEVEL_ORDER[inheritedLevel]) {
      out.push({ ...base, kind: 'inconsistent' })
      continue
    }

    const chain: string[] = []
    const seen = new Set<string>([node.id])
    let carrier: GraphNode | undefined
    let carrierAt = 0
    let current = node.parentId === null ? undefined : byId.get(node.parentId)
    let found: Attribution | undefined

    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current.id)
      const ancestorOwn = dimension === 'trust' ? current.step.taint.trust : current.step.taint.conf
      const ancestorInherited =
        dimension === 'trust' ? current.step.taint.propTrust : current.step.taint.propConf
      if (ancestorOwn === inherited) {
        // The ancestor claims this value itself: it is where the label enters.
        found = {
          ...base,
          kind: 'origin',
          ancestorId: current.id,
          ancestorIndex: current.index,
          distance: chain.length,
          chain: [...chain],
          via: 'parent',
        }
        break
      }
      if (carrier === undefined && ancestorInherited === inherited) {
        carrier = current
        carrierAt = chain.length
      }
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }

    // The parent chain named nobody. The kernel does not aggregate over parent
    // lineage anyway — it aggregates over `reference_tool_id`, which this
    // package records inside each tool call's arguments — so that relation is
    // walked before anything is called unexplained.
    const viaReference = found === undefined ? referenceOrigin(node, nodes, dimension, inherited) : undefined

    if (found !== undefined) out.push(found)
    else if (viaReference !== undefined) out.push({ ...base, ...viaReference, kind: 'origin', via: 'reference' })
    else if (carrier !== undefined) {
      out.push({
        ...base,
        kind: 'inherited',
        ancestorId: carrier.id,
        ancestorIndex: carrier.index,
        distance: carrierAt,
        chain: chain.slice(0, carrierAt),
        via: 'parent',
      })
    } else out.push({ ...base, chain: [...chain] })
  }

  return out
}

/**
 * The nearest step reachable back along `reference_tool_id` whose OWN label is
 * the value this step inherited.
 *
 * Breadth-first from the step itself, so "nearest" is hops of reference and not
 * position in the trace. Returns nothing when the references reach no such step
 * — including the common case of a step whose reference list is empty, where
 * there is no edge to walk and the label came from somewhere this package does
 * not record.
 */
function referenceOrigin(
  node: GraphNode,
  nodes: GraphNode[],
  dimension: 'trust' | 'conf',
  inherited: string,
): { ancestorId: string; ancestorIndex: number; distance: number; chain: string[] } | undefined {
  const cameFrom = new Map<number, number>()
  const seen = new Set<number>([node.index])
  const queue: number[] = [node.index]
  while (queue.length > 0) {
    const at = queue.shift() as number
    for (const up of [...nodes[at].refIndexes, ...nodes[at].sameCallIndexes]) {
      if (seen.has(up)) continue
      seen.add(up)
      cameFrom.set(up, at)
      const ancestor = nodes[up]
      const ancestorOwn = dimension === 'trust' ? ancestor.step.taint.trust : ancestor.step.taint.conf
      if (ancestorOwn === inherited) {
        // Walk the trail back to the step, then read it the way a parent chain
        // reads: first hop first, the named ancestor last.
        const chain: string[] = []
        for (let cursor = up; cursor !== node.index; cursor = cameFrom.get(cursor) as number) {
          chain.unshift(nodes[cursor].id)
        }
        return { ancestorId: ancestor.id, ancestorIndex: ancestor.index, distance: chain.length, chain }
      }
      queue.push(up)
    }
  }
  return undefined
}

/** Iterative, so a 500-step chain cannot blow the stack, and cycle-safe. */
function findCycles(nodes: GraphNode[], byId: Map<string, GraphNode>): string[][] {
  const cycles: string[][] = []
  const settled = new Set<string>()
  for (const start of nodes) {
    if (settled.has(start.id)) continue
    const path: string[] = []
    const at = new Map<string, number>()
    let current: GraphNode | undefined = start
    while (current !== undefined && !settled.has(current.id)) {
      const seenAt = at.get(current.id)
      if (seenAt !== undefined) {
        cycles.push(path.slice(seenAt))
        break
      }
      at.set(current.id, path.length)
      path.push(current.id)
      current = current.parentId === null ? undefined : byId.get(current.parentId)
    }
    for (const id of path) settled.add(id)
  }
  return cycles
}

/** Undefined inside or below a cycle: there is no honest distance to a root. */
function depthOf(node: GraphNode, byId: Map<string, GraphNode>): number | undefined {
  let depth = 0
  const seen = new Set<string>([node.id])
  let current = node
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId)
    if (parent === undefined) return depth // dangling: treated as its own root
    if (seen.has(parent.id)) return undefined
    seen.add(parent.id)
    depth += 1
    current = parent
  }
  return depth
}

/* -------------------------------------------------------------------- notes */

/**
 * The pair this whole adapter exists to get right.
 *
 * The package carries its own English version in `how_to_read_the_counts` and
 * the view renders that verbatim; these are AgentLens's own bilingual
 * statements of the same facts, with this package's numbers in them, so a
 * Chinese reader is not left with the misreading the English sentence exists to
 * prevent. Two notes, because there are two separate mistakes to head off:
 * reading `intercepted` alone (the suite looks useless), and reading `flagged`
 * as detection (the suite looks sixty-six times better than it is).
 */
function noteCounts(
  counts: Counts,
  traces: Trace[],
  declared: Counts | undefined,
  howToReadTheCounts: string | undefined,
  notes: Str[],
): void {
  if (counts.cases === 0) return
  // How many policies are registered and how many observe is configuration, not
  // data: `policy_registry.json` is meant to be edited. So those numbers are read
  // out of the package's own sentence rather than written here, and the clause is
  // left off entirely when the package does not state them — this note must not
  // still be claiming "11 of 15" about a run made under another registry.
  const split =
    /(\d+) of the (\d+) policies observe-only/.exec(howToReadTheCounts ?? '') ??
    /(\d+) of (\d+) observe-only/.exec(howToReadTheCounts ?? '')
  const observing =
    split === null ? '' : ` — ${split[1]} of the ${split[2]} registered policies are observe-only in the configuration this run used`
  const observingZh = split === null ? '' : `——这次运行的配置里，${split[2]} 条已注册 policy 中有 ${split[1]} 条是"仅观察"`
  // THE HEADLINE, and the number this adapter was wrong about three times before
  // it was right. Not `wouldBlock` — that is mostly the kernel's stand-in — but
  // the cases where a policy actually stated a rule and a reason. It leads with
  // the safe/unsafe split because the split is the finding: the same refusals
  // are a hit rate on the attacks and a false-positive rate on the benign cases,
  // and either one alone reads as a better result than the run supports.
  const halves = refusalSplit(counts)
  notes.push({
    en:
      `${counts.refused} of ${counts.cases} cases had a policy compose an actual refusal — naming the rule and the ` +
      `reason${halves.en}. Of those ${counts.refused}, the kernel was allowed to act on ${counts.intercepted}` +
      `${observing}; the rest were recorded and the original response returned. So the pair to read is what the policy ` +
      `set decided (${counts.refused}) and what this configuration let it do (${counts.intercepted}).`,
    zh:
      `${counts.cases} 个 case 里，有 ${counts.refused} 个被某条 policy 写出了真正的拒绝——说明了是哪条规则、为什么` +
      `${halves.zh}。这 ${counts.refused} 个里，内核被允许照着执行的只有 ${counts.intercepted} 个${observingZh}，` +
      `其余的只是被记录下来，返回给调用方的仍是原响应。所以要一起读的是这一对：策略集判定了什么（${counts.refused}），` +
      `以及这套配置允许它做什么（${counts.intercepted}）。`,
  })

  // `flagged` is the trap. It is in the package, so it is reported; it is
  // labelled for what it is in the same breath, with the arithmetic that shows
  // it: a policy name is recorded when an ENFORCING policy reports it changed
  // the response, and this counts how many of those cases came back unchanged.
  const namedButUnchanged = traces.filter((one) => one.verdict.policies.length > 0 && !isIntercepted(one)).length
  if (counts.flagged > 0) {
    notes.push({
      en:
        `A third number, \`flagged\`, is not a detection count and reads like one: ${counts.flagged} of ${counts.cases} ` +
        `cases have a policy name recorded, and ${namedButUnchanged} of those ${counts.flagged} came back with the ` +
        'response the model produced — no rewrite, no refusal text. A name is recorded when a policy registered to ' +
        'enforce reports it changed the response; reporting a change is not the same as the caller receiving a ' +
        'different one. The detection figure is the one above.',
      zh:
        `还有第三个数字 \`flagged\`，它看起来像检出数，但不是：${counts.cases} 个 case 里有 ${counts.flagged} 个记录到了 policy 名字，` +
        `而这 ${counts.flagged} 个里有 ${namedButUnchanged} 个最终返回的仍是模型原本的响应——没有改写，也没有拒绝文案。` +
        '记录名字的条件是：一条被注册为"强制执行"的 policy 报告自己改了响应；但"报告改过"和"调用方收到的东西变了"不是一回事。' +
        '检出数看上面那个。',
    })
  }

  if (declared === undefined) return
  const disagreements = (
    ['cases', 'steps', 'refused', 'wouldModifyOnly', 'wouldBlock', 'flagged', 'withTaint', 'intercepted', 'failed'] as const
  )
    .filter((key) => declared[key] !== counts[key])
    .map((key) => `${key} ${declared[key]} vs ${counts[key]}`)
  if (disagreements.length === 0) return
  notes.push({
    en: `The package's own counts disagree with the records in it (declared vs recomputed: ${disagreements.join('; ')}). The numbers shown are recomputed from the records.`,
    zh: `数据包自报的计数和包里的记录对不上（自报 vs 重算：${disagreements.join('；')}）。页面上显示的是从记录重算出来的数。`,
  })
}

/**
 * The refusals broken down by the suite's own label, as a clause to hang off the
 * headline.
 *
 * Unsafe first — that is the hit rate, and it is what a reader is looking for —
 * then safe, which is the cost of the hit rate. Empty when the package carries
 * one category or none, because "39 of 105, all unsafe" restates the headline
 * rather than qualifying it.
 */
function refusalSplit(counts: Counts): Str {
  const rank = (name: string): number => (name === 'unsafe' ? 0 : name === 'safe' ? 1 : 2)
  const rows = Object.entries(counts.refusedByCategory ?? {})
    .filter(([, row]) => row.cases > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
  if (rows.length < 2) return { en: '', zh: '' }
  const pct = (row: { cases: number; refused: number }): string =>
    `${Math.round((row.refused / row.cases) * 100)}%`
  return {
    en:
      ', across both halves of the suite: ' +
      rows.map(([name, row]) => `${row.refused} of the ${row.cases} labelled ${name} (${pct(row)})`).join(', '),
    zh:
      '。两半用例都算上：' +
      rows.map(([name, row]) => `标为 ${name} 的 ${row.cases} 个里有 ${row.refused} 个（${pct(row)}）`).join('，'),
  }
}

/**
 * What a detection actually contains.
 *
 * `wouldBlock` is the refusal a policy would have returned — except when the
 * policy handed over no text, where the kernel writes one fixed sentence in its
 * place (`policy_check.py: apply_policy_enforcement_mode`). Those two are not
 * equally informative and the split is not visible from the count, so it is
 * stated: a reader who opens a case expecting a refusal and finds a placeholder
 * should have been told first.
 */
function noteWouldBlockText(counts: Counts, traces: Trace[], notes: Str[]): void {
  if (counts.wouldBlock === 0) return
  const withText = traces.filter((one) => wouldBlock(one) && wouldBlockHasText(one)).length
  const placeholderOnly = counts.wouldBlock - withText
  if (placeholderOnly === 0) return
  notes.push({
    en:
      `A fourth number is in the package and is the easiest one to misread: \`wouldBlock\`, ${counts.wouldBlock} of ` +
      `${counts.cases}, counts \`inactivate_error_type\` being non-empty. Only ${withText} of them ` +
      `${withText === 1 ? 'holds' : 'hold'} a refusal a policy wrote; the other ${placeholderOnly} ` +
      `${placeholderOnly === 1 ? 'holds' : 'hold'} nothing but the kernel's stand-in line, ` +
      `"${WOULD_BLOCK_PLACEHOLDER}", which the kernel writes itself when a gated policy reports a change and states no ` +
      `reason. Reporting ${counts.wouldBlock} as the detection rate would roughly double what this run supports. The ` +
      'package also does not record which policy wrote either kind: a gated policy is neutralised before the kernel ' +
      'takes its name down, which is why the names in `policies` are only ever policies registered to enforce.',
    zh:
      `包里还有第四个数字，也是最容易被读错的一个：\`wouldBlock\`，${counts.cases} 个里有 ${counts.wouldBlock} 个——` +
      `它数的是 \`inactivate_error_type\` 非空。这 ${counts.wouldBlock} 个里，只有 ${withText} 个装着某条 policy 写下的拒绝理由；` +
      `另外 ${placeholderOnly} 个装的只是内核自己补的占位句 "${WOULD_BLOCK_PLACEHOLDER}"——那是"有 policy 说它会改，但没说为什么"` +
      `时内核填进去的。把 ${counts.wouldBlock} 当成检出率报出去，等于把这次运行支持的结论放大了近一倍。` +
      '数据包也没有记录这两类分别是哪条 policy 写的：内核在记下名字之前就把被限制的 policy 结果作废了，' +
      '所以 `policies` 里出现的，永远只会是被注册为强制执行的 policy。',
  })
}

function noteReplay(counts: Counts, notes: Str[]): void {
  if (counts.cases === 0) return
  notes.push({
    en:
      `${counts.cases} cases and ${counts.steps.toLocaleString()} instructions, replayed through ArbiterOS's own policy ` +
      'kernel offline: no model was called, no gateway, no network, no cost. Every label and verdict here was computed ' +
      'by the kernel, not written by an LLM.',
    zh:
      `${counts.cases} 个 case、${counts.steps.toLocaleString()} 条指令，是在离线状态下灌进 ArbiterOS 自己的 policy 内核重放出来的：` +
      '没有调用模型、没有网关、没有联网、没有花费。这里的每一个标签和判决都是内核算出来的，不是大模型写的。',
  })
}

/**
 * What `propTrust`/`propConf` mean, and how far the graph can honestly go.
 *
 * The second half is the caveat that keeps the first half true. It used to read
 * that the kernel aggregates along `reference_tool_id` "which a replay package
 * does not record" — that was false, and the graph beside it was drawing arcs
 * from the very field. The package records the references inside each tool
 * call's serialised arguments; `buildPropagationGraph` parses them back out and
 * searches them. So the caveat is now the measured one: how much of that
 * relation is here, and what is left over once both relations have been walked.
 */
function noteTaint(counts: Counts, graphs: PropagationGraph[], notes: Str[]): void {
  if (counts.cases === 0) return
  notes.push({
    en:
      `${counts.withTaint} of ${counts.cases} cases carry a LOW trust or HIGH confidentiality label after propagation. ` +
      'Trust takes the minimum along the chain and confidentiality the maximum — one untrusted upstream makes the whole ' +
      'chain untrusted, one secret upstream makes it secret. `trust`/`conf` are a step\'s own labels; ' +
      '`propTrust`/`propConf` are what it inherited.',
    zh:
      `${counts.cases} 个 case 里有 ${counts.withTaint} 个在传播之后带着 LOW 可信度或 HIGH 机密度的标签。` +
      '可信度沿引用链取最小值、机密度取最大值——上游碰过任何不可信的数据，整条链就不可信；碰过任何机密，整条链就机密。' +
      '`trust`/`conf` 是这一步自己的标签，`propTrust`/`propConf` 是它继承来的。',
  })

  const attributions = graphs.flatMap((graph) => graph.attributions)
  if (attributions.length === 0) return
  const unresolved = attributions.filter((one) => one.kind === 'inherited' || one.kind === 'unexplained').length
  const named = attributions.length - unresolved
  const refs = graphs.reduce(
    (total, graph) => ({
      withField: total.withField + graph.references.withField,
      withRefs: total.withRefs + graph.references.withRefs,
      entries: total.entries + graph.references.entries,
      resolved: total.resolved + graph.references.resolved,
      beyondParent: total.beyondParent + graph.references.beyondParent,
    }),
    { withField: 0, withRefs: 0, entries: 0, resolved: 0, beyondParent: 0 },
  )
  // WHY a label is unresolved, checked rather than assumed. The first guess was
  // "these steps declare no references, so there is no edge" — and that was
  // wrong: they do have an edge, to the step sharing their `tool_call_id`, and
  // that step carries the same label. What no reachable step does is CLAIM the
  // label as its own. Each of these is one half of a closed pair holding a value
  // that nothing in the case introduces, so there is no ancestor to name and
  // naming one would be an invention.
  const stranded = graphs.flatMap((graph) =>
    graph.attributions
      .filter((one) => one.kind === 'inherited' || one.kind === 'unexplained')
      .map((one) => ({ graph, node: graph.nodes[one.stepIndex] })),
  )
  const inClosedPair = stranded.filter(
    ({ node }) => node.refIndexes.length === 0 && node.sameCallIndexes.length > 0,
  ).length
  const emptyClause =
    inClosedPair === unresolved && unresolved > 0
      ? ' — each of those declares no references and shares its `tool_call_id` with exactly the step that carries the same label back, so the two hold it between them and no instruction in the case claims it'
      : ''
  const emptyClauseZh =
    inClosedPair === unresolved && unresolved > 0
      ? '——它们都没有申报引用，而与它们共用同一个 `tool_call_id` 的那一步，恰好把同一个标签又指了回来：两步互相持有这个值，而这个 case 里没有任何一条指令声称它是自己的'
      : ''
  notes.push({
    en:
      `${attributions.length} step${attributions.length === 1 ? '' : 's'} inherited a label different from ${attributions.length === 1 ? 'its' : 'their'} own; ` +
      `${named} of those name the ancestor that introduced it. The kernel aggregates along \`reference_tool_id\`, and ` +
      `this package does carry it, inside each tool call's serialised arguments: ${refs.withField} of ${counts.steps} ` +
      `steps declare the field, ${refs.withRefs} with a non-empty list, ${refs.resolved} of ${refs.entries} entries ` +
      `resolving to a step of the same case and ${refs.beyondParent} of those pointing somewhere other than the ` +
      `step's own parent. All three relations the kernel aggregates over are searched — parent, reference, and ` +
      `steps sharing a \`tool_call_id\`. The remaining ${unresolved} are reported as unexplained rather than ` +
      `attributed to a step that may not be responsible${emptyClause}.`,
    zh:
      `有 ${attributions.length} 步继承到的标签和自己的不一样，其中 ${named} 步能指出是哪一个上游把它带进来的。` +
      '内核的聚合是沿 `reference_tool_id` 走的，而这份数据包里有这个字段——它在每个工具调用被序列化后的参数里：' +
      `${counts.steps} 步中有 ${refs.withField} 步申报了这个字段，其中 ${refs.withRefs} 步的列表非空；` +
      `${refs.entries} 条引用里有 ${refs.resolved} 条能落到同一个 case 的某一步上，其中 ${refs.beyondParent} 条指向的不是它自己的父指令。` +
      `内核聚合时用到的三种关系——父指令、引用、以及共用同一个 \`tool_call_id\` 的步骤——都会被搜索。` +
      `剩下的 ${unresolved} 步会标成"都解释不了"，而不是硬扣到某个未必负责的上游头上${emptyClauseZh}。`,
  })
}

function noteGraphProblems(graphs: PropagationGraph[], notes: Str[]): void {
  const dangling = graphs.flatMap((graph) => graph.dangling.map(() => graph.traceId))
  const cycles = graphs.flatMap((graph) => graph.cycles.map(() => graph.traceId))
  const duplicates = graphs.flatMap((graph) => graph.duplicateIds.map(() => graph.traceId))

  if (dangling.length > 0) {
    const cases = new Set(dangling).size
    notes.push({
      en: `${dangling.length} step${dangling.length === 1 ? '' : 's'} in ${cases} case${cases === 1 ? '' : 's'} name a parent this package does not contain. Each is drawn as its own root and marked.`,
      zh: `有 ${cases} 个 case 里的 ${dangling.length} 步指向了这份数据包里没有的父指令。它们各自当作一个根来画，并做了标记。`,
    })
  }
  if (cycles.length > 0) {
    const cases = new Set(cycles).size
    notes.push({
      en: `${cycles.length} reference cycle${cycles.length === 1 ? '' : 's'} in ${cases} case${cases === 1 ? '' : 's'}: a chain of parents that closes on itself. Reported rather than followed; steps inside one have no distance to a root.`,
      zh: `有 ${cases} 个 case 出现了 ${cycles.length} 处引用环——父指令链绕回了自己。这里只报告、不去跟着走；环里的步骤没有到根的距离。`,
    })
  }
  if (duplicates.length > 0) {
    const cases = new Set(duplicates).size
    notes.push({
      en: `${duplicates.length} instruction id${duplicates.length === 1 ? ' is' : 's are'} used more than once in ${cases} case${cases === 1 ? '' : 's'}; edges resolve to the first step carrying the id.`,
      zh: `有 ${cases} 个 case 里的 ${duplicates.length} 个指令 id 被重复使用；连边只认第一条带这个 id 的指令。`,
    })
  }
}

function noteFailures(failures: { id: string; why: string }[], counts: Counts, notes: Str[]): void {
  if (failures.length === 0) return
  const total = counts.cases + failures.length
  notes.push({
    en: `${failures.length} of ${total} cases would not replay and are listed unopened, with the reason each gave.`,
    zh: `${total} 个 case 里有 ${failures.length} 个没能回放，它们连同各自的原因一起列出，没有被悄悄丢掉。`,
  })
}

function noteSalvage(files: ParsedFile[], notes: Str[]): void {
  for (const file of files) {
    if (!file.salvaged) continue
    const n = file.records.length
    notes.push({
      en:
        `${file.fileName} is not valid JSON; ${n} record${n === 1 ? ' was' : 's were'} recovered in salvage mode ` +
        `(${file.problems.length} problem${file.problems.length === 1 ? '' : 's'}). A partly recovered file is not a clean parse.`,
      zh:
        `${file.fileName} 不是合法的 JSON；在抢救模式下取回了 ${n} 条记录` +
        `（${file.problems.length} 处问题）。抢救回来的一部分，不等于一次干净的解析。`,
    })
  }
}

function distinct(notes: Str[]): Str[] {
  const seen = new Map<string, Str>()
  for (const note of notes) {
    const key = `${note.en} :: ${note.zh}`
    if (!seen.has(key)) seen.set(key, note)
  }
  return [...seen.values()]
}

/* -------------------------------------------------------------------- utils */

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
