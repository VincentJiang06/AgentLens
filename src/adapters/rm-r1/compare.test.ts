/**
 * Tests for V3's pure core. `node --test src/adapters/rm-r1/compare.test.ts`.
 *
 * Two of these matter more than the rest. `alignKey` must key on the dataset
 * pair and nothing the judge produced, or two runs stop lining up the moment one
 * of them is a sample. And a mirrored pair — the same record shown with the A/B
 * slots swapped — must compare as agreement, because that is the case the
 * harness's unseeded shuffle can produce at any time and the case a raw
 * `[[A]]`/`[[B]]` comparison gets wrong.
 *
 * The last test runs against the two released 32B logs when `RM_R1_LOGS` points
 * at an `eval/result` directory, and is skipped otherwise: the logs are 15 MB
 * each and are not in this repo.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { alignKey, alignRuns, matchesFilter, pickedSide, splitRuns } from './compare.ts'
import type { Run } from './compare.ts'
import { agreeOutcomes, outcomesFor, outcomesOfFile, parse } from './model.ts'
import type { OutcomeSet } from './contract.ts'
import type { CorDocument, Judgement, RmR1Model } from './contract.ts'
import type { ParsedFile } from '../../types.ts'

function cor(verdict: 'A' | 'B' | null, raw = 'raw'): CorDocument {
  return {
    route: 'chat',
    criteria: [],
    evidence: [],
    verdict,
    ambiguous: false,
    degraded: false,
    raw,
  }
}

interface JudgementOptions {
  id: string
  group?: string
  question?: string
  chosen?: string
  rejected?: string
  chosenShownAs?: 'A' | 'B'
  correct?: boolean | null
  verdict?: 'A' | 'B' | null
  styleIndex?: number
}

function judgement(options: JudgementOptions): Judgement {
  const chosenShownAs = options.chosenShownAs ?? 'A'
  const correct = options.correct === undefined ? true : options.correct
  const verdict =
    options.verdict === undefined
      ? correct === null
        ? null
        : correct
          ? chosenShownAs
          : chosenShownAs === 'A'
            ? 'B'
            : 'A'
      : options.verdict
  return {
    id: options.id,
    benchmark: 'rewardbench',
    group: options.group ?? 'alpacaeval-easy',
    prompt: options.question,
    chosen: [{ role: 'assistant', content: options.chosen ?? 'the better answer' }],
    rejected: [{ role: 'assistant', content: options.rejected ?? 'the worse answer' }],
    chosenShownAs,
    correct,
    cor: cor(verdict),
    styleIndex: options.styleIndex,
  }
}

function modelOf(judgements: Judgement[], fileNames: string[] = []): RmR1Model {
  return {
    judgements,
    benchmarks: ['rewardbench'],
    groups: [...new Set(judgements.map((one) => one.group))],
    officialScores: [],
    // A dropped log carries no outcome table, which is the case the compare view
    // falls back to the aligned records for.
    outcomes: [],
    runs: fileNames.map((fileName) => ({
      run: '',
      benchmark: 'rewardbench' as const,
      files: [fileName],
      fileName,
      count: judgements.filter((one) => one.id.startsWith(`${fileName}:`)).length,
    })),
    coverage: [],
    notes: [],
  }
}

/* ------------------------------------------------------------------ the key */

test('the alignment key ignores everything the judge produced', () => {
  const left = judgement({ id: 'a.json:0', chosenShownAs: 'A', correct: true })
  const right = judgement({ id: 'b.json:41', chosenShownAs: 'B', correct: false })
  assert.equal(alignKey(left), alignKey(right))
})

test('the alignment key separates the two responses and the three styles', () => {
  const base = judgement({ id: 'a.json:0', chosen: 'one two', rejected: 'three' })
  const swapped = judgement({ id: 'a.json:1', chosen: 'one', rejected: 'two three' })
  const styled = judgement({ id: 'a.json:2', chosen: 'one two', rejected: 'three', styleIndex: 2 })
  assert.notEqual(alignKey(base), alignKey(swapped))
  assert.notEqual(alignKey(base), alignKey(styled))
})

test('the prompt is part of the key, so two subsets sharing a pair stay apart', () => {
  const one = judgement({ id: 'a.json:0', question: 'why is the sky blue' })
  const two = judgement({ id: 'a.json:1', question: 'why is the sea blue' })
  assert.notEqual(alignKey(one), alignKey(two))
})

/* ----------------------------------------------------------------- the runs */

