/**
 * Tests for the RM-Bench style matrix. `node --test src/adapters/rm-r1/metrics.test.ts`.
 *
 * The claim this file has to hold up is narrow and checkable: running the same
 * code the way `eval/RM-Bench/scripts/process_final_result.py` runs it reproduces
 * the released `final_result.json` exactly, and changing the one file it reads
 * from moves `hard_acc` and `easy_acc` while leaving `normal_acc` untouched. The
 * reproduction is the control. Without it the corrected numbers are an opinion.
 *
 * The real logs are three 22 MB files per model and are not in this repo. They
 * are read only when AGENTLENS_REAL_LOGS points at an RM-R1 eval result
 * directory, and reported as skipped otherwise; a skipped test is not a passing
 * one. The synthetic tests below cover the matrix algebra on their own, so the
 * suite still says something without the corpus.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  CORRECTED_FILE_ORDER,
  FINAL_RESULT_KEYS,
  SHIPPED_FILE_ORDER,
  alignStyleRuns,
  buildRmBenchSummary,
  foldDomain,
  metricRows,
  metricsOf,
  readOfficialFinalResult,
  readStyleRun,
  styleRunFromJudgements,
} from './metrics.ts'
import type { StyleRunRecord } from './metrics.ts'
import type { CorDocument, Judgement, RmBenchSummary } from './contract.ts'

/* ------------------------------------------------------------------ helpers */

/**
 * Percent, four decimals. Two more than anyone quotes, so a rounding-sized
 * regression still fails, and still far looser than float64 noise.
 */
function pct(value: number): number {
  return Math.round(value * 1_000_000) / 10_000
}

function pcts(summary: RmBenchSummary): Record<string, number> {
  const metrics = metricsOf(summary)
  return Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, pct(value)]))
}

/** Three style files' worth of one record. `results` is `[file][slot]`. */
function record(key: string, domain: string, results: number[][]): StyleRunRecord[] {
  return results.map((slots) => ({ key, domain, results: slots }))
}

/**
 * The two-record fixture, small enough that every cell is a hand sum.
 *
 *   A  file1 [1,0,1]  file2 [1,1,1]  file3 [0,0,1]
 *   B  file1 [0,1,1]  file2 [1,0,1]  file3 [1,0,0]
 */
const A = [
  [1, 0, 1],
  [1, 1, 1],
  [0, 0, 1],
]
const B = [
  [0, 1, 1],
  [1, 0, 1],
  [1, 0, 0],
]

function fixture(domainA = 'chat', domainB = 'chat'): StyleRunRecord[][] {
  const a = record('chat/1', domainA, A)
  const b = record('chat/2', domainB, B)
  return [0, 1, 2].map((file) => [a[file], b[file]])
}

/* ---------------------------------------------------- the hand-built fixture */

test('every cell of the two-record fixture is the hand-computed one', () => {
  const summary = buildRmBenchSummary(fixture())
  assert.equal(summary.domains.length, 1)
  assert.equal(summary.domains[0].domain, 'chat')

  // [0,0]=file1[0]  [0,1]=file2[0]  [0,2]=file3[0]
  // [1,0]=file3[1]  [1,1]=file1[1]  [1,2]=file2[1]
  // [2,0]=file2[2]  [2,1]=file3[2]  [2,2]=file1[2]      averaged over A and B
  assert.deepEqual(summary.overall.cells, [
    [0.5, 1, 0.5],
    [0, 0.5, 0.5],
    [1, 0.5, 1],
  ])
  assert.equal(summary.overall.hard, (1 + 0.5 + 0.5) / 3)
  assert.equal(summary.overall.normal, (0.5 + 0.5 + 1) / 3)
  assert.equal(summary.overall.easy, (0 + 1 + 0.5) / 3)
  assert.equal(pct(summary.totalAverage), pct(11 / 18))
  // One domain, so the macro-average over domains is that domain.
  assert.deepEqual(summary.overall.cells, summary.domains[0].matrix.cells)
})

