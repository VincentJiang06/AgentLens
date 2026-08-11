/**
 * The pure half of the RM-R1 adapter: fingerprint, normalise, recompute.
 *
 * RM-R1's harness emits four log families that agree about almost nothing —
 * one judgement per record or three, `id` an int or a string, the prompt present
 * or absent — plus five score files that are summaries rather than judgements.
 * Everything here turns that into `contract.ts`, so no view branches on which
 * file a record came from.
 *
 * No React and no DOM, so every rule below is exercised from plain node by
 * `model.test.ts`, including against the released 32B logs.
 */

import type { Confidence, ParsedFile } from '../../types'
// Type-only: `Str` is the shell's bilingual literal, and nothing in that module
// runs here — `model.ts` is exercised from plain node with no DOM.
import type { Str } from '../../shell/lang'
import type {
  Benchmark,
  CoverageEntry,
  Excluded,
  HandPicked,
  Judgement,
  LoadedRun,
  Message,
  OfficialScores,
  OutcomeAgreement,
  OutcomeRecord,
  OutcomeSet,
  OutcomeTally,
  RmBenchSummary,
  RmR1Model,
  RunOfficialScores,
  Sampling,
  Truncated,
  Withheld,
} from './contract'
// `.ts` on purpose: `node --test` runs these files unbundled, and node needs the
// real extension. `allowImportingTsExtensions` lets Vite and tsc agree with it.
import { parseCor } from './cor.ts'
// The 3x3 recompute lives in metrics.ts, and is called from here rather than
// reimplemented: it is the one number the outreach turns on, and two copies of
// it that must agree forever is exactly the wrong place to save an import.
import { alignStyleRuns, buildRmBenchSummary, readStyleRun } from './metrics.ts'
import type { StyleRunRecord } from './metrics.ts'

/* --------------------------------------------------------------- record ids */

/**
 * `<file>:<index>`, and `<file>:<index>:<styleIndex>` for RM-Bench, whose one
 * record is three judgements. Never `<file>#<index>`: a browser eats a `#` as a
 * fragment before the query is read, so the emailed link silently opens the
 * wrong record.
 */
export function judgementId(fileName: string, index: number, styleIndex?: number): string {
  return styleIndex === undefined ? `${fileName}:${index}` : `${fileName}:${index}:${styleIndex}`
}

/* --------------------------------------------------------------- vocabulary */

/** RM-Bench's three response styles, in the order the harness writes them. */
export const RM_BENCH_STYLES = ['concise', 'detailed', 'detailed + markdown'] as const

/**
 * Never read into the model. The released score files put an internal
 * training-run name in `model` — it identifies a checkpoint and its data recipe,
 * and it is not ours to redistribute. `model.test.ts` asserts it cannot reach
 * the model even when the file is dropped whole.
 */
export const DROPPED_SCORE_FIELDS = ['model', 'model_type', 'chat_template'] as const

/** `total_dataset_2_<model>.json` → the pairing offset that file was run at. */
const RM_BENCH_STYLE_FILE = /(dataset[_-]?)([123])(?![0-9])/i

/* -------------------------------------------------------------- fingerprint */

type Family = Benchmark | 'scores' | 'bundle'

/** A judgement log is unmistakable; a score file is a summary of one. */
const LOG_CONFIDENCE = 0.95
/**
 * Below `CONFIDENCE_FLOOR` on purpose. A drop of nothing but score files has no
 * judgements in it, so this adapter has nothing to show, and the shell's raw
 * record browser is the better answer. Mixed with logs the mean still clears
 * the floor — the whole 19-file result directory scores about 0.69.
 */
const SCORE_CONFIDENCE = 0.4

export function sniff(_fileName: string, firstRecords: unknown[]): Confidence {
  if (firstRecords.length === 0) return 0
  let total = 0
  for (const record of firstRecords) {
    const family = familyOf(record)
    if (family === 'bundle') return 1
    if (family === 'scores') total += SCORE_CONFIDENCE
    else if (family !== null) total += LOG_CONFIDENCE
  }
  return total / firstRecords.length
}

function familyOf(value: unknown): Family | null {
  const fields = asObject(value)
  if (!fields) return null

  if (typeof fields.agentlens_format === 'string' && (Array.isArray(fields.files) || Array.isArray(fields.runs))) {
    return 'bundle'
  }

  const shuffled = fields.Is_Chosen_Answer_Shuffled_toPositionB
  const hasAnswers = typeof fields.answers === 'string'
  const hasPair = Array.isArray(fields.text_chosen) && Array.isArray(fields.text_rejected)

  if (hasPair && hasAnswers && shuffled !== undefined) {
    // All three of these share RewardBench's shape; RMB adds its own id fields.
    if (fields.bon_uid !== undefined) return 'rmb-bon'
    if (fields.pair_uid !== undefined) return 'rmb-pairwise'
    if (typeof fields.subset === 'string') return 'rewardbench'
  }

  if (
    typeof fields.domain === 'string' &&
    isTriple(fields.chosen) &&
    isTriple(fields.rejected) &&
    isTriple(fields.output) &&
    isTriple(fields.result)
  ) {
    return 'rm-bench'
  }

  return isScoreFile(fields) ? 'scores' : null
}

const MAIN_SCORE_KEYS = ['Chat', 'Chat Hard', 'Safety', 'Reasoning']
const RM_BENCH_SCORE_KEYS = ['hard_acc', 'normal_acc', 'easy_acc', 'total_avg_acc']

function isScoreFile(fields: Record<string, unknown>): boolean {
  if (MAIN_SCORE_KEYS.every((key) => typeof fields[key] === 'number')) return true
  if (RM_BENCH_SCORE_KEYS.every((key) => typeof fields[key] === 'number')) return true
  // each_small_section_score.json: named by its two non-score fields, since its
  // 23 subset keys are the only other thing in it and we do not hardcode those.
  if ('model_type' in fields && 'chat_template' in fields) return true
  // RMB Final_score.json / META_RESULT.json: an object of nothing but accuracies.
  if (typeof fields.Overall_accuracy === 'number') return true
  const entries = Object.entries(fields)
  return (
    entries.length >= 4 &&
    entries.every(([key, value]) => typeof value === 'number' && (key.includes('_set/') || key.includes(' ')))
  )
}

function isTriple(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3
}

/* -------------------------------------------------------------------- parse */

/**
 * A file as this adapter sees it: the shell's `ParsedFile`, plus a label that is
 * unique within the drop. Three different files in one result directory are all
 * called `logs.json`, and ids minted from a bare file name would collide across
 * RewardBench and both RMB pairwise sets — one dead deep link per collision.
 */
interface Source {
  label: string
  /**
   * The run this file belongs to, as the package declares it, or `''` when
   * nothing said. Everything keyed by run — scores, outcome tables, coverage —
   * is keyed by this, so a two-run package can never merge them.
   */
  run: string
  records: { index: number; value: unknown }[]
}

/**
 * Every record's id, group and outcome, with none of its text — what a demo
 * package ships alongside its sample so that a recomputed benchmark number is
 * the benchmark's and not the sample's. Never produced from a dropped log: a
 * dropped log has the records themselves.
 */