test('runs are split by file and benchmark, and duplicate keys are counted', () => {
  const model = modelOf(
    [
      judgement({ id: 'logs.json:0', chosen: 'x' }),
      judgement({ id: 'logs.json:1', chosen: 'y' }),
      // What two dropped files of the same name look like from in here.
      judgement({ id: 'logs.json:2', chosen: 'x' }),
      judgement({ id: 'other.json:0', chosen: 'x' }),
    ],
    ['logs.json', 'other.json'],
  )
  const runs = splitRuns(model)
  assert.deepEqual(
    runs.map((run) => [run.fileName, run.judgements.length, run.duplicateKeys]),
    [
      ['logs.json', 3, 1],
      ['other.json', 1, 0],
    ],
  )
})

test('runs are recovered even when the model left `runs` empty', () => {
  const runs = splitRuns(modelOf([judgement({ id: 'logs.json:0' })]))
  assert.equal(runs.length, 1)
  assert.equal(runs[0].fileName, 'logs.json')
})

/* ------------------------------------------------------------ the alignment */

function runOf(fileName: string, judgements: Judgement[]): Run {
  const runs = splitRuns(modelOf(judgements, [fileName]))
  return runs[0]
}

test('a mirrored record is agreement, not disagreement', () => {
  // Same record, same call, opposite slots: raw `[[A]]` vs `[[B]]`.
  const one = runOf('one.json', [judgement({ id: 'one.json:0', chosenShownAs: 'A', correct: true })])
  const two = runOf('two.json', [judgement({ id: 'two.json:0', chosenShownAs: 'B', correct: true })])
  const aligned = alignRuns(one, two)

  assert.equal(aligned.pairs.length, 1)
  assert.equal(aligned.pairs[0].cell, 'both-right')
  assert.equal(aligned.pairs[0].mirrored, true)
  assert.equal(aligned.mirrored, 1)
  // The count the note on screen quotes: raw letters would have called this one
  // a disagreement.
  assert.notEqual(one.judgements[0].cor.verdict, two.judgements[0].cor.verdict)
  assert.equal(aligned.rawWouldMisread, 1)
  assert.equal(pickedSide(one.judgements[0]), 'chosen')
  assert.equal(pickedSide(two.judgements[0]), 'chosen')
})

test('unmirrored runs report zero, which is what lets the view say so', () => {
  const one = runOf('one.json', [judgement({ id: 'one.json:0', chosenShownAs: 'B', correct: true })])
  const two = runOf('two.json', [judgement({ id: 'two.json:0', chosenShownAs: 'B', correct: false })])
  const aligned = alignRuns(one, two)
  assert.equal(aligned.mirrored, 0)
  assert.equal(aligned.rawWouldMisread, 0)
  assert.equal(aligned.pairs[0].cell, 'run1-only')
})

test('the four cells, the unmatched records and the group deltas', () => {
  const one = runOf('one.json', [
    judgement({ id: 'one.json:0', chosen: 'a', correct: true, group: 'chat' }),
    judgement({ id: 'one.json:1', chosen: 'b', correct: true, group: 'chat' }),
    judgement({ id: 'one.json:2', chosen: 'c', correct: false, group: 'math' }),
    judgement({ id: 'one.json:3', chosen: 'd', correct: false, group: 'math' }),
    judgement({ id: 'one.json:4', chosen: 'only here', correct: true, group: 'math' }),
  ])
  const two = runOf('two.json', [
    judgement({ id: 'two.json:0', chosen: 'a', correct: true, group: 'chat' }),
    judgement({ id: 'two.json:1', chosen: 'b', correct: false, group: 'chat' }),
    judgement({ id: 'two.json:2', chosen: 'c', correct: true, group: 'math' }),
    judgement({ id: 'two.json:3', chosen: 'd', correct: false, group: 'math' }),
  ])
  const aligned = alignRuns(one, two)

  assert.equal(aligned.pairs.length, 4)
  assert.equal(aligned.counts['both-right'], 1)
  assert.equal(aligned.counts['run1-only'], 1)
  assert.equal(aligned.counts['run2-only'], 1)
  assert.equal(aligned.counts['both-wrong'], 1)
  assert.equal(aligned.onlyInRun1, 1)
  assert.equal(aligned.onlyInRun2, 0)

  const [worst] = aligned.groups
  assert.equal(worst.group, 'chat')
  assert.equal(worst.aligned, 2)
  assert.equal(worst.delta, -50)
  const math = aligned.groups.find((group) => group.group === 'math')
  assert.equal(math?.delta, 50)
})

