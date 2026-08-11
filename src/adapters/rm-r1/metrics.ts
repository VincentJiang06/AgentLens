/**
 * RM-Bench's 3x3 style matrix — computed twice, on purpose.
 *
 * RM-Bench asks the judge the same question nine times: each of three chosen
 * styles (concise / detailed / detailed+markdown) against each of three rejected
 * styles. Nine comparisons do not fit in one pass, so the harness runs three,
 * each rotated one step, and writes `total_dataset_{1,2,3}_<model>.json`. The
 * matrix is reassembled afterwards by `eval/RM-Bench/scripts/process_final_result.py`.
 *
 * That script computes `output_path2` and then never opens it — `data2` is read
 * from `output_path3`. So `total_dataset_2` is discarded, `total_dataset_3` is
 * counted twice, and three of the nine cells collapse onto their neighbours.
 * `hard_acc` and `easy_acc` move; `normal_acc` is the diagonal, which comes from
 * file 1 alone, so it cannot move.
 *
 * This module therefore does the same computation under two file orders:
 * `CORRECTED_FILE_ORDER` (what the matrix is supposed to be) and
 * `SHIPPED_FILE_ORDER` (what the script does). The second is not a curiosity —
 * reproducing the released `final_result.json` to the last digit is the only
 * thing that licenses saying the corrected numbers differ by that one line and
 * nothing else. Both travel together in `RmBenchSummary`; a view must never show
 * one without the other.
 *
 * Pure: no React, no DOM, no fs. `node --test src/adapters/rm-r1/metrics.test.ts`.
 */

import type { DomainScores, Judgement, RmBenchSummary, StyleMatrix } from './contract'

/* --------------------------------------------------------------- the inputs */

/**
 * One RM-Bench record as one of the three style files recorded it.
 *
 * `key` is the dataset's own `id` (`"chat/100"`), which is what aligns the three
 * files — the official script zips them positionally and asserts the ids match,
 * and in the released logs they do. Aligning on the id rather than on position
 * means a re-ordered or partial file degrades into counted misses instead of a
 * silently wrong matrix.
 */
export interface StyleRunRecord {
  key: string
  /** Raw `domain`, one of the five values the logs carry; folded here, not by the caller. */
  domain: string
  /** `result` per style slot: 1 correct, 0 wrong, null when nothing was recorded. */
  results: (number | null)[]
}

/**
 * The four domains the official script reports, in its order. The logs carry
 * five values — `safety-refuse` and `safety-response` are both matched by the
 * script's `startswith("safety")` and reported as one.
 */
export const RM_BENCH_DOMAINS = ['chat', 'math', 'code', 'safety'] as const

export type RmBenchDomain = (typeof RM_BENCH_DOMAINS)[number]

/** The `startswith` fold. `null` for a domain the official script would drop. */
export function foldDomain(raw: string): RmBenchDomain | null {
  return RM_BENCH_DOMAINS.find((domain) => raw.startsWith(domain)) ?? null
}

/* ------------------------------------------------------------ the cell table */

const SIZE = 3

/**
 * Which file and which style slot supplies each cell, transcribed from
 * `process_final_result.py`:
 *
 *   [0,0]=res1[0]  [0,1]=res2[0]  [0,2]=res3[0]
 *   [1,0]=res3[1]  [1,1]=res1[1]  [1,2]=res2[1]
 *   [2,0]=res2[2]  [2,1]=res3[2]  [2,2]=res1[2]
 *
 * The slot is always the row and the file is `(col - row) mod 3`, but this is
 * written out rather than derived so it can be read straight against the script.
 */
const CELL_SOURCE: readonly (readonly { file: number; slot: number }[])[] = [
  [
    { file: 0, slot: 0 },
    { file: 1, slot: 0 },
    { file: 2, slot: 0 },
  ],
  [
    { file: 2, slot: 1 },
    { file: 0, slot: 1 },
    { file: 1, slot: 1 },
  ],
  [
    { file: 1, slot: 2 },
    { file: 2, slot: 2 },
    { file: 0, slot: 2 },
  ],
]

/** `total_dataset_{1,2,3}` used as the matrix assembly assumes. */
export const CORRECTED_FILE_ORDER: readonly number[] = [0, 1, 2]

/**
 * What the shipped script loads: `data2` is opened from `output_path3`, so the
 * middle file is file 3. The three cells that read `res2` then duplicate the
 * three that read `res3` — [0,1]=[0,2], [1,2]=[1,0], [2,0]=[2,1].
 */
export const SHIPPED_FILE_ORDER: readonly number[] = [0, 2, 2]

/* -------------------------------------------------------------- alignment */