interface OutcomeTable {
  run: string
  benchmark: string
  /** The packer's claim that this is every record in the source file. */
  complete: boolean
  columns: string[]
  rows: unknown[][]
}

/** A score file's numbers, plus where the packer says they came from. */
interface ScoreRecord {
  fields: Record<string, unknown>
  run: string
  /** Absent for a dropped file, where the shape is all there is to go on. */
  sourcePath?: string
  /** What to cite on screen: the packed path's base name, or the dropped file's. */
  label: string
}

interface Expanded {
  sources: Source[]
  tables: OutcomeTable[]
  scores: ScoreRecord[]
  /** The first package's own sampling disclosure; see `readBundle`. */
  sampling?: Sampling
  coverage: CoverageEntry[]
}

export function parse(files: ParsedFile[]): RmR1Model {
  const notes: Str[] = []
  const expanded = expand(files, notes)
  const sources = label(expanded.sources, notes)

  const judgements: Judgement[] = []
  const benchmarks: Benchmark[] = []
  const runCounts = new Map<string, LoadedRun>()
  const styleFiles = new Map<string, StyleFile[]>()
  /** Which run and benchmark each loaded file's judgements belong to. */
  const loadedFiles: LoadedFile[] = []
  const scoreRecords: ScoreRecord[] = [...expanded.scores]
  let skipped = 0

  for (const source of sources) {
    let styleFile: StyleFile | undefined
    let styleFileTried = false
    for (const record of source.records) {
      const family = familyOf(record.value)
      const fields = asObject(record.value)
      if (family === null || fields === null) {
        skipped += 1
        continue
      }
      if (family === 'scores') {
        scoreRecords.push({ fields, run: source.run, label: source.label })
        continue
      }
      if (family === 'bundle') {
        skipped += 1 // already expanded above; the envelope itself is not a record
        continue
      }

      const made =
        family === 'rm-bench'
          ? fromRmBench(source.label, record.index, fields)
          : [fromPairwise(family, source.label, record.index, fields)]
      for (const judgement of made) judgements.push(judgement)

      if (!benchmarks.includes(family)) benchmarks.push(family)
      if (!loadedFiles.some((one) => one.label === source.label && one.benchmark === family)) {
        loadedFiles.push({ label: source.label, run: source.run, benchmark: family })
      }
      // A run, not a file: several files of one declared run are one run, and a
      // file that declares none is its own run because nothing says otherwise.
      const fileKey = family === 'rm-bench' ? rmBenchRunKey(source.label) : source.label
      const runKey = `${source.run === '' ? fileKey : source.run} :: ${family}`
      const run = runCounts.get(runKey) ?? {
        run: source.run,
        benchmark: family,
        files: [],
        fileName: fileKey,
        count: 0,
      }
      if (!run.files.includes(source.label)) run.files.push(source.label)
      run.count += made.length
      runCounts.set(runKey, run)

      if (family === 'rm-bench') {
        if (!styleFileTried) {
          styleFileTried = true
          styleFile = startStyleFile(source.label, source.run, styleFiles)
          if (!styleFile) {
            notes.push({
              en:
                `${source.label} holds RM-Bench judgements, but its name does not say which of total_dataset_1/2/3 it is, ` +
                'so it cannot be placed in the 3x3 style matrix.',
              zh:
                `${source.label} 里是 RM-Bench 判例，但文件名没有说明它是 total_dataset_1/2/3 里的哪一个，` +
                '所以它进不了 3x3 风格矩阵。',
            })
          }
        }
        if (styleFile) styleFile.values.push(record.value)
      }
    }
  }

  const scores = readScores(scoreRecords, notes)
  const rmBench = buildRmBench(
    [...packedStyleRuns(expanded.tables), ...droppedStyleRuns(styleFiles)],
    scores.rmBenchOfficialFor,
    notes,
  )

  noteSalvage(files, notes)
  noteRmBenchGaps(styleFiles, scores.anyRmBenchOfficial, rmBench, notes)
  noteDuplicates(sources, notes)
  if (skipped > 0) {
    notes.push({
      en: `${skipped} record${skipped === 1 ? '' : 's'} matched no RM-R1 log format and were not shown.`,
      zh: `有 ${skipped} 条记录不符合任何一种 RM-R1 日志格式，没有显示出来。`,
    })
  }
  if (judgements.some((one) => one.benchmark === 'rm-bench')) {
    notes.push({
      en:
        'RM-Bench `domain` has five values in the logs (chat, code, math, safety-refuse, safety-response). ' +
        'Each judgement keeps its own; the recomputed matrix folds the two safety domains into `safety`, which is what the official scorer does.',
      zh:
        'RM-Bench 的 `domain` 在日志里有五个取值（chat、code、math、safety-refuse、safety-response）。' +
        '每条判例保留自己的那个；重算的矩阵把两个 safety 合成 `safety`，官方脚本也是这么合的。',
    })
  }

  const runs = comparableRuns([...runCounts.values()])
  const outcomes = buildOutcomes(expanded.tables, loadedFiles)

  // Coverage leads. Every panel that recomputes an accuracy recomputes it over
  // the judgements loaded, and on a sampled package that is not the benchmark —
  // so the sentence saying so has to be the first one read, not the thirteenth.
  const coverage: Str[] = []
  noteCoverage(outcomes, judgements, coverage)

  return {
    judgements,
    benchmarks,
    groups: groupsOf(judgements, benchmarks),
    rmBench,
    officialScores: scores.byRun,
    outcomes,
    runs,
    sampling: expanded.sampling,
    coverage: expanded.coverage,
    notes: distinct([...coverage, ...notes]),
  }
}

/**
 * The runs a comparison could be made from: those of a benchmark that has two.
 *
 * A run is a checkpoint's evaluation, not a file. One run writes RM-Bench into
 * three `total_dataset_N` files, RMB into a directory per set, and RewardBench
 * into a fourth — offering those as Run 1 and Run 2 compares a run with itself,
 * which is the reading this array exists to make impossible. So a benchmark with
 * one run contributes nothing, and a drop with no benchmark loaded twice is
 * empty.
 */
function comparableRuns(runs: LoadedRun[]): LoadedRun[] {
  const perBenchmark = new Map<Benchmark, number>()
  for (const run of runs) perBenchmark.set(run.benchmark, (perBenchmark.get(run.benchmark) ?? 0) + 1)
  return runs.filter((run) => (perBenchmark.get(run.benchmark) ?? 0) > 1)
}

/* ------------------------------------------------------- outcomes, per run */

/** One loaded log file, and which run packed it. */
interface LoadedFile {
  label: string
  run: string
  benchmark: Benchmark
}

const BENCHMARKS: readonly Benchmark[] = ['rewardbench', 'rm-bench', 'rmb-pairwise', 'rmb-bon']

/**
 * The complete outcome tables, turned into something a view can compute a
 * benchmark-named number from.
 *
 * One set per (run, benchmark): the two runs of a compare package each carry
 * their own 2,985 rows, and a tally that pooled them would belong to neither.
 */