test('a record with no recorded result is held out rather than scored', () => {
  const one = runOf('one.json', [judgement({ id: 'one.json:0', correct: null })])
  const two = runOf('two.json', [judgement({ id: 'two.json:0', correct: true })])
  const aligned = alignRuns(one, two)
  assert.equal(aligned.counts.indeterminate, 1)
  assert.equal(aligned.determinate, 0)
  assert.equal(aligned.groups.length, 0)
})

test('a parsed verdict that contradicts the harness is counted, not silently used', () => {
  const one = runOf('one.json', [
    judgement({ id: 'one.json:0', chosenShownAs: 'A', correct: true, verdict: 'B' }),
  ])
  const two = runOf('two.json', [judgement({ id: 'two.json:0', chosenShownAs: 'A', correct: true })])
  const aligned = alignRuns(one, two)
  assert.equal(aligned.verdictConflicts, 1)
  assert.equal(aligned.counts['both-right'], 1)
})

test('the default filter is the payload: the two one-sided cells', () => {
  const cells = ['both-right', 'run1-only', 'run2-only', 'both-wrong', 'indeterminate'] as const
  const kept = cells.filter((cell) =>
    matchesFilter(
      { key: 'k', group: 'chat', one: judgement({ id: 'a:0' }), two: judgement({ id: 'b:0' }), cell, mirrored: false },
      'disagree',
      null,
    ),
  )
  assert.deepEqual(kept, ['run1-only', 'run2-only'])
})

/* ------------------------------------------------------- the released logs */

/** Minimal stand-in for the adapter's parser: only what alignment reads. */
function rewardBenchRun(fileName: string, file: string): Run {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    text_chosen: { role: string; content: string }[]
    text_rejected: { role: string; content: string }[]
    results: number
    answers: string
    Is_Chosen_Answer_Shuffled_toPositionB: boolean
    subset: string
  }[]
  const judgements = raw.map((record, index): Judgement => {
    const letters = [...record.answers.matchAll(/\[\[([AB])\]\]/g)].map((match) => match[1])
    const distinct = new Set(letters)
    const verdict = distinct.size === 1 ? (letters[0] as 'A' | 'B') : null
    return {
      id: `${fileName}:${index}`,
      benchmark: 'rewardbench',
      group: record.subset,
      chosen: record.text_chosen,
      rejected: record.text_rejected,
      chosenShownAs: record.Is_Chosen_Answer_Shuffled_toPositionB ? 'B' : 'A',
      correct: record.results === 1,
      cor: { ...cor(verdict, record.answers), ambiguous: distinct.size > 1 },
    }
  })
  return splitRuns(modelOf(judgements, [fileName]))[0]
}

/**
 * This test wants the `eval/result` directory holding *both* released runs,
 * where the other real-log tests want one run's directory inside it. One env
 * var runs the lot: `AGENTLENS_REAL_LOGS` is a run directory, so its parent is
 * the pair.
 */
const LOGS =
  process.env.RM_R1_LOGS ??
  (process.env.AGENTLENS_REAL_LOGS === undefined
    ? undefined
    : path.dirname(process.env.AGENTLENS_REAL_LOGS))
const RELEASED = 'reward_bench/log_result/logs.json'

test(
  'the two released 32B RewardBench runs align completely and are not mirrored',
  { skip: LOGS ? false : 'set RM_R1_LOGS (or AGENTLENS_REAL_LOGS) to run this against the released logs' },
  () => {
    const root = LOGS ?? ''
    const one = rewardBenchRun(
      'qwen-instruct.json',
      path.join(root, 'RM-R1-Qwen2.5-Instruct-32B', RELEASED),
    )
    const two = rewardBenchRun(
      'deepseek-distilled.json',
      path.join(root, 'RM-R1-DeepSeek-Distilled-Qwen-32B', RELEASED),
    )
    const aligned = alignRuns(one, two)

    // Content alignment recovers every record, so nothing is dropped and the
    // per-group numbers below are over the whole benchmark.
    assert.equal(one.judgements.length, 2985)
    assert.equal(two.judgements.length, 2985)
    assert.equal(aligned.pairs.length, 2985)
    assert.equal(aligned.onlyInRun1, 0)
    assert.equal(aligned.onlyInRun2, 0)
    assert.equal(one.duplicateKeys, 0)
    assert.equal(two.duplicateKeys, 0)

    // The claim the position note makes about these two files, and the reason it
    // is phrased as a measurement: the shuffle is unseeded, but these two runs
    // carry the same flags on every record.
    assert.equal(aligned.mirrored, 0)
    assert.equal(aligned.rawWouldMisread, 0)
    assert.equal(aligned.verdictConflicts, 0)

    assert.deepEqual(aligned.counts, {
      'both-right': 2668,
      'run1-only': 106,
      'run2-only': 92,
      'both-wrong': 119,
      indeterminate: 0,
    })
    const mtBenchHard = aligned.groups.find((group) => group.group === 'mt-bench-hard')
    assert.equal(mtBenchHard?.aligned, 37)
    assert.equal(mtBenchHard?.delta.toFixed(1), '-13.5')
  },
)

