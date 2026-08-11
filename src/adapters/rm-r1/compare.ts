/**
 * The pure half of V3 · Run Compare: how two runs of one benchmark are aligned,
 * and what the comparison is allowed to claim.
 *
 * No React and no DOM, so `node --test` can exercise it against the real logs —
 * which is where the two rules below were checked rather than assumed.
 *
 * Alignment is on the dataset pair itself (prompt + both responses), never on
 * row order and never on the harness's `id`. A sampled export and a full log
 * then still line up, and a record that exists on only one side is counted and
 * reported rather than quietly dropped.
 *
 * Verdicts are compared only after position is normalised. `run_generative.py`
 * assigns the A/B slots with an unseeded `np.random.rand() > 0.5`, so which slot
 * held the better answer is a property of the run, not of the record;
 * `chosenShownAs` is the only thing that makes two runs comparable. What the
 * view says about that is a count taken from the data in hand (`mirrored`,
 * `rawWouldMisread`), never a rate assumed for runs nobody loaded.
 *
 * The two runs are Run 1 and Run 2 here and on screen, never A and B: in this
 * view A and B are the judge's answer slots, and one pair of letters cannot mean
 * both things at once.
 */

import type { Benchmark, Judgement, Message, RmR1Model } from './contract'

/** One log file's worth of judgements for one benchmark. */
export interface Run {
  /** `<fileName> + <benchmark>`; unique per run, and never shown to a reader. */
  key: string
  fileName: string
  benchmark: Benchmark
  judgements: Judgement[]
  /**
   * Records that share an alignment key with an earlier record in the same run.
   * Two dropped files with the same name land in one run and show up here — the
   * RewardBench logs of both released checkpoints are both called `logs.json`.
   */
  duplicateKeys: number
}

export type Cell = 'both-right' | 'run1-only' | 'run2-only' | 'both-wrong' | 'indeterminate'

/** `'disagree'` is the union of the two one-sided cells: the default view. */
export type CellFilter = Cell | 'disagree' | 'all'

export interface Pair {
  key: string
  group: string
  styleIndex?: number
  one: Judgement
  two: Judgement
  cell: Cell
  /** The two runs showed the same record with the slots swapped. */
  mirrored: boolean
}

export interface GroupDelta {
  group: string
  aligned: number
  oneRight: number
  twoRight: number
  /** Run 2 accuracy minus Run 1 accuracy, in points, over aligned records only. */
  delta: number
}

export interface Alignment {
  pairs: Pair[]
  counts: Record<Cell, number>
  /** Records with no counterpart in the other run. */
  onlyInRun1: number
  onlyInRun2: number
  /** Pairs where the two runs put the better answer in different slots. */
  mirrored: number
  /** Pairs where both judges' verdicts parsed, so raw `[[A]]`/`[[B]]` is comparable at all. */
  verdictComparable: number
  /**
   * Pairs among `verdictComparable` where comparing the raw `[[A]]`/`[[B]]`
   * letters gives the opposite answer to comparing normalised sides. Counted,
   * not derived: if it ever stops equalling `mirrored` the assumption behind
   * this whole view is wrong and the number on screen will say so.
   */
  rawWouldMisread: number
  /** Judgements whose parsed verdict contradicts the harness's own `correct`. */
  verdictConflicts: number
  groups: GroupDelta[]
  determinate: number
  oneRight: number
  twoRight: number
}

const EMPTY_COUNTS: Record<Cell, number> = {
  'both-right': 0,
  'run1-only': 0,
  'run2-only': 0,
  'both-wrong': 0,
  indeterminate: 0,
}