function buildOutcomes(tables: OutcomeTable[], loaded: LoadedFile[]): OutcomeSet[] {
  const sets: OutcomeSet[] = []
  for (const table of tables) {
    const benchmark = BENCHMARKS.find((one) => one === table.benchmark)
    if (benchmark === undefined) continue
    const records = outcomeRecords(table)
    if (records.length === 0) continue

    const groups: OutcomeTally[] = []
    const byGroup = new Map<string, OutcomeTally>()
    let correct = 0
    let unrecorded = 0
    for (const record of records) {
      let tally = byGroup.get(record.group)
      if (!tally) {
        tally = { group: record.group, total: 0, correct: 0, unrecorded: 0 }
        byGroup.set(record.group, tally)
        groups.push(tally)
      }
      tally.total += 1
      if (record.correct === true) {
        tally.correct += 1
        correct += 1
      } else if (record.correct === null) {
        tally.unrecorded += 1
        unrecorded += 1
      }
    }

    sets.push({
      run: table.run,
      benchmark,
      complete: table.complete,
      files: loaded.filter((one) => one.run === table.run && one.benchmark === benchmark).map((one) => one.label),
      total: records.length,
      correct,
      unrecorded,
      groups,
      records,
    })
  }
  return sets
}

/**
 * A table's rows as outcomes. Two column shapes exist, and both are read here
 * rather than by two callers: `results` (one outcome per record) and
 * `result_1`/`result_2`/`result_3` (RM-Bench, three files x three slots).
 */
function outcomeRecords(table: OutcomeTable): OutcomeRecord[] {
  const id = table.columns.indexOf('id')
  const group = ['subset', 'domain', 'category_path'].map((name) => table.columns.indexOf(name)).find((at) => at >= 0)
  if (id < 0 || group === undefined) return []
  // `source_index` is the row's place in the benchmark's own file, which is what
  // makes two runs' tables line up; `id` repeats in the released RewardBench set.
  const index = table.columns.indexOf('source_index')
  /** `-1` for a record with one outcome; otherwise the `:<file>:<slot>` pairing. */
  const suffix = (at: number): string => (at < 0 ? '' : `:${Math.floor(at / 3) + 1}:${at % 3}`)
  const keyOf = (row: unknown[], at: number): string => (index >= 0 ? String(row[index]) : String(row[id])) + suffix(at)

  const single = table.columns.indexOf('results')
  if (single >= 0) {
    return table.rows.map((row) => ({
      key: keyOf(row, -1),
      id: String(row[id]),
      group: String(row[group]),
      correct: correctness(row[single]),
    }))
  }

  const styleColumns = [1, 2, 3].map((file) => table.columns.indexOf(`result_${file}`))
  if (styleColumns.some((at) => at < 0)) return []
  const records: OutcomeRecord[] = []
  for (const row of table.rows) {
    for (let file = 0; file < 3; file += 1) {
      const slots = row[styleColumns[file]]
      if (!Array.isArray(slots)) continue
      for (let slot = 0; slot < 3; slot += 1) {
        records.push({
          key: keyOf(row, file * 3 + slot),
          id: String(row[id]),
          group: String(row[group]),
          correct: correctness(slots[slot]),
        })
      }
    }
  }
  return records
}

/* -------------------------------------------------------- outcome accessors */

/**
 * A judgement id's file label back to the run that packed it.
 *
 * The inverse of the `${run_id}/` prefix `readBundle` mints, and exported so a
 * view never has to re-derive the convention: `RM-R1-…-32B/logs.json` is that
 * checkpoint's, and a bare `logs.json` is its own run as loaded.
 */
export function runIdOf(fileLabel: string): string {
  const at = fileLabel.indexOf('/')
  return at > 0 ? fileLabel.slice(0, at) : fileLabel
}

/** True when `run` names this set — its declared run id, or one of its files. */
function names(set: OutcomeSet, run: string): boolean {
  if (set.run !== '' && (run === set.run || runIdOf(run) === set.run)) return true
  return set.files.some((file) => file === run || runIdOf(file) === run)
}

/**
 * The complete outcome sets for one benchmark, one per run, in load order.
 *
 * A view that wants to put a benchmark's name on a number reads it from here.
 * `run` accepts either the declared run id or one of the run's file labels, so
 * a caller holding judgement ids and one holding the package's own names ask
 * the same question. `complete` is not filtered on: a caller that would say
 * "the benchmark's" has to check it, and one that only wants a denominator does
 * not.
 */
export function outcomesFor(model: RmR1Model, benchmark: Benchmark, run?: string): OutcomeSet[] {
  return model.outcomes.filter((set) => set.benchmark === benchmark && (run === undefined || names(set, run)))
}

/** The outcome set a file of judgements is a sample of, if the package carried one. */
export function outcomesOfFile(model: RmR1Model, fileLabel: string): OutcomeSet | undefined {
  return model.outcomes.find((set) => set.files.includes(fileLabel))
}

/**
 * The published scores a run may be shown beside — or `undefined`, which a view
 * must render as nothing rather than as somebody else's number.
 *
 * A package names the run each score file came from, and that is used. A score
 * file dropped loose names nobody, so it is attributed only when a single run
 * is loaded and there is a single such file; anything else is unattributable by
 * construction and stays off the screen.
 */
export function officialScoresFor(model: RmR1Model, run: string): RunOfficialScores | undefined {
  const named = model.officialScores.find(
    (one) => one.run !== '' && (one.run === run || one.run === runIdOf(run)),
  )
  if (named) return named
  // A single-run package leaves its file labels unprefixed, so `logs.json` and
  // the run id it was packed under only meet in the outcome table.
  const table = model.outcomes.find((set) => set.run !== '' && names(set, run))
  const throughTable = table && model.officialScores.find((one) => one.run === table.run)
  if (throughTable) return throughTable

  if (model.officialScores.length !== 1) return undefined
  const loose = model.officialScores[0]
  // Ambiguity is per benchmark: a result directory holds one RewardBench log and
  // three RM-Bench ones, and that is one checkpoint, not four. Two files that
  // are both a benchmark's whole log are two, whatever they are called.
  const speaksFor: Benchmark[] = []
  if (loose.scores.sections !== undefined || loose.scores.perSubset !== undefined) speaksFor.push('rewardbench')
  if (loose.scores.rmBench !== undefined) speaksFor.push('rm-bench')
  return speaksFor.some((benchmark) => runsOf(model, benchmark) > 1) ? undefined : loose
}

/** How many separate runs of one benchmark are loaded, by file. */
function runsOf(model: RmR1Model, benchmark: Benchmark): number {
  const files = new Set<string>()
  for (const one of model.judgements) {
    if (one.benchmark !== benchmark) continue
    const file = one.id.slice(0, one.id.indexOf(':'))
    files.add(benchmark === 'rm-bench' ? rmBenchRunKey(file) : file)
  }
  return files.size
}

/**
 * Two runs' outcomes over every record both scored.
 *
 * Records missing from either side are counted, never dropped quietly: a
 * 2,985-row agreement and a 40-row one are different claims and the caller has
 * to be able to tell them apart.
 */