test('the shipped file order collapses three cells onto their neighbours', () => {
  const shipped = buildRmBenchSummary(fixture()).reproducedOfficial
  assert.ok(shipped)
  // file2 is never read, so every cell that should have come from it repeats file3.
  assert.deepEqual(shipped.overall.cells, [
    [0.5, 0.5, 0.5],
    [0, 0.5, 0],
    [0.5, 0.5, 1],
  ])
  const cells = shipped.overall.cells
  assert.equal(cells[0][1], cells[0][2])
  assert.equal(cells[1][2], cells[1][0])
  assert.equal(cells[2][0], cells[2][1])

  assert.equal(shipped.overall.hard, 1 / 3)
  assert.equal(shipped.overall.easy, 1 / 3)
  assert.equal(shipped.totalAverage, 4 / 9)
  // The signature of this defect: the diagonal is file 1 alone and cannot move.
  assert.equal(shipped.overall.normal, (0.5 + 0.5 + 1) / 3)
})

test('the fixture is not degenerate: hard and easy really do move', () => {
  const summary = buildRmBenchSummary(fixture())
  const shipped = summary.reproducedOfficial
  assert.ok(shipped)
  assert.notEqual(summary.overall.hard, shipped.overall.hard)
  assert.notEqual(summary.overall.easy, shipped.overall.easy)
  assert.equal(summary.overall.normal, shipped.overall.normal)
})

test('a summary built the corrected way is not the summary built the shipped way', () => {
  // Guards the two order constants against being silently the same array.
  assert.deepEqual([...CORRECTED_FILE_ORDER], [0, 1, 2])
  assert.deepEqual([...SHIPPED_FILE_ORDER], [0, 2, 2])
})

/* -------------------------------------------------------------- domain fold */

test('the five raw domains fold to the four the script reports', () => {
  assert.equal(foldDomain('chat'), 'chat')
  assert.equal(foldDomain('code'), 'code')
  assert.equal(foldDomain('math'), 'math')
  assert.equal(foldDomain('safety-refuse'), 'safety')
  assert.equal(foldDomain('safety-response'), 'safety')
  assert.equal(foldDomain('safety'), 'safety')
  assert.equal(foldDomain('unknown'), null)
})

test('safety-refuse and safety-response land in one domain, not two', () => {
  const folded = buildRmBenchSummary(fixture('safety-refuse', 'safety-response'))
  assert.deepEqual(
    folded.domains.map((one) => one.domain),
    ['safety'],
  )
  // Same two records, so the same nine cells as when both were 'chat'.
  assert.deepEqual(folded.overall.cells, buildRmBenchSummary(fixture()).overall.cells)
})

test('a domain the script would drop is counted, not folded into safety', () => {
  const alignment = alignStyleRuns(fixture('chat', 'reasoning'))
  assert.equal(alignment.records.length, 1)
  assert.equal(alignment.unknownDomain, 1)
})

/* ----------------------------------------------------------- alignment rules */

test('the three files are lined up by dataset id, not by position', () => {
  const runs = fixture()
  runs[1].reverse()
  runs[2].reverse()
  const summary = buildRmBenchSummary(runs)
  assert.deepEqual(summary.overall.cells, buildRmBenchSummary(fixture()).overall.cells)
})

test('a key missing from one file is an unmatched record, not a zero', () => {
  const runs = fixture()
  runs[2] = runs[2].filter((one) => one.key !== 'chat/2')
  const alignment = alignStyleRuns(runs)
  assert.equal(alignment.records.length, 1)
  assert.equal(alignment.unmatched, 1)
  assert.equal(alignment.incomplete, 0)
})

test('a missing result slot is an incomplete record, not a wrong answer', () => {
  const runs = fixture()
  runs[1][0] = { ...runs[1][0], results: [1, null, 1] }
  const alignment = alignStyleRuns(runs)
  assert.equal(alignment.records.length, 1)
  assert.equal(alignment.incomplete, 1)
})

test('fewer than three style files is refused, not averaged over what arrived', () => {
  assert.throws(() => buildRmBenchSummary(fixture().slice(0, 2)), /all three style files/)
  assert.throws(() => buildRmBenchSummary(fixture('x', 'x')), /no RM-Bench records aligned/)
})

/* ------------------------------------------- normal_acc is the fix's signature */