/** FNV-1a, 32-bit. Paired with `hash2` below so the key is ~64 bits wide. */
function hash1(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/** djb2. Independent of `hash1`, which is the point of having two. */
function hash2(text: string): number {
  let value = 5381
  for (let i = 0; i < text.length; i += 1) value = (Math.imul(value, 33) + text.charCodeAt(i)) | 0
  return value >>> 0
}

function fingerprint(messages: readonly Message[]): string {
  let flat = ''
  for (const message of messages) flat += `${message.role} :: ${message.content}`
  return `${flat.length.toString(36)}.${hash1(flat).toString(36)}.${hash2(flat).toString(36)}`
}

/**
 * What two runs are aligned on. Everything in it is dataset-side — the question
 * and the two candidate answers — so nothing the judge did can move a record to
 * a different key.
 */
export function alignKey(judgement: Judgement): string {
  const prompt = judgement.prompt ?? ''
  return [
    judgement.styleIndex ?? '-',
    `${prompt.length.toString(36)}.${hash1(prompt).toString(36)}`,
    fingerprint(judgement.chosen),
    fingerprint(judgement.rejected),
  ].join('|')
}

function runKeyOf(judgement: Judgement, fileNames: readonly string[]): string {
  for (const name of fileNames) if (judgement.id.startsWith(`${name}:`)) return name
  const cut = judgement.id.indexOf(':')
  return cut > 0 ? judgement.id.slice(0, cut) : judgement.id
}

/**
 * The runs present in a model, in load order. Derived from the judgements
 * rather than read from `model.runs`, which the contract lets an adapter leave
 * empty; the file names there are used only to split ids that contain a colon.
 */
export function splitRuns(model: RmR1Model): Run[] {
  const fileNames = model.runs.map((run) => run.fileName)
  const byKey = new Map<string, { run: Run; keys: Set<string> }>()
  for (const judgement of model.judgements) {
    const fileName = runKeyOf(judgement, fileNames)
    const key = `${fileName} :: ${judgement.benchmark}`
    let entry = byKey.get(key)
    if (!entry) {
      entry = {
        run: { key, fileName, benchmark: judgement.benchmark, judgements: [], duplicateKeys: 0 },
        keys: new Set(),
      }
      byKey.set(key, entry)
    }
    const recordKey = alignKey(judgement)
    if (entry.keys.has(recordKey)) entry.run.duplicateKeys += 1
    else entry.keys.add(recordKey)
    entry.run.judgements.push(judgement)
  }
  return [...byKey.values()].map((entry) => entry.run)
}

/** Benchmarks with at least two runs loaded, in load order. */
export function comparableBenchmarks(runs: readonly Run[]): Benchmark[] {
  const counts = new Map<Benchmark, number>()
  for (const run of runs) counts.set(run.benchmark, (counts.get(run.benchmark) ?? 0) + 1)
  return [...counts].filter(([, count]) => count > 1).map(([benchmark]) => benchmark)
}

/** Which response the judge picked, in dataset terms rather than slot terms. */
export function pickedSide(judgement: Judgement): 'chosen' | 'rejected' | null {
  const verdict = judgement.cor.verdict
  if (verdict === null) return null
  return verdict === judgement.chosenShownAs ? 'chosen' : 'rejected'
}

function cellOf(one: Judgement, two: Judgement): Cell {
  if (one.correct === null || two.correct === null) return 'indeterminate'
  if (one.correct && two.correct) return 'both-right'
  if (one.correct) return 'run1-only'
  if (two.correct) return 'run2-only'
  return 'both-wrong'
}

export function alignRuns(one: Run, two: Run): Alignment {
  const index = new Map<string, Judgement>()
  for (const judgement of two.judgements) {
    const key = alignKey(judgement)
    if (!index.has(key)) index.set(key, judgement)
  }

  const pairs: Pair[] = []
  const counts = { ...EMPTY_COUNTS }
  const groups = new Map<string, GroupDelta>()
  const matched = new Set<string>()
  let mirrored = 0
  let verdictComparable = 0
  let rawWouldMisread = 0
  let verdictConflicts = 0
  let determinate = 0
  let oneRight = 0
  let twoRight = 0

  for (const left of one.judgements) {
    const key = alignKey(left)
    const right = index.get(key)
    if (!right || matched.has(key)) continue
    matched.add(key)

    const cell = cellOf(left, right)
    const isMirrored = left.chosenShownAs !== right.chosenShownAs
    if (isMirrored) mirrored += 1
    counts[cell] += 1
    pairs.push({
      key,
      group: left.group,
      styleIndex: left.styleIndex,
      one: left,
      two: right,
      cell,
      mirrored: isMirrored,
    })

    const leftSide = pickedSide(left)
    const rightSide = pickedSide(right)
    if (leftSide !== null && rightSide !== null) {
      verdictComparable += 1
      const rawAgrees = left.cor.verdict === right.cor.verdict
      if (rawAgrees !== (leftSide === rightSide)) rawWouldMisread += 1
    }
    for (const [judgement, side] of [
      [left, leftSide],
      [right, rightSide],
    ] as const) {
      if (side !== null && judgement.correct !== null && (side === 'chosen') !== judgement.correct) {
        verdictConflicts += 1
      }
    }

    if (cell !== 'indeterminate') {
      determinate += 1
      if (left.correct) oneRight += 1
      if (right.correct) twoRight += 1
      const group = groups.get(left.group) ?? {
        group: left.group,
        aligned: 0,
        oneRight: 0,
        twoRight: 0,
        delta: 0,
      }
      group.aligned += 1
      if (left.correct) group.oneRight += 1
      if (right.correct) group.twoRight += 1
      groups.set(left.group, group)
    }
  }

  const deltas = [...groups.values()].map((group) => ({
    ...group,
    delta: (100 * (group.twoRight - group.oneRight)) / group.aligned,
  }))
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.aligned - a.aligned)

  return {
    pairs,
    counts,
    onlyInRun1: one.judgements.length - pairs.length,
    onlyInRun2: two.judgements.length - pairs.length,
    mirrored,
    verdictComparable,
    rawWouldMisread,
    verdictConflicts,
    groups: deltas,
    determinate,
    oneRight,
    twoRight,
  }
}

export function matchesFilter(pair: Pair, cell: CellFilter, group: string | null): boolean {
  if (group !== null && pair.group !== group) return false
  if (cell === 'all') return true
  if (cell === 'disagree') return pair.cell === 'run1-only' || pair.cell === 'run2-only'
  return pair.cell === cell
}

/** The question, for the row label. `undefined` prompt is RewardBench's normal state. */
export function questionOf(judgement: Judgement): string {
  if (judgement.prompt) return judgement.prompt
  const user = judgement.chosen.find((message) => message.role === 'user')
  return user?.content ?? judgement.chosen[0]?.content ?? ''
}

/* ------------------------------------------------------------------ formatting */

export function formatPercent(part: number, total: number): string {
  return total === 0 ? '—' : `${((100 * part) / total).toFixed(1)}%`
}

export function formatPoints(value: number): string {
  return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}

export function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}