export function agreeOutcomes(one: OutcomeSet, two: OutcomeSet): OutcomeAgreement {
  const index = new Map<string, OutcomeRecord>()
  for (const record of two.records) if (!index.has(record.key)) index.set(record.key, record)

  const agreement: OutcomeAgreement = {
    aligned: 0,
    counts: { 'both-right': 0, 'run1-only': 0, 'run2-only': 0, 'both-wrong': 0, indeterminate: 0 },
    onlyInRun1: 0,
    onlyInRun2: 0,
    determinate: 0,
    oneRight: 0,
    twoRight: 0,
  }
  const matched = new Set<string>()
  for (const left of one.records) {
    const right = index.get(left.key)
    if (right === undefined || matched.has(left.key)) continue
    matched.add(left.key)
    agreement.aligned += 1
    if (left.correct === null || right.correct === null) {
      agreement.counts.indeterminate += 1
      continue
    }
    agreement.determinate += 1
    if (left.correct) agreement.oneRight += 1
    if (right.correct) agreement.twoRight += 1
    if (left.correct && right.correct) agreement.counts['both-right'] += 1
    else if (left.correct) agreement.counts['run1-only'] += 1
    else if (right.correct) agreement.counts['run2-only'] += 1
    else agreement.counts['both-wrong'] += 1
  }
  // Anything that did not pair is reported, whether it was absent from the other
  // run or a repeated key that had already been used.
  agreement.onlyInRun1 = one.records.length - agreement.aligned
  agreement.onlyInRun2 = two.records.length - agreement.aligned
  return agreement
}

/**
 * Position of `?record=` in `model.judgements`, or -1. A miss is a value the
 * caller must show: a dead outreach link that looks fine is worse than one that
 * errors.
 *
 * Three forms resolve, because all three get typed by hand into an email: the
 * minted id; a two-part RM-Bench id, which lands on style 0; and a bare index
 * when a single file was loaded.
 */
export function judgementIndexFor(model: RmR1Model, recordId: string | undefined): number {
  if (recordId === undefined || recordId === '') return -1

  const exact = model.judgements.findIndex((one) => one.id === recordId)
  if (exact !== -1) return exact

  // `<file>:<index>` for an RM-Bench record, which is three judgements. Guarded
  // on the shape: without it a bare `logs.json` would "find" `logs.json:0`, and
  // a truncated link that quietly opens record 0 is worse than one that misses.
  const parts = recordId.split(':')
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    const style0 = model.judgements.findIndex((one) => one.id === `${recordId}:0`)
    if (style0 !== -1) return style0
  }

  if (!/^\d+$/.test(recordId)) return -1
  const files = new Set(model.judgements.map((one) => one.id.slice(0, one.id.indexOf(':'))))
  if (files.size !== 1) return -1
  const only = [...files][0]
  return model.judgements.findIndex((one) => one.id === `${only}:${recordId}` || one.id === `${only}:${recordId}:0`)
}

/* ------------------------------------------------------------ normalisation */

function fromPairwise(
  benchmark: Exclude<Benchmark, 'rm-bench'>,
  label: string,
  index: number,
  fields: Record<string, unknown>,
): Judgement {
  const group =
    typeof fields.category_path === 'string' && fields.category_path !== ''
      ? fields.category_path
      : str(fields.subset, 'unknown')
  return {
    id: judgementId(label, index),
    benchmark,
    group,
    // No `prompt`: these logs carry none, and `text_chosen[0]` is the user turn.
    chosen: messages(fields.text_chosen),
    rejected: messages(fields.text_rejected),
    chosenShownAs: shownAs(fields.Is_Chosen_Answer_Shuffled_toPositionB),
    correct: correctness(fields.results),
    cor: parseCor(fields.answers),
  }
}

/**
 * One RM-Bench record is three judgements, one per response style. Its
 * `chosen`/`rejected` are bare strings rather than turns, so the prompt — which
 * this family does carry — is put back as the user turn, and the view renders
 * every family the same way.
 */
function fromRmBench(label: string, index: number, fields: Record<string, unknown>): Judgement[] {
  const prompt = str(fields.prompt, '')
  const chosen = fields.chosen as unknown[]
  const rejected = fields.rejected as unknown[]
  const output = fields.output as unknown[]
  const result = fields.result as unknown[]
  const shuffled = fields.Is_Chosen_Answer_Shuffled_toPositionB

  return RM_BENCH_STYLES.map((_style, styleIndex) => ({
    id: judgementId(label, index, styleIndex),
    benchmark: 'rm-bench' as const,
    group: str(fields.domain, 'unknown'),
    prompt: prompt === '' ? undefined : prompt,
    chosen: turn(prompt, chosen[styleIndex]),
    rejected: turn(prompt, rejected[styleIndex]),
    chosenShownAs: shownAs(Array.isArray(shuffled) ? shuffled[styleIndex] : shuffled),
    correct: correctness(result[styleIndex]),
    cor: parseCor(output[styleIndex]),
    styleIndex,
  }))
}

/**
 * Which slot `chosen` occupied when the judge saw it. The harness shuffles
 * without a seed, and the judge's prose names the shuffled position ("Chatbot
 * A"), so a view that ignores this points every quote at the wrong response.
 */
function shownAs(shuffled: unknown): 'A' | 'B' {
  return shuffled === true ? 'B' : 'A'
}

function correctness(result: unknown): boolean | null {
  if (result === 1 || result === true) return true
  if (result === 0 || result === false) return false
  return null
}

function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const fields = asObject(entry)
    if (!fields) return []
    return [{ role: str(fields.role, 'unknown'), content: str(fields.content, '') }]
  })
}

function turn(prompt: string, response: unknown): Message[] {
  const answer = str(response, '')
  return prompt === '' ? [{ role: 'assistant', content: answer }] : [
    { role: 'user', content: prompt },
    { role: 'assistant', content: answer },
  ]
}

function groupsOf(judgements: Judgement[], benchmarks: Benchmark[]): string[] {
  const groups: string[] = []
  for (const benchmark of benchmarks) {
    const mine = new Set(judgements.filter((one) => one.benchmark === benchmark).map((one) => one.group))
    groups.push(...[...mine].sort())
  }
  return [...new Set(groups)]
}

/* ------------------------------------------------------- RM-Bench recompute */

/** One `total_dataset_N` file: its pairing offset, and its records untouched. */
interface StyleFile {
  label: string
  run: string
  /** 1, 2 or 3 — the pairing offset, read off the file name. */
  style: number
  values: unknown[]
}

function rmBenchRunKey(label: string): string {
  return label.replace(RM_BENCH_STYLE_FILE, '$1{1,2,3}')
}

function startStyleFile(label: string, run: string, into: Map<string, StyleFile[]>): StyleFile | undefined {
  const match = RM_BENCH_STYLE_FILE.exec(label)
  if (!match) return undefined
  const runKey = rmBenchRunKey(label)
  const entry: StyleFile = { label, run, style: Number(match[2]), values: [] }
  into.set(runKey, [...(into.get(runKey) ?? []), entry])
  return entry
}