test('normal_acc is identical between the two orders for any data', () => {
  // A wrong fix — swapping the wrong pair of cells, or reordering the files —
  // moves the diagonal. Nothing else in the suite would catch that.
  let seed = 20260811
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed >> 16) & 1 // the low bit of an LCG just alternates
  }
  const domains = ['chat', 'math', 'code', 'safety-refuse', 'safety-response']
  let sawHardMove = 0
  for (let round = 0; round < 200; round++) {
    const runs: StyleRunRecord[][] = [[], [], []]
    for (let n = 0; n < 40; n++) {
      const domain = domains[n % domains.length]
      for (let file = 0; file < 3; file++) {
        runs[file].push({ key: `k/${n}`, domain, results: [next(), next(), next()] })
      }
    }
    const summary = buildRmBenchSummary(runs)
    const shipped = summary.reproducedOfficial
    assert.ok(shipped)
    assert.equal(summary.overall.normal, shipped.overall.normal, `round ${round}`)
    for (let i = 0; i < summary.domains.length; i++) {
      assert.equal(summary.domains[i].matrix.normal, shipped.domains[i].matrix.normal, `round ${round}`)
      assert.deepEqual(
        summary.domains[i].matrix.cells.map((row, r) => row[r]),
        shipped.domains[i].matrix.cells.map((row, r) => row[r]),
        `round ${round}`,
      )
    }
    if (summary.overall.hard !== shipped.overall.hard) sawHardMove += 1
  }
  // The invariant is only interesting if the other two corners are free to move.
  assert.ok(sawHardMove > 150, `hard_acc moved in only ${sawHardMove}/200 rounds`)
})

/* ------------------------------------------------------- reading the script's file */

test('metricsOf produces exactly the keys final_result.json carries', () => {
  const summary = buildRmBenchSummary(fixture('chat', 'math'))
  const metrics = metricsOf(summary)
  assert.deepEqual(Object.keys(metrics), ['chat', 'math', 'hard_acc', 'normal_acc', 'easy_acc', 'total_avg_acc'])
  assert.deepEqual(
    [...FINAL_RESULT_KEYS],
    ['chat', 'math', 'code', 'safety', 'hard_acc', 'normal_acc', 'easy_acc', 'total_avg_acc'],
  )
})

test('a dropped final_result.json is read, and anything else is declined', () => {
  const official = readOfficialFinalResult({
    chat: 0.7648578811369511,
    math: 0.8055030455786599,
    code: 0.6608187134502925,
    safety: 0.9382716049382717,
    hard_acc: 0.7049334242582853,
    normal_acc: 0.8050964241257946,
    easy_acc: 0.8670585854440513,
    total_avg_acc: 0.7923628112760438,
  })
  assert.ok(official)
  assert.equal(official.hard_acc, 0.7049334242582853)
  assert.equal(readOfficialFinalResult({ Chat: 0.9, 'Chat Hard': 0.5 }), undefined)
  assert.equal(readOfficialFinalResult([1, 2, 3]), undefined)
  assert.equal(readOfficialFinalResult(null), undefined)
  assert.equal(readOfficialFinalResult({ hard_acc: 'x', normal_acc: 1, easy_acc: 1, total_avg_acc: 1 }), undefined)
})

test('metricRows carries all three numbers so a view cannot show one alone', () => {
  const summary = buildRmBenchSummary(fixture(), { official: { hard_acc: 1 / 3, normal_acc: 2 / 3 } })
  const rows = metricRows(summary)
  const hard = rows.find((row) => row.metric === 'hard_acc')
  assert.ok(hard)
  assert.equal(hard.corrected, 2 / 3)
  assert.equal(hard.reproduced, 1 / 3)
  assert.equal(hard.official, 1 / 3)
  // A metric the dropped file did not carry is absent, not zero.
  assert.equal(rows.find((row) => row.metric === 'easy_acc')?.official, undefined)
})

/* ---------------------------------------------------------------- the readers */

test('readStyleRun takes RM-Bench rows and leaves everything else alone', () => {
  const run = readStyleRun([
    { id: 'chat/100', domain: 'chat', result: [1, 0, 1] },
    { id: 'safety/3', domain: 'safety-refuse', result: [true, false, 1] },
    { id: 42, domain: 'chat', result: [1, 0, 1] }, // int id — not this format
    { id: 'chat/1', domain: 'chat' }, // no result
    { subset: 'math-prm', answers: '…' }, // a RewardBench row
    null,
    [1, 2, 3],
  ])
  assert.deepEqual(run, [
    { key: 'chat/100', domain: 'chat', results: [1, 0, 1] },
    { key: 'safety/3', domain: 'safety-refuse', results: [1, 0, 1] },
  ])
})