/* --------------------------------------- what the compare panels are over */

/**
 * `RunCompare.tsx` computes its matrix, its movement table and its two
 * accuracies from the complete outcome tables when both runs packed one, and
 * only its record list from the judgements aligned above. Node cannot import a
 * `.tsx` file, so the recipe is restated here against the shipped package: this
 * is the arithmetic the screen has to be showing, and the figures below are the
 * ones the released logs actually produce.
 */
const PACKAGES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/demo-data/rm-r1')

function openPackage(fileName: string): ParsedFile {
  const text = fs.readFileSync(path.join(PACKAGES, fileName), 'utf8')
  const value = JSON.parse(text) as Record<string, unknown>
  return {
    fileName,
    size: Buffer.byteLength(text),
    shape: 'json-object',
    records: [{ index: 0, value }],
    problems: [],
    salvaged: false,
    declaredFormat: String(value.agentlens_format),
  }
}

/** One group's slice of a run's table — how the movement panel is built. */
function inGroup(set: OutcomeSet, group: string): OutcomeSet {
  return { ...set, records: set.records.filter((record) => record.group === group) }
}

test('the compare package answers for the whole benchmark, not for its 40 sampled records', () => {
  const model = parse([openPackage('rm-r1-compare.json')])

  // What the record list can show: 40 records, drawn from the disagreements, so
  // neither run is right more than 16 times and nothing is both-right.
  const [runOne, runTwo] = splitRuns(model)
  const sample = alignRuns(runOne, runTwo)
  assert.equal(sample.pairs.length, 40)
  assert.equal(sample.counts['both-right'], 0)

  // What the panels above it are over: both runs' complete tables, each naming
  // its own checkpoint. The view refuses the benchmark basis unless both are
  // complete and the two run ids differ.
  const sets = outcomesFor(model, 'rewardbench')
  assert.equal(sets.length, 2)
  assert.deepEqual(sets.map((set) => set.run), [
    'RM-R1-Qwen2.5-Instruct-32B',
    'RM-R1-DeepSeek-Distilled-Qwen-32B',
  ])
  assert.ok(sets.every((set) => set.complete && set.total === 2985))
  assert.deepEqual(
    sets.map((set) => outcomesOfFile(model, set.files[0])?.run),
    sets.map((set) => set.run),
  )

  const agreement = agreeOutcomes(sets[0], sets[1])
  assert.equal(agreement.aligned, 2985)
  assert.equal(agreement.onlyInRun1, 0)
  assert.equal(agreement.onlyInRun2, 0)
  // The same four numbers the two released 15 MB logs give above.
  assert.deepEqual(agreement.counts, {
    'both-right': 2668,
    'run1-only': 106,
    'run2-only': 92,
    'both-wrong': 119,
    indeterminate: 0,
  })
  assert.equal(agreement.oneRight, 2774)
  assert.equal(agreement.twoRight, 2760)

  // Movement by group, per the same recipe. mt-bench-hard is the row the
  // released logs put at −13.5 points; over the 40 sampled records it is n=1.
  const slice = agreeOutcomes(inGroup(sets[0], 'mt-bench-hard'), inGroup(sets[1], 'mt-bench-hard'))
  assert.equal(slice.determinate, 37)
  assert.equal(((100 * (slice.twoRight - slice.oneRight)) / slice.determinate).toFixed(1), '-13.5')
})

test('three style files of one checkpoint are one run and share one table', () => {
  // The guard the benchmark basis turns on: RM-Bench writes one run into
  // total_dataset_1/2/3, all three resolve to the same table, and comparing a
  // table with itself would report a run in perfect agreement with itself.
  const model = parse([openPackage('rm-r1-32b.json')])
  const styles = [1, 2, 3].map((n) => `total_dataset_${n}_RM-R1-Qwen2.5-Instruct-32B.json`)
  const sets = styles.map((file) => outcomesOfFile(model, file))
  assert.ok(sets.every((set) => set !== undefined))
  assert.equal(new Set(sets.map((set) => set?.run)).size, 1)
  assert.equal(sets[0], sets[1])
  assert.equal(sets[1], sets[2])
})