/**
 * The 3x3 style matrix, recomputed from the raw logs by `metrics.ts`.
 *
 * `eval/RM-Bench/scripts/process_final_result.py` computes `output_path2` and
 * then opens `output_path3` into `data2`, so `total_dataset_2` is dropped and
 * `total_dataset_3` counted twice. `metrics.ts` builds both versions from the
 * same aligned records, which is what makes the difference checkable against the
 * shipped `final_result.json` rather than a matter of trust.
 *
 * Everything this function adds is bookkeeping: which run was scored, and what
 * did not line up.
 */
function buildRmBench(
  candidates: StyleRunCandidate[],
  officialFor: (run: string) => Record<string, number> | undefined,
  notes: Str[],
): RmBenchSummary | undefined {
  for (const { runKey, run, runs, note } of candidates) {
    // The published summary of *this* run or none: a `final_result.json` is one
    // checkpoint's, and a recompute checked against another one's proves nothing.
    const official = officialFor(run)
    const alignment = alignStyleRuns(runs)
    const dropped = alignment.unmatched + alignment.incomplete + alignment.unknownDomain
    if (dropped > 0) {
      notes.push({
        en:
          `${runKey}: ${dropped} record${dropped === 1 ? '' : 's'} are not in the matrix ` +
          `(${alignment.unmatched} missing from a style file, ${alignment.incomplete} missing a verdict, ` +
          `${alignment.unknownDomain} in an unrecognised domain).`,
        zh:
          `${runKey}：有 ${dropped} 条记录不在矩阵里` +
          `（${alignment.unmatched} 条在某个风格文件里没有，${alignment.incomplete} 条缺判定，` +
          `${alignment.unknownDomain} 条的 domain 无法识别）。`,
      })
    }

    let summary: RmBenchSummary
    try {
      summary = buildRmBenchSummary(runs, official ? { official } : {})
    } catch (error) {
      // A zeroed matrix would read as a model that answers nothing right. The
      // message inside the brackets is the failure's own words, so it is quoted
      // rather than translated.
      const reason = error instanceof Error ? error.message : String(error)
      notes.push({
        en: `${runKey}: the 3x3 matrix could not be built (${reason}).`,
        zh: `${runKey}：3x3 矩阵没能建起来（${reason}）。`,
      })
      continue
    }

    if (note !== undefined) notes.push(note)
    // Only a second *dropped* run is another run. A package brings both a packed
    // outcome table and the style files of the sample it drew from, and those
    // two are the same run seen twice.
    if (candidates.filter((one) => one.kind === 'dropped').length > 1) {
      notes.push({
        en: `The RM-Bench matrix is recomputed from ${runKey}; other RM-Bench runs in this drop are listed but not scored.`,
        zh: `RM-Bench 矩阵是用 ${runKey} 重算的；这批数据里其他 RM-Bench 运行只列出来，没有参与计算。`,
      })
    }
    return summary
  }
  return undefined
}

/** One thing the 3x3 matrix could be built from, and how to say what it was. */
interface StyleRunCandidate {
  runKey: string
  /** The run these records belong to, for keying the published summary. */
  run: string
  /** `packed` came from a bundle's complete outcome table, `dropped` from files. */
  kind: 'packed' | 'dropped'
  /** `total_dataset_{1,2,3}` in that order — the corrected assembly's file order. */
  runs: StyleRunRecord[][]
  note?: Str
}

/** Three complete style runs from a packed outcome table, when one is present. */
function packedStyleRuns(tables: OutcomeTable[]): StyleRunCandidate[] {
  const out: StyleRunCandidate[] = []
  for (const table of tables) {
    if (table.benchmark !== 'rm-bench') continue
    const id = table.columns.indexOf('id')
    const domain = table.columns.indexOf('domain')
    const columns = [1, 2, 3].map((file) => table.columns.indexOf(`result_${file}`))
    if (id < 0 || domain < 0 || columns.some((at) => at < 0)) continue
    // Through `readStyleRun` rather than around it: the table is three files'
    // `result` arrays side by side, and it must be read by the same code that
    // reads them out of the files themselves.
    const runs = columns.map((at) =>
      readStyleRun(table.rows.map((row) => ({ id: row[id], domain: row[domain], result: row[at] }))),
    )
    if (runs.some((run) => run.length === 0)) continue
    out.push({
      runKey: 'the packaged outcome table',
      run: table.run,
      kind: 'packed',
      runs,
      note: {
        en:
          `The RM-Bench matrix below is computed from every one of the ${runs[0].length.toLocaleString()} records' ` +
          'outcomes, which this package carries in full — not from the sample of full traces the judgement browser lists.',
        zh:
          `下面这个 RM-Bench 矩阵，算的是全部 ${runs[0].length.toLocaleString()} 条记录的判定结果——` +
          '这份数据包把它们都带上了，不是判例浏览器里列出的那份完整轨迹样本。',
      },
    })
  }
  return out
}

/** Three style runs read out of three dropped `total_dataset_N` files. */
function droppedStyleRuns(styleFiles: Map<string, StyleFile[]>): StyleRunCandidate[] {
  const out: StyleRunCandidate[] = []
  for (const [runKey, entries] of styleFiles) {
    const byStyle = new Map(entries.map((entry) => [entry.style, entry]))
    if (byStyle.size < 3) continue
    out.push({
      runKey,
      run: entries[0].run,
      kind: 'dropped',
      runs: [1, 2, 3].map((style) => readStyleRun((byStyle.get(style) as StyleFile).values)),
    })
  }
  return out
}

/* ---------------------------------------------------------- official scores */

interface ReadScores {
  byRun: RunOfficialScores[]
  /** The RM-Bench summary published by one named run, or undefined if contested. */
  rmBenchOfficialFor: (run: string) => Record<string, number> | undefined
  /** Whether any run published an RM-Bench summary, for the "loaded without logs" note. */
  anyRmBenchOfficial: boolean
}

/** The three things a score file can be. One file fills one of them. */
type ScoreSlot = 'sections' | 'perSubset' | 'rmBench'

const SLOT_NAMES: Record<ScoreSlot, Str> = {
  sections: { en: 'the RewardBench section scores', zh: 'RewardBench 的四个部分分数' },
  perSubset: { en: 'the RewardBench per-subset scores', zh: 'RewardBench 的各子集分数' },
  rmBench: { en: 'the RM-Bench metrics', zh: 'RM-Bench 的几项指标' },
}

interface SlotState {
  value: Record<string, number>
  /** The files that stated it, in load order. */
  from: string[]
  /** Two files stated it differently; it is withheld rather than resolved by order. */
  contested: boolean
}

/**
 * Published scores, grouped by the run that published them.
 *
 * Two rules, and they are the whole function:
 *
 *  1. A score belongs to a run. A package names the run for each file it packs;
 *     a file dropped on its own names nothing, so all such files share the run
 *     `''` and a view can only cite their file names. Nothing is ever merged
 *     across runs — two checkpoints' `main_score.json` have the same keys and
 *     different values, and merging them yields a table that is neither's.
 *  2. Within a run, one file fills one slot. A second file stating the same slot
 *     differently does not win by being last (nor lose by being second): the
 *     slot is withheld and the notes name both files. That replaces two
 *     opposite tie-breaks — `??=` for RM-Bench, `Object.assign` for the two
 *     RewardBench files — with one policy.
 */