test('styleRunFromJudgements regroups one file back into per-record triples', () => {
  const judgements = [0, 1, 2].map((styleIndex) => judgement('total_dataset_1.json:7', 'chat', styleIndex, true))
  judgements.push(judgement('total_dataset_1.json:8', 'safety-refuse', 0, false))
  judgements.push(judgement('total_dataset_1.json:8', 'safety-refuse', 2, null))
  judgements.push({ ...judgement('x:9', 'chat', 0, true), styleIndex: undefined }) // RewardBench
  const run = styleRunFromJudgements(judgements, (one) => one.id)
  assert.deepEqual(run, [
    { key: 'total_dataset_1.json:7', domain: 'chat', results: [1, 1, 1] },
    { key: 'total_dataset_1.json:8', domain: 'safety-refuse', results: [0, null, null] },
  ])
})

test('the Judgement route and the raw route give the same matrix', () => {
  const runs = fixture()
  const viaJudgements = runs.map((run) =>
    styleRunFromJudgements(
      run.flatMap((one) =>
        one.results.map((result, styleIndex) => judgement(one.key, one.domain, styleIndex, result === 1)),
      ),
      (one) => one.id,
    ),
  )
  assert.deepEqual(buildRmBenchSummary(viaJudgements).overall.cells, buildRmBenchSummary(runs).overall.cells)
})

const EMPTY_COR: CorDocument = {
  route: 'unknown',
  criteria: [],
  evidence: [],
  verdict: null,
  ambiguous: false,
  degraded: true,
  raw: '',
}

function judgement(id: string, group: string, styleIndex: number, correct: boolean | null): Judgement {
  return {
    id,
    benchmark: 'rm-bench',
    group,
    chosen: [],
    rejected: [],
    chosenShownAs: 'A',
    correct,
    cor: EMPTY_COR,
    styleIndex,
  }
}

/* ------------------------------------------------- real logs, when available */

const REAL_LOGS = process.env.AGENTLENS_REAL_LOGS
const REAL_LOGS_HINT =
  'set AGENTLENS_REAL_LOGS to the RM-R1 eval result directory (the one holding reward_bench/, RM-Bench/, RMB/)'

/** The two published 32B runs: the one AGENTLENS_REAL_LOGS names, and its sibling. */
const SECOND_MODEL_DIR = 'RM-R1-DeepSeek-Distilled-Qwen-32B'

function modelDir(which: 'primary' | 'second'): string | null {
  if (!REAL_LOGS) return null
  const dir = which === 'primary' ? REAL_LOGS : path.join(REAL_LOGS, '..', SECOND_MODEL_DIR)
  return fs.existsSync(path.join(dir, 'RM-Bench', 'logs')) ? dir : null
}

const PRIMARY = modelDir('primary')
const SECOND = modelDir('second')

function unless(dir: string | null): string | undefined {
  return dir ? undefined : REAL_LOGS_HINT
}

/**
 * Load a model's three style files. The model name is read off the file names
 * rather than off any field inside them: the released score files carry an
 * internal training-run name in `model`, which is not ours to redistribute.
 */
function loadRuns(dir: string): { runs: StyleRunRecord[][]; official: Record<string, number> } {
  const logs = path.join(dir, 'RM-Bench', 'logs')
  const first = fs.readdirSync(logs).find((name) => name.startsWith('total_dataset_1_'))
  assert.ok(first, `no total_dataset_1_*.json in ${logs}`)
  const suffix = first.slice('total_dataset_1_'.length)
  const runs = [1, 2, 3].map((n) =>
    readStyleRun(JSON.parse(fs.readFileSync(path.join(logs, `total_dataset_${n}_${suffix}`), 'utf8')) as unknown[]),
  )
  const official = readOfficialFinalResult(JSON.parse(fs.readFileSync(path.join(logs, 'final_result.json'), 'utf8')))
  assert.ok(official, 'final_result.json did not read as a score file')
  return { runs, official }
}