/** One record with all three files' verdicts in hand, ready to be assembled. */
export interface AlignedRecord {
  key: string
  domain: RmBenchDomain
  /** `[file][slot]`, all nine values present and numeric. */
  results: number[][]
}

export interface StyleRunAlignment {
  records: AlignedRecord[]
  /** Keys in the first file that the second or third file does not carry. */
  unmatched: number
  /** Keys present everywhere but missing at least one of the nine results. */
  incomplete: number
  /** Records whose `domain` matched none of the four prefixes; the script drops these too. */
  unknownDomain: number
}

/**
 * Line the three style files up by dataset id.
 *
 * Exported separately from `buildRmBenchSummary` because the three counters are
 * the honest part: a matrix built from 1200 of 1327 records is a different claim
 * from one built from all of them, and only the caller can say so in the UI.
 */
export function alignStyleRuns(runs: readonly (readonly StyleRunRecord[])[]): StyleRunAlignment {
  if (runs.length !== SIZE) {
    throw new Error(`RM-Bench needs all three style files; got ${runs.length}`)
  }
  const [first, ...rest] = runs
  const byKey = rest.map((run) => new Map(run.map((record) => [record.key, record])))

  const alignment: StyleRunAlignment = { records: [], unmatched: 0, incomplete: 0, unknownDomain: 0 }
  for (const record of first) {
    const others = byKey.map((index) => index.get(record.key))
    if (others.some((other) => other === undefined)) {
      alignment.unmatched += 1
      continue
    }
    const domain = foldDomain(record.domain)
    if (domain === null) {
      alignment.unknownDomain += 1
      continue
    }
    const results = [record, ...(others as StyleRunRecord[])].map((one) => one.results)
    if (results.some((slots) => slots.length < SIZE || slots.some((slot) => typeof slot !== 'number'))) {
      alignment.incomplete += 1
      continue
    }
    alignment.records.push({ key: record.key, domain, results: results as number[][] })
  }
  return alignment
}

/* -------------------------------------------------------------- the summary */

export interface RmBenchOptions {
  /** A dropped `final_result.json` / `final_score.json`, already read. */
  official?: Record<string, number>
}

/**
 * The corrected summary, with the shipped script's version attached as
 * `reproducedOfficial`.
 *
 * Throws when fewer than three files are supplied, or when nothing aligned —
 * a zeroed matrix would look like a model that answers nothing right.
 */
export function buildRmBenchSummary(
  runs: readonly (readonly StyleRunRecord[])[],
  options: RmBenchOptions = {},
): RmBenchSummary {
  const alignment = alignStyleRuns(runs)
  if (alignment.records.length === 0) {
    throw new Error('no RM-Bench records aligned across the three style files')
  }
  const summary = summarise(alignment.records, CORRECTED_FILE_ORDER)
  summary.reproducedOfficial = summarise(alignment.records, SHIPPED_FILE_ORDER)
  if (options.official) summary.official = options.official
  return summary
}

function summarise(records: readonly AlignedRecord[], order: readonly number[]): RmBenchSummary {
  const domains: DomainScores[] = []
  for (const domain of RM_BENCH_DOMAINS) {
    const subset = records.filter((record) => record.domain === domain)
    // numpy would emit NaN here; all four domains are populated in real RM-Bench,
    // so dropping an empty one can only affect a truncated demo slice.
    if (subset.length === 0) continue
    const cells = zeros()
    for (const record of subset) {
      for (let row = 0; row < SIZE; row++) {
        for (let col = 0; col < SIZE; col++) {
          const source = CELL_SOURCE[row][col]
          cells[row][col] += record.results[order[source.file]][source.slot]
        }
      }
    }
    for (let row = 0; row < SIZE; row++) {
      for (let col = 0; col < SIZE; col++) cells[row][col] /= subset.length
    }
    const matrix = matrixOf(cells)
    domains.push({
      domain,
      matrix,
      // `np.mean(list(domain_results[domain].values()))` — the three corner
      // accuracies, not the nine cells. Same number, and this is the script's.
      average: mean([matrix.hard, matrix.normal, matrix.easy]),
    })
  }

  const cells = zeros()
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      cells[row][col] = mean(domains.map((one) => one.matrix.cells[row][col]))
    }
  }
  return {
    domains,
    overall: {
      cells,
      // Averaged over domains, not over records: an unbalanced domain does not
      // get a bigger vote. This is what the script's `hard_acc` etc. are.
      hard: mean(domains.map((one) => one.matrix.hard)),
      normal: mean(domains.map((one) => one.matrix.normal)),
      easy: mean(domains.map((one) => one.matrix.easy)),
    },
    totalAverage: mean(domains.map((one) => one.average)),
  }
}