function readScores(records: ScoreRecord[], notes: Str[]): ReadScores {
  const groups = new Map<string, { sources: string[]; slots: Map<ScoreSlot, SlotState> }>()
  let dropped = false

  for (const { fields, sourcePath, run, label } of records) {
    // A packed score file has already had `model`/`model_type`/`chat_template`
    // removed, which is exactly what the shape test below keys on — so when the
    // packer said where a file came from, that is what routes it.
    const from = sourcePath === undefined ? undefined : baseName(sourcePath)
    const slot = slotOf(fields, from)
    if (slot === null) {
      // RMB score files: recognised so they do not count as unreadable records,
      // but `OfficialScores` has nowhere to put them and inventing one would be
      // a number on screen that nothing in the model backs.
      notes.push({
        en: 'An RMB score file was loaded; this adapter reads RMB judgements but not RMB summary scores.',
        zh: '载入了一个 RMB 分数文件；这个适配器读 RMB 的判例，但不读 RMB 的汇总分数。',
      })
      continue
    }
    if (slot === 'perSubset') dropped ||= DROPPED_SCORE_FIELDS.some((key) => key in fields)

    const cite = from ?? label
    let group = groups.get(run)
    if (!group) {
      group = { sources: [], slots: new Map() }
      groups.set(run, group)
    }
    if (!group.sources.includes(cite)) group.sources.push(cite)

    // `absoluate_Result` is their spelling. It is read, never corrected.
    const value = numbersOf(fields)
    const held = group.slots.get(slot)
    if (!held) {
      group.slots.set(slot, { value, from: [cite], contested: false })
      continue
    }
    if (!held.from.includes(cite)) held.from.push(cite)
    if (held.contested || sameNumbers(held.value, value)) continue
    held.contested = true
    notes.push({
      en:
        `${run === '' ? 'Two score files' : `Two of ${run}'s score files`} state ${SLOT_NAMES[slot].en} differently ` +
        `(${held.from.join(' and ')}); neither is shown, because load order is no evidence of which one is this run's` +
        `${run === '' ? ', and nothing here says which run either belongs to' : ''}.`,
      zh:
        `${run === '' ? '有两个分数文件' : `${run} 的两个分数文件`}对${SLOT_NAMES[slot].zh}给出了不同的值` +
        `（${held.from.join('、')}）；两个都不显示，因为载入的先后说明不了哪一个才是这次运行的` +
        `${run === '' ? '，而且这里也没有任何东西说得清它们各自属于哪次运行' : ''}。`,
    })
  }

  if (dropped) {
    // What AgentLens can promise is about what AgentLens does with the field —
    // not about the reader's own screen. This note fires on a file the reader
    // dropped themselves, where the name is already in front of them and the raw
    // record browser will show it on request; promising it is "never displayed"
    // would be false at the moment it is read.
    notes.push({
      en:
        'The RewardBench score file names a checkpoint in `model`. This view does not read that field, or ' +
        '`model_type` and `chat_template`: they are left out of everything AgentLens builds from this file, ' +
        'including anything it packages or publishes. Your copy of the file is untouched.',
      zh:
        '这个 RewardBench 分数文件在 `model` 字段里写了一个 checkpoint 名字。这个视图不读这个字段，也不读 ' +
        '`model_type` 和 `chat_template`：AgentLens 用这个文件做出来的东西都不含它们，打包和发布出去的也不含。' +
        '你手上的这份文件本身不会被改动。',
    })
  }

  const byRun: RunOfficialScores[] = []
  for (const [run, group] of groups) {
    const scores: OfficialScores = {}
    for (const [slot, state] of group.slots) {
      if (!state.contested) scores[slot] = state.value
    }
    if (Object.keys(scores).length === 0) continue
    byRun.push({ run, sources: group.sources, scores })
  }

  return {
    byRun,
    rmBenchOfficialFor: (run) => byRun.find((one) => one.run === run)?.scores.rmBench,
    anyRmBenchOfficial: byRun.some((one) => one.scores.rmBench !== undefined),
  }
}

function slotOf(fields: Record<string, unknown>, from: string | undefined): ScoreSlot | null {
  if (from === 'final_result.json' || RM_BENCH_SCORE_KEYS.every((key) => typeof fields[key] === 'number')) {
    return 'rmBench'
  }
  if (from === 'main_score.json' || MAIN_SCORE_KEYS.every((key) => typeof fields[key] === 'number')) return 'sections'
  if (from === 'each_small_section_score.json' || ('model_type' in fields && 'chat_template' in fields)) {
    return 'perSubset'
  }
  return null
}

function sameNumbers(one: Record<string, number>, two: Record<string, number>): boolean {
  const keys = Object.keys(one)
  return keys.length === Object.keys(two).length && keys.every((key) => Object.is(one[key], two[key]))
}