/** The shipped file is float64 written by numpy; this is far tighter than any rounding. */
const TOLERANCE = 1e-12

function assertReproducesShipped(dir: string): RmBenchSummary {
  const { runs, official } = loadRuns(dir)
  for (const run of runs) assert.equal(run.length, 1327)

  const alignment = alignStyleRuns(runs)
  assert.equal(alignment.records.length, 1327)
  assert.equal(alignment.unmatched, 0)
  assert.equal(alignment.incomplete, 0)
  assert.equal(alignment.unknownDomain, 0)

  const summary = buildRmBenchSummary(runs, { official })
  assert.ok(summary.reproducedOfficial)
  const reproduced = metricsOf(summary.reproducedOfficial)
  for (const key of FINAL_RESULT_KEYS) {
    assert.ok(key in reproduced, `missing ${key}`)
    assert.ok(
      Math.abs(reproduced[key] - official[key]) < TOLERANCE,
      `${key}: reproduced ${reproduced[key]} vs shipped ${official[key]}`,
    )
  }
  return summary
}

test('32B: running it the script\'s way reproduces the released final_result.json', { skip: unless(PRIMARY) }, () => {
  if (!PRIMARY) return
  assertReproducesShipped(PRIMARY)
})

test('32B: the corrected numbers are the ones the outreach quotes', { skip: unless(PRIMARY) }, () => {
  if (!PRIMARY) return
  const summary = assertReproducesShipped(PRIMARY)
  // Rounded to 2 dp these are the table in the brief: 74.94 / 80.24 / 65.79 /
  // 93.60 / 67.23 / 80.51 / 88.18 / 78.64.
  assert.deepEqual(pcts(summary), {
    chat: 74.9354,
    math: 80.2352,
    code: 65.7895,
    safety: 93.6004,
    hard_acc: 67.2328,
    normal_acc: 80.5096,
    easy_acc: 88.1779,
    total_avg_acc: 78.6401,
  })
  assert.deepEqual(pcts(summary.reproducedOfficial!), {
    chat: 76.4858,
    math: 80.5503,
    code: 66.0819,
    safety: 93.8272,
    hard_acc: 70.4933,
    normal_acc: 80.5096,
    easy_acc: 86.7059,
    total_avg_acc: 79.2363,
  })
})

test('32B: normal_acc is bit-identical, and hard_acc is overstated', { skip: unless(PRIMARY) }, () => {
  if (!PRIMARY) return
  const summary = buildRmBenchSummary(loadRuns(PRIMARY).runs)
  const shipped = summary.reproducedOfficial!
  assert.equal(summary.overall.normal, shipped.overall.normal)
  for (let i = 0; i < summary.domains.length; i++) {
    assert.equal(summary.domains[i].matrix.normal, shipped.domains[i].matrix.normal)
  }
  // The headline: hard_acc is overstated by 3.26 points, easy_acc understated by 1.47.
  assert.equal(pct(shipped.overall.hard - summary.overall.hard), 3.2605)
  assert.equal(pct(shipped.overall.easy - summary.overall.easy), -1.472)
})

test('DeepSeek-Distilled: the same one line moves the same three corners', { skip: unless(SECOND) }, () => {
  if (!SECOND) return
  const summary = assertReproducesShipped(SECOND)
  assert.deepEqual(pcts(summary), {
    chat: 73.2127,
    math: 91.8294,
    code: 73.3431,
    safety: 95.0113,
    hard_acc: 73.4801,
    normal_acc: 85.4519,
    easy_acc: 91.1154,
    total_avg_acc: 83.3492,
  })
  const shipped = summary.reproducedOfficial!
  assert.equal(summary.overall.normal, shipped.overall.normal)
  // A different run, the same size of distortion: 3.22 points of hard_acc.
  assert.equal(pct(shipped.overall.hard - summary.overall.hard), 3.2223)
  assert.equal(pct(shipped.overall.easy - summary.overall.easy), -1.6215)
  // Not every metric is flattered by the defect: this run's math score is very
  // slightly UNDERstated by it, so "the bug inflates the results" is too strong.
  assert.ok(metricsOf(shipped).math < metricsOf(summary).math)
})