function matrixOf(cells: number[][]): StyleMatrix {
  return {
    cells,
    /** Upper triangle: the better answer is the plainer one. */
    hard: mean([cells[0][1], cells[0][2], cells[1][2]]),
    normal: mean([cells[0][0], cells[1][1], cells[2][2]]),
    /** Lower triangle: the better answer is also the prettier one. */
    easy: mean([cells[1][0], cells[2][0], cells[2][1]]),
  }
}

function zeros(): number[][] {
  return Array.from({ length: SIZE }, () => new Array<number>(SIZE).fill(0))
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

/* ---------------------------------------------------- talking to the script */

/** The eight keys `final_result.json` carries, in its order. */
export const FINAL_RESULT_KEYS = [
  'chat',
  'math',
  'code',
  'safety',
  'hard_acc',
  'normal_acc',
  'easy_acc',
  'total_avg_acc',
] as const

/** A summary flattened into exactly what the script writes, so the two compare. */
export function metricsOf(summary: RmBenchSummary): Record<string, number> {
  const metrics: Record<string, number> = {}
  for (const one of summary.domains) metrics[one.domain] = one.average
  metrics.hard_acc = summary.overall.hard
  metrics.normal_acc = summary.overall.normal
  metrics.easy_acc = summary.overall.easy
  metrics.total_avg_acc = summary.totalAverage
  return metrics
}

/**
 * Read a dropped `final_result.json`. The same object is also written as
 * `final_score.json`, so either file name reaches this.
 *
 * `undefined` rather than a throw when it is not that file: score files get
 * dragged in alongside logs by accident, and that is not an error.
 */
export function readOfficialFinalResult(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  const required = ['hard_acc', 'normal_acc', 'easy_acc', 'total_avg_acc']
  if (!required.every((key) => Number.isFinite(fields[key]))) return undefined
  const metrics: Record<string, number> = {}
  for (const key of FINAL_RESULT_KEYS) {
    if (Number.isFinite(fields[key])) metrics[key] = fields[key] as number
  }
  return metrics
}

export interface MetricRow {
  metric: string
  /** Recomputed with `total_dataset_2` used. */
  corrected: number
  /** The same code run the way the script runs it. */
  reproduced?: number
  /** What the released `final_result.json` says, when one was dropped in. */
  official?: number
}

/**
 * One row per metric for the view: what we get, what the script's own procedure
 * gets, and what was published. A view showing only `corrected` is asking to be
 * taken on trust; `reproduced === official` is the evidence.
 */
export function metricRows(summary: RmBenchSummary): MetricRow[] {
  const corrected = metricsOf(summary)
  const reproduced = summary.reproducedOfficial ? metricsOf(summary.reproducedOfficial) : undefined
  return FINAL_RESULT_KEYS.filter((metric) => metric in corrected).map((metric) => ({
    metric,
    corrected: corrected[metric],
    reproduced: reproduced?.[metric],
    official: summary.official?.[metric],
  }))
}

/* --------------------------------------------------------------- the readers */

/**
 * Read one style file's raw records. Records that are not RM-Bench rows are
 * skipped rather than guessed at.
 */
export function readStyleRun(values: readonly unknown[]): StyleRunRecord[] {
  const run: StyleRunRecord[] = []
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const fields = value as Record<string, unknown>
    // `id` is a string ("chat/100"), not the int the reading guide claims.
    if (typeof fields.id !== 'string' || typeof fields.domain !== 'string') continue
    if (!Array.isArray(fields.result)) continue
    run.push({
      key: fields.id,
      domain: fields.domain,
      results: fields.result.map(toResult),
    })
  }
  return run
}

function toResult(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return null
}

/**
 * Fold the `Judgement`s one style file produced back into per-record triples.
 *
 * `keyOf` is required and has no default: a `Judgement` carries the shell's
 * `<file>:<index>` id, not RM-Bench's `"chat/100"`, and only the code that minted
 * those ids knows how to get back to the dataset key. Guessing here would align
 * three files on a convention this module cannot see.
 */
export function styleRunFromJudgements(
  judgements: readonly Judgement[],
  keyOf: (judgement: Judgement) => string,
): StyleRunRecord[] {
  const byKey = new Map<string, StyleRunRecord>()
  for (const judgement of judgements) {
    const slot = judgement.styleIndex
    if (slot === undefined || slot < 0 || slot >= SIZE) continue
    const key = keyOf(judgement)
    let record = byKey.get(key)
    if (!record) {
      record = { key, domain: judgement.group, results: new Array<number | null>(SIZE).fill(null) }
      byKey.set(key, record)
    }
    record.results[slot] = judgement.correct === null ? null : judgement.correct ? 1 : 0
  }
  return [...byKey.values()]
}