/** Only finite numbers survive, which is on its own enough to drop the three named fields. */
function numbersOf(fields: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(fields)) {
    if ((DROPPED_SCORE_FIELDS as readonly string[]).includes(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  }
  return out
}

/* -------------------------------------------------------------------- notes */

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

/**
 * A package that carries every record's outcome but only some records' text is
 * two different sample sizes on one screen. Say so, with both numbers, wherever
 * they differ — a reader who has just been shown a subset accuracy over 10
 * records has to be able to tell that from the benchmark's own 100.
 */
function noteCoverage(outcomes: OutcomeSet[], judgements: Judgement[], notes: Str[]): void {
  for (const set of outcomes) {
    if (!set.complete) continue
    // Per run, both sides. The numerator used to be every run's judgements over
    // one run's denominator, which on a two-run package described neither run.
    const records = set.benchmark === 'rm-bench' ? recordCount(set) : set.total
    const inHand = judgements.filter(
      (one) =>
        one.benchmark === set.benchmark &&
        (set.benchmark !== 'rm-bench' || one.styleIndex === 0) &&
        set.files.some((file) => one.id.startsWith(`${file}:`)),
    ).length
    if (inHand >= records) continue
    // Named only when a reader could otherwise mistake two runs' notes for one.
    const others = outcomes.filter((one) => one.benchmark === set.benchmark).length > 1
    const named = others && set.run !== '' ? `${set.run} — ` : ''
    const benchmark = set.benchmark === 'rm-bench' ? 'RM-Bench' : 'RewardBench'
    notes.push({
      en:
        `${named}${benchmark}: this package carries the outcome of all ` +
        `${records.toLocaleString()} records and the full text of ${inHand.toLocaleString()} of them. ` +
        'Anything computed from the judgements listed here is over those ' +
        `${inHand.toLocaleString()}, and the sample over-represents the model's mistakes on purpose.`,
      zh:
        `${named}${benchmark}：这份数据包带了全部 ${records.toLocaleString()} 条记录的判定结果，` +
        `其中 ${inHand.toLocaleString()} 条附了完整文本。凡是从这里列出的判例算出来的数字，都只是这 ` +
        `${inHand.toLocaleString()} 条上的；而且这份样本是刻意多放了模型判错的例子。`,
    })
  }
}

/** RM-Bench's rows are nine outcomes per record; the coverage note counts records. */
function recordCount(set: OutcomeSet): number {
  return new Set(set.records.map((record) => record.key.replace(/:\d+:\d+$/, ''))).size
}

function noteRmBenchGaps(
  styleFiles: Map<string, StyleFile[]>,
  official: boolean,
  built: RmBenchSummary | undefined,
  notes: Str[],
): void {
  for (const [runKey, entries] of styleFiles) {
    const styles = [...new Set(entries.map((entry) => entry.style))].sort()
    if (styles.length >= 3) continue
    notes.push({
      en:
        `${runKey}: only style file${styles.length === 1 ? '' : 's'} ${styles.join(', ')} of 1, 2, 3 ${styles.length === 1 ? 'is' : 'are'} loaded, ` +
        'so there is no 3x3 style matrix — hard/normal/easy need all three pairings.',
      zh:
        `${runKey}：1、2、3 三个风格文件里只载入了 ${styles.join('、')}，` +
        '所以没有 3x3 风格矩阵——hard/normal/easy 要三种配对都在才算得出来。',
    })
  }
  if (official && !built) {
    notes.push({
      en: 'RM-Bench `final_result.json` was loaded without all three style logs, so there is nothing to recompute it against and it is not shown.',
      zh: '载入了 RM-Bench 的 `final_result.json`，但三个风格日志没齐，没有重算的结果可以跟它对照，所以不显示它。',
    })
  }
}

function noteDuplicates(sources: Source[], notes: Str[]): void {
  const bon = sources.filter((source) => /(raw_logs|group_by_same_id)/.test(source.label))
  if (bon.some((s) => s.label.includes('raw_logs')) && bon.some((s) => s.label.includes('group_by_same_id'))) {
    notes.push({
      en: 'RMB BoN `raw_logs.json` and `group_by_same_id_logs.json` hold the same judgements grouped two ways; with both loaded each judgement appears twice.',
      zh: 'RMB BoN 的 `raw_logs.json` 和 `group_by_same_id_logs.json` 是同一批判例的两种分组；两个都载入时，每条判例会出现两次。',
    })
  }
}

/* -------------------------------------------------------- sources & bundles */

/**
 * A demo package is one file, so it carries the other files inside it. Two
 * envelope shapes expand here, both declaring `"agentlens_format": "rm-r1@1"`:
 *
 *   flat  { "files": [ { "fileName", "records": [ … ], "indices": [ … ] }, … ] }
 *   run   { "runs":  [ { "run_id", "logs": [ { "source_path", "records",
 *                        "source_indices" } ], "outcome_tables", "scores" } ] }
 *
 * `scripts/build-demo-data/rm-r1.mjs` writes the second, because a package is a
 * *sample* of the full traces plus the *complete* outcome of every record: the
 * 3x3 RM-Bench matrix is then computed over all 1,327 records rather than over
 * the sample, and nothing on screen has to be qualified with "of the sample".
 *
 * Either way ids stay `<file>:<index>`, so a link built against a dropped
 * `logs.json` and one built against the demo are the same link — provided the
 * packer preserves each record's original index, which is what `indices` /
 * `source_indices` are for.
 */
function expand(files: ParsedFile[], notes: Str[]): Expanded {
  const out: Expanded = { sources: [], tables: [], scores: [], coverage: [] }
  for (const file of files) {
    const bundles = file.records.filter((record) => familyOf(record.value) === 'bundle')
    if (bundles.length === 0) {
      // A dropped file names no run: the file name is a checkpoint's only if the
      // person who exported it made it one, and the parser may not assume that.
      out.sources.push({ label: file.fileName, run: '', records: file.records })
      continue
    }
    for (const bundle of bundles) {
      readBundle(asObject(bundle.value) as Record<string, unknown>, file.fileName, out, notes)
    }
    // Anything alongside the envelope is still the user's data; it goes through
    // the normal path rather than being dropped because a bundle was present.
    const loose = file.records.filter((record) => familyOf(record.value) !== 'bundle')
    if (loose.length > 0) out.sources.push({ label: file.fileName, run: '', records: loose })
  }
  return out
}

function readBundle(
  fields: Record<string, unknown>,
  fallbackLabel: string,
  out: Expanded,
  notes: Str[],
): void {
  for (const entry of asArray(fields.files)) {
    const inner = asObject(entry)
    out.sources.push({
      label: str(inner?.fileName, fallbackLabel),
      // The flat envelope has no run dimension, so its files are as unattributed
      // as dropped ones. That is a property of the format, not a default.
      run: '',
      records: recordsOf(inner?.records, inner?.indices),
    })
  }

  const runs = asArray(fields.runs)
  for (const runValue of runs) {
    const run = asObject(runValue)
    if (!run) continue
    // Two runs of the same benchmark pack two files called `logs.json`. The run
    // id is the released checkpoint's public name (the directory the harness
    // wrote), and prefixing with it is the only way the compare view can say
    // which run a record came from. A single-run package keeps the bare file
    // name, so its links stay identical to a dropped file's.
    const runId = str(run.run_id, '')
    const prefix = runs.length > 1 && runId !== '' ? `${runId}/` : ''

    for (const logValue of asArray(run.logs)) {
      const log = asObject(logValue)
      if (!log) continue
      out.sources.push({
        label: prefix + baseName(str(log.source_path, fallbackLabel)),
        run: runId,
        records: recordsOf(log.records, log.source_indices),
      })
    }

    for (const tableValue of asArray(run.outcome_tables)) {
      const table = asObject(tableValue)
      if (!table) continue
      out.tables.push({
        run: runId,
        benchmark: str(table.benchmark, ''),
        complete: table.complete === true,
        columns: asStrings(table.columns),
        rows: asArray(table.rows).filter((row): row is unknown[] => Array.isArray(row)),
      })
    }

    for (const scoreValue of asArray(run.scores)) {
      const score = asObject(scoreValue)
      const value = asObject(score?.value)
      if (!value) continue
      const sourcePath = str(score?.source_path, '') || undefined
      out.scores.push({
        fields: value,
        run: runId,
        sourcePath,
        label: sourcePath === undefined ? fallbackLabel : baseName(sourcePath),
      })
    }
  }

  // The package's own words, and the reader's evidence for or against it: the
  // sampling rule is the only thing that answers "is this cherry-picked", and a
  // rule that stays in the file answers nobody. Carried structurally, because it
  // arrives in a dropped file and may be any shape.
  const sampling = readSampling(fields.sampling)
  const coverage = readCoverage(fields.coverage)
  if (sampling !== undefined || coverage.length > 0) {
    // One package's disclosure describes one package's sample. Two of them
    // merged would be a rule and a denominator that belong to different files,
    // so the second is named and left out rather than folded in.
    if (out.sampling === undefined && out.coverage.length === 0) {
      out.sampling = sampling
      out.coverage = coverage
    } else {
      notes.push({
        en: `${fallbackLabel} declares a sample of its own; only the first package's sampling rule and denominators are shown, because one package's rule says nothing about another's sample.`,
        zh: `${fallbackLabel} 自己也声明了一份样本；这里只显示第一份数据包的抽样规则和分母，因为一份包的规则说明不了另一份包是怎么抽的。`,
      })
    }
  }

  for (const note of asArray(fields.notes)) {
    const one = phrase(note)
    if (one) notes.push(one)
  }
}

/* ------------------------------------------- the package's own disclosure */

/**
 * `sampling` and `coverage` as the package states them.
 *
 * Everything here is somebody else's claim about their own package, so it is
 * validated field by field and never rewritten: a package that discloses half of
 * it discloses half, and the half it has still reaches the screen. The key names
 * are the builder's snake_case; a camelCase variant is accepted so a package
 * written by hand is not silently ignored.
 *
 * The sentences come through `phrase()` and the identifiers through `text()`,
 * which is the whole difference between the disclosure and the data: a rule, a
 * reason, a basis and a note may arrive as an `{ en, zh }` pair and reach both
 * readerships, while a path, a subset and a record id arrive as they are and are
 * never touched.
 */
function readSampling(value: unknown): Sampling | undefined {
  const fields = asObject(value)
  if (!fields) return undefined

  const sampling: Sampling = {
    deterministic: typeof fields.deterministic === 'boolean' ? fields.deterministic : undefined,
    method: phrase(pick(fields, 'method')),
    // A blank rule is not a rule; it would render as an empty numbered line.
    rules: phrases(pick(fields, 'rules')),
    handPicked: objects(pick(fields, 'hand_picked', 'handPicked')).map(
      (one): HandPicked => ({
        runId: text(pick(one, 'run_id', 'runId')),
        sourcePath: text(pick(one, 'source_path', 'sourcePath')),
        sourceIndex: finite(pick(one, 'source_index', 'sourceIndex')),
        subset: text(pick(one, 'subset', 'group')),
        why: phrase(pick(one, 'why', 'reason')),
        recordId: text(pick(one, 'record_id', 'recordId')),
      }),
    ),
    withheld: objects(pick(fields, 'withheld')).map(
      (one): Withheld => ({
        sourcePath: text(pick(one, 'source_path', 'sourcePath')),
        records: finite(pick(one, 'records')),
        reason: phrase(pick(one, 'reason', 'why')),
      }),
    ),
    excluded: objects(pick(fields, 'excluded')).map(
      (one): Excluded => ({
        sourcePath: text(pick(one, 'source_path', 'sourcePath')),
        reason: phrase(pick(one, 'reason', 'why')),
      }),
    ),
    truncated: objects(pick(fields, 'truncated')).map(
      (one): Truncated => ({
        sourcePath: text(pick(one, 'source_path', 'sourcePath')),
        sourceIndex: finite(pick(one, 'source_index', 'sourceIndex')),
        recordId: text(pick(one, 'record_id', 'recordId')),
        field: text(pick(one, 'field')),
        originalBytes: finite(pick(one, 'original_bytes', 'originalBytes')),
        keptBytes: finite(pick(one, 'kept_bytes', 'keptBytes')),
      }),
    ),
  }

  const empty =
    sampling.method === undefined &&
    sampling.rules.length === 0 &&
    sampling.handPicked.length === 0 &&
    sampling.withheld.length === 0 &&
    sampling.excluded.length === 0 &&
    sampling.truncated.length === 0
  return empty ? undefined : sampling
}

/** An entry that names no figure is a denominator attached to nothing, and is dropped. */
function readCoverage(value: unknown): CoverageEntry[] {
  const out: CoverageEntry[] = []
  for (const one of objects(value)) {
    const figure = phrase(pick(one, 'figure'))
    if (figure === undefined) continue
    out.push({
      figure,
      basis: phrase(pick(one, 'basis')),
      denominator: finite(pick(one, 'denominator', 'n')),
      from: phrase(pick(one, 'from', 'source')),
      note: phrase(pick(one, 'note')),
    })
  }
  return out
}

function pick(fields: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) if (fields[key] !== undefined) return fields[key]
  return undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * One sentence of a package's disclosure, in both languages.
 *
 * Two shapes are accepted on purpose, and the asymmetry is the point:
 *
 *  - `{ en, zh }` — what this repo's builder writes, and what the shell's `Str`
 *    demands of AgentLens's own words. Each side reaches the reader who reads it.
 *  - a bare string — what a package written before this, or by somebody else,
 *    carries. It is shown to both readerships unchanged, because a claim
 *    somebody else made is theirs: translating it would put words in their
 *    mouth, and dropping it would delete the disclosure to punish its author.
 *
 * A pair with one side missing falls back to the side that is there rather than
 * rendering blank — a half-written disclosure is still evidence, and a reader
 * seeing the other language knows more than a reader seeing nothing.
 */
function phrase(value: unknown): Str | undefined {
  const bare = text(value)
  if (bare !== undefined) return { en: bare, zh: bare }
  const pair = asObject(value)
  if (!pair) return undefined
  const en = text(pair.en)
  const zh = text(pair.zh)
  if (en === undefined && zh === undefined) return undefined
  return { en: en ?? (zh as string), zh: zh ?? (en as string) }
}

/** A blank rule is not a rule; it would render as an empty numbered line. */
function phrases(value: unknown): Str[] {
  const out: Str[] = []
  for (const one of asArray(value)) {
    const written = phrase(one)
    if (written) out.push(written)
  }
  return out
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function objects(value: unknown): Record<string, unknown>[] {
  return asArray(value)
    .map(asObject)
    .filter((one): one is Record<string, unknown> => one !== null)
}

function recordsOf(values: unknown, indices: unknown): { index: number; value: unknown }[] {
  const list = asArray(values)
  const at = Array.isArray(indices) ? indices : undefined
  return list.map((value, position) => ({ index: numberAt(at, position) ?? position, value }))
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

/**
 * Ids are minted from the file name, and a result directory holds three
 * different files called `logs.json`. Repeats get a `~n` suffix rather than
 * silently sharing an id space with a file they have nothing to do with.
 */
function label(sources: Source[], notes: Str[]): Source[] {
  const seen = new Map<string, number>()
  let renamed = 0
  const labelled = sources.map((source) => {
    const count = (seen.get(source.label) ?? 0) + 1
    seen.set(source.label, count)
    if (count === 1) return source
    renamed += 1
    return { ...source, label: `${source.label}~${count}` }
  })
  if (renamed > 0) {
    notes.push({
      en: `${renamed} file${renamed === 1 ? '' : 's'} share a name with another in this drop and were suffixed \`~n\` so record links stay unique.`,
      zh: `有 ${renamed} 个文件跟这批数据里的另一个重名，已加上 \`~n\` 后缀，这样记录链接才不会撞在一起。`,
    })
  }
  return labelled
}

/**
 * The same note produced twice — one per run, one per file — is one note. Object
 * identity would keep both, so the pair of strings is the key.
 */
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

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function numberAt(values: unknown[] | undefined, at: number): number | undefined {
  const value = values?.[at]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
