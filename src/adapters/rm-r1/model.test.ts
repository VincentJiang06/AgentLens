/**
 * Tests for the RM-R1 adapter's pure core. `node --test src/adapters/rm-r1/model.test.ts`.
 *
 * model.ts has no React and no DOM, which is why it is a separate file: whether
 * a deep link lands on the right judgement, whether A and B are the right way
 * round, whether a leaked checkpoint name can reach the screen, and whether the
 * recomputed RM-Bench matrix is right are all checkable without a browser.
 *
 * The tests that matter most read the released 32B logs, which are not in this
 * repository — they are other people's data and two of them are tens of
 * megabytes. They run when AGENTLENS_REAL_LOGS points at that directory and are
 * reported as skipped otherwise; a skipped test is not a passing one.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  DROPPED_SCORE_FIELDS,
  agreeOutcomes,
  judgementId,
  judgementIndexFor,
  officialScoresFor,
  outcomesFor,
  parse,
  runIdOf,
  sniff,
} from './model.ts'
import type { RmR1Model } from './contract.ts'
import type { Str } from '../../shell/lang.ts'
import type { ParsedFile } from '../../types.ts'

/* ------------------------------------------------------------------ helpers */

/**
 * A note is two strings now, so a test asks which language it is asserting
 * about. `en` here throughout, because the English is what the finding quotes —
 * and `everyNoteIsBilingual` below is what stops the Chinese from being a copy.
 */
function noteMatching(notes: readonly Str[], text: string): Str | undefined {
  return notes.find((one) => one.en.includes(text))
}

function hasNote(notes: readonly Str[], text: string): boolean {
  return noteMatching(notes, text) !== undefined
}

/** What the worker hands an adapter: one file, records in file order. */
function fileOf(fileName: string, values: unknown[], extra: Partial<ParsedFile> = {}): ParsedFile {
  return {
    fileName,
    size: 0,
    shape: 'json-array',
    problems: [],
    salvaged: false,
    records: values.map((value, index) => ({ index, value })),
    ...extra,
  }
}

const rewardBenchRecord = (over: Record<string, unknown> = {}) => ({
  subset: 'alpacaeval-easy',
  text_chosen: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'good' },
  ],
  text_rejected: [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'bad' },
  ],
  answers: '<type>Chat</type><rubric>1. A</rubric><eval>e</eval><answer>[[A]]</answer>',
  results: 1,
  Is_Chosen_Answer_Shuffled_toPositionB: false,
  id: 30,
  ...over,
})

const rmBenchRecord = (over: Record<string, unknown> = {}) => ({
  id: 'chat/100',
  prompt: 'how do I host guests?',
  chosen: ['short', 'long', '**long**'],
  rejected: ['short bad', 'long bad', '**long bad**'],
  domain: 'chat',
  result: [1, 1, 0],
  output: ['<type>Chat</type><eval>e</eval><answer>[[A]]</answer>', 'x', 'y'],
  Is_Chosen_Answer_Shuffled_toPositionB: [true, false, true],
  ...over,
})

const rmbPairwiseRecord = () => ({
  pair_uid: '8777',
  category_path: 'Pairwise_set/Helpfulness/Summarization/Standard Summaries',
  subset: 'Pairwise_set/Helpfulness/Summarization/Standard Summaries',
  text_chosen: [{ role: 'user', content: 'q' }],
  text_rejected: [{ role: 'user', content: 'q' }],
  results: 0,
  answers: '<type>Chat</type><eval>e</eval><answer>[[B]]</answer>',
  Is_Chosen_Answer_Shuffled_toPositionB: true,
})

const rmbBonRecord = () => ({ ...rmbPairwiseRecord(), pair_uid: undefined, bon_uid: '3405', idx: 0 })

/* ------------------------------------------------------- a two-run package */

/** `main_score.json`'s keys, with the run's own numbers in them. */
const mainScore = (chat: number) => ({
  Chat: chat,
  'Chat Hard': chat - 0.1,
  Safety: 0.9,
  Reasoning: 0.9,
  absoluate_Result: chat - 0.02,
})

/**
 * The shape `scripts/build-demo-data/rm-r1.mjs` writes for a compare package: a
 * sample of full traces per run, plus every record's outcome per run. Six
 * records, two of them sampled, and the two runs disagree on four — small enough
 * to assert every cell of the agreement matrix by hand.
 */
const OUTCOMES: Record<'A' | 'B', (number | null)[]> = {
  A: [1, 1, 0, 1, 0, 0],
  B: [1, 0, 0, 1, 1, null],
}
const SUBSETS = ['alpacaeval-easy', 'alpacaeval-easy', 'alpacaeval-easy', 'math-prm', 'math-prm', 'math-prm']

function twoRunBundle(): Record<string, unknown> {
  return {
    agentlens_format: 'rm-r1@1',
    runs: (['A', 'B'] as const).map((run) => ({
      run_id: `run-${run}`,
      logs: [
        {
          source_path: `run-${run}/reward_bench/log_result/logs.json`,
          benchmark: 'rewardbench',
          source_indices: [0, 4],
          records: [0, 4].map((at) =>
            rewardBenchRecord({ subset: SUBSETS[at], results: OUTCOMES[run][at], id: at }),
          ),
        },
      ],
      outcome_tables: [
        {
          benchmark: 'rewardbench',
          complete: true,
          columns: ['source_index', 'id', 'subset', 'results'],
          rows: SUBSETS.map((subset, at) => [at, at, subset, OUTCOMES[run][at]]),
        },
      ],
      scores: [
        {
          source_path: `run-${run}/reward_bench/score_result/main_score.json`,
          value: mainScore(run === 'A' ? 0.95 : 0.8),
        },
      ],
    })),
  }
}

/* ------------------------------------------------- real logs, when available */

const REAL_LOGS = process.env.AGENTLENS_REAL_LOGS
const REAL_LOGS_HINT =
  'set AGENTLENS_REAL_LOGS to the RM-R1 eval result directory (the one holding reward_bench/, RM-Bench/, RMB/)'

function realLog(relative: string): string | null {
  if (!REAL_LOGS) return null
  const full = path.join(REAL_LOGS, relative)
  return fs.existsSync(full) ? full : null
}

const MODEL_NAME = 'RM-R1-Qwen2.5-Instruct-32B'
const REWARD_BENCH = realLog('reward_bench/log_result/logs.json')
const MAIN_SCORE = realLog('reward_bench/score_result/main_score.json')
const SUBSET_SCORE = realLog('reward_bench/score_result/each_small_section_score.json')
const RM_BENCH = [1, 2, 3].map((n) => realLog(`RM-Bench/logs/total_dataset_${n}_${MODEL_NAME}.json`))
const RM_BENCH_RESULT = realLog('RM-Bench/final_result.json')

function unless(...files: (string | null)[]): string | undefined {
  return files.every(Boolean) ? undefined : REAL_LOGS_HINT
}

function load(file: string | null): ParsedFile {
  const full = file as string
  const value = JSON.parse(fs.readFileSync(full, 'utf8')) as unknown
  return Array.isArray(value)
    ? fileOf(path.basename(full), value)
    : fileOf(path.basename(full), [value], { shape: 'json-object' })
}

/* ----------------------------------------------------------------- sniffing */

test('each log family fingerprints as ours, and foreign records do not', () => {
  assert.ok(sniff('logs.json', [rewardBenchRecord(), rewardBenchRecord()]) > 0.9)
  assert.ok(sniff('total_dataset_1_x.json', [rmBenchRecord()]) > 0.9)
  assert.ok(sniff('logs.json', [rmbPairwiseRecord()]) > 0.9)
  assert.ok(sniff('raw_logs.json', [rmbBonRecord()]) > 0.9)

  assert.equal(sniff('rows.json', [{ id: 1, text: 'x' }, { id: 2 }]), 0)
  assert.equal(sniff('empty.json', []), 0)
  assert.equal(sniff('cases.json', [{ trace_id: 't', prior: [], current: {} }]), 0)
})

test('score files are recognised but do not claim a drop on their own', () => {
  const main = { Chat: 0.95, 'Chat Hard': 0.83, Safety: 0.91, Reasoning: 0.95, absoluate_Result: 0.92 }
  const perSubset = { model: 'x', model_type: 'Generative RM', chat_template: null, 'hep-go': 0.96 }
  const rmBench = { chat: 0.76, math: 0.8, code: 0.66, safety: 0.93, hard_acc: 0.7, normal_acc: 0.8, easy_acc: 0.86, total_avg_acc: 0.79 }

  // Below the shell's 0.5 confidence floor: a drop of nothing but summaries has
  // no judgements in it, and the raw record browser is the better answer.
  for (const scores of [main, perSubset, rmBench]) assert.ok(sniff('score.json', [scores]) < 0.5)
  // Mixed with logs the mean still clears the floor.
  assert.ok(sniff('drop', [rewardBenchRecord(), rewardBenchRecord(), main]) > 0.5)
})

/* ------------------------------------------------------------ normalisation */

test('RewardBench records become one judgement each', () => {
  const model = parse([fileOf('logs.json', [rewardBenchRecord(), rewardBenchRecord({ results: 0, id: 34 })])])
  assert.deepEqual(model.benchmarks, ['rewardbench'])
  assert.equal(model.judgements.length, 2)

  const [first, second] = model.judgements
  assert.equal(first.id, 'logs.json:0')
  assert.equal(first.group, 'alpacaeval-easy')
  assert.equal(first.prompt, undefined, 'RewardBench logs carry no prompt; text_chosen[0] is the user turn')
  assert.deepEqual(first.chosen, [
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'good' },
  ])
  assert.equal(first.correct, true)
  assert.equal(second.correct, false)
  assert.equal(first.cor.verdict, 'A')
  assert.deepEqual(model.groups, ['alpacaeval-easy'])
  assert.deepEqual(model.runs, [], 'one file is one run')
})

test('chosenShownAs follows the shuffle flag, because the judge names the shuffled slot', () => {
  const model = parse([
    fileOf('logs.json', [
      rewardBenchRecord({ Is_Chosen_Answer_Shuffled_toPositionB: false }),
      rewardBenchRecord({ Is_Chosen_Answer_Shuffled_toPositionB: true }),
      // Anything that is not `true` is position A. The contract has no third
      // value, so this is forced; it is here so the forcing is visible.
      rewardBenchRecord({ Is_Chosen_Answer_Shuffled_toPositionB: null }),
    ]),
  ])
  assert.deepEqual(model.judgements.map((one) => one.chosenShownAs), ['A', 'B', 'A'])
})

test('an unrecorded outcome is null, never a guess', () => {
  const model = parse([
    fileOf('logs.json', [
      rewardBenchRecord({ results: 1 }),
      rewardBenchRecord({ results: 0 }),
      rewardBenchRecord({ results: null }),
      rewardBenchRecord({ results: 0.5 }),
    ]),
  ])
  assert.deepEqual(model.judgements.map((one) => one.correct), [true, false, null, null])
})

test('one RM-Bench record is three judgements, one per response style', () => {
  const model = parse([fileOf('total_dataset_1_M.json', [rmBenchRecord()])])
  assert.equal(model.judgements.length, 3)
  assert.deepEqual(model.judgements.map((one) => one.id), [
    'total_dataset_1_M.json:0:0',
    'total_dataset_1_M.json:0:1',
    'total_dataset_1_M.json:0:2',
  ])
  assert.deepEqual(model.judgements.map((one) => one.styleIndex), [0, 1, 2])
  assert.deepEqual(model.judgements.map((one) => one.chosenShownAs), ['B', 'A', 'B'])
  assert.deepEqual(model.judgements.map((one) => one.correct), [true, true, false])
  // chosen/rejected are bare strings in this family; the prompt it does carry is
  // put back as the user turn so every family renders the same way.
  assert.deepEqual(model.judgements[1].chosen, [
    { role: 'user', content: 'how do I host guests?' },
    { role: 'assistant', content: 'long' },
  ])
  assert.equal(model.judgements[0].prompt, 'how do I host guests?')
})

test('RM-Bench keeps all five domains, and folds only where the official scorer does', () => {
  const model = parse([
    fileOf('total_dataset_1_M.json', [
      rmBenchRecord({ domain: 'safety-refuse', id: 'safety/1' }),
      rmBenchRecord({ domain: 'safety-response', id: 'safety/2' }),
    ]),
  ])
  assert.deepEqual(model.groups, ['safety-refuse', 'safety-response'])
  assert.ok(hasNote(model.notes, 'five values'))
})

test('RMB pairwise and BoN are told apart, and grouped by category path', () => {
  const model = parse([
    fileOf('logs.json', [rmbPairwiseRecord()]),
    fileOf('raw_logs.json', [rmbBonRecord()]),
  ])
  assert.deepEqual(model.benchmarks, ['rmb-pairwise', 'rmb-bon'])
  assert.equal(model.judgements[0].group, 'Pairwise_set/Helpfulness/Summarization/Standard Summaries')
  assert.equal(model.judgements[0].chosenShownAs, 'B')
  assert.equal(model.judgements[0].correct, false)
})

test('records that are not RM-R1 logs are counted in the notes, not dropped silently', () => {
  const model = parse([fileOf('mixed.json', [null, 3, 'x', [], {}, rewardBenchRecord()])])
  assert.equal(model.judgements.length, 1)
  assert.equal(model.judgements[0].id, 'mixed.json:5', 'the index is the position in the file')
  assert.ok(hasNote(model.notes, '5 records matched no RM-R1 log format'))
})

/* ------------------------------------------------------------- record links */

test('record ids carry no "#", so a deep link survives a URL', () => {
  const model = parse([
    fileOf('logs.json', Array.from({ length: 3 }, () => rewardBenchRecord())),
    fileOf('total_dataset_1_M.json', [rmBenchRecord()]),
  ])
  for (const one of model.judgements) assert.ok(!one.id.includes('#'), `id has a '#': ${one.id}`)

  const url = new URL(`https://example.org/agentlens/?demo=rm-r1&record=${judgementId('logs.json', 2)}`)
  assert.equal(url.hash, '')
  assert.equal(url.searchParams.get('record'), 'logs.json:2')
  assert.equal(judgementIndexFor(model, url.searchParams.get('record') ?? undefined), 2)
})

test('a two-part RM-Bench link lands on style 0 rather than nowhere', () => {
  const model = parse([fileOf('total_dataset_1_M.json', [rmBenchRecord(), rmBenchRecord()])])
  assert.equal(judgementIndexFor(model, 'total_dataset_1_M.json:1:2'), 5)
  assert.equal(judgementIndexFor(model, 'total_dataset_1_M.json:1'), 3)
  assert.equal(judgementIndexFor(model, '1'), 3, 'a bare index still resolves with one file loaded')
})

test('a miss is -1, never a wrong judgement', () => {
  const model = parse([fileOf('logs.json', [rewardBenchRecord()])])
  // What `?record=logs.json#0` collapses to once the browser eats the fragment.
  assert.equal(judgementIndexFor(model, 'logs.json'), -1)
  assert.equal(judgementIndexFor(model, 'logs.json:9999'), -1)
  assert.equal(judgementIndexFor(model, ''), -1)
  assert.equal(judgementIndexFor(model, undefined), -1)
})

test('files that share a name get distinct id spaces', () => {
  // A result directory holds three different files called logs.json.
  const model = parse([
    fileOf('logs.json', [rewardBenchRecord()]),
    fileOf('logs.json', [rmbPairwiseRecord()]),
  ])
  assert.deepEqual(model.judgements.map((one) => one.id), ['logs.json:0', 'logs.json~2:0'])
  assert.equal(new Set(model.judgements.map((one) => one.id)).size, 2)
  assert.equal(judgementIndexFor(model, '0'), -1, 'a bare index is ambiguous with two files')
  assert.ok(hasNote(model.notes, 'share a name'))
})

/* ------------------------------------------------------------------- notes */

test('a salvaged file is named in the notes, because it is not a clean parse', () => {
  const model = parse([
    fileOf('group_by_same_id_logs.json', [rmbBonRecord(), rmbBonRecord()], {
      salvaged: true,
      shape: 'json-object',
      problems: [{ at: 20204, kind: 'malformed-json', excerpt: { en: 'trailing comma: }', zh: '多了一个逗号: }' } }],
    }),
  ])
  assert.equal(model.judgements.length, 2)
  const note = noteMatching(model.notes, 'group_by_same_id_logs.json')
  assert.ok(note?.en.includes('salvage mode'))
  assert.ok(note?.en.includes('2 records'))
  // The file name and the count are the data's; they read the same either way.
  assert.ok(note?.zh.includes('group_by_same_id_logs.json'))
  assert.ok(note?.zh.includes('2 '))
})

test('fewer than three RM-Bench style files means no matrix, and says so', () => {
  const model = parse([
    fileOf('total_dataset_1_M.json', [rmBenchRecord()]),
    fileOf('total_dataset_3_M.json', [rmBenchRecord()]),
  ])
  assert.equal(model.rmBench, undefined)
  assert.ok(hasNote(model.notes, 'only style files 1, 3'))
  assert.deepEqual(model.runs, [], 'the pairings of one model are one run, not two')
})

test('two models’ style files are two runs, which is what the compare view needs', () => {
  const model = parse([
    fileOf('total_dataset_1_A.json', [rmBenchRecord()]),
    fileOf('total_dataset_2_A.json', [rmBenchRecord()]),
    fileOf('total_dataset_1_B.json', [rmBenchRecord()]),
  ])
  assert.deepEqual(model.runs, [
    {
      run: '',
      benchmark: 'rm-bench',
      files: ['total_dataset_1_A.json', 'total_dataset_2_A.json'],
      fileName: 'total_dataset_{1,2,3}_A.json',
      count: 6,
    },
    {
      run: '',
      benchmark: 'rm-bench',
      files: ['total_dataset_1_B.json'],
      fileName: 'total_dataset_{1,2,3}_B.json',
      count: 3,
    },
  ])
})

/* --------------------------------------------------------- official scores */

test('the score files are read, misspelling and all, minus the checkpoint name', () => {
  const model = parse([
    fileOf('main_score.json', [{ Chat: 0.95, 'Chat Hard': 0.83, Safety: 0.91, Reasoning: 0.95, absoluate_Result: 0.92 }], { shape: 'json-object' }),
    fileOf('each_small_section_score.json', [{ model: 'org/secret-run-name', model_type: 'Generative RM', chat_template: null, 'hep-go': 0.96 }], { shape: 'json-object' }),
    fileOf('logs.json', [rewardBenchRecord()]),
  ])
  // Files dropped loose name no run, so they are one unattributed group — and
  // with a single run loaded they are that run's.
  assert.equal(model.officialScores.length, 1)
  assert.deepEqual(model.officialScores[0].run, '')
  assert.deepEqual(model.officialScores[0].sources, ['main_score.json', 'each_small_section_score.json'])
  const scores = officialScoresFor(model, 'logs.json')?.scores
  // Their spelling of `absoluate_Result` is read, never corrected.
  assert.equal(scores?.sections?.absoluate_Result, 0.92)
  assert.equal(scores?.sections?.['Chat Hard'], 0.83)
  assert.deepEqual(scores?.perSubset, { 'hep-go': 0.96 })
  for (const field of DROPPED_SCORE_FIELDS) {
    assert.ok(!Object.hasOwn(scores?.perSubset ?? {}, field), `${field} reached perSubset`)
    assert.ok(!Object.hasOwn(scores?.sections ?? {}, field), `${field} reached sections`)
  }
})

test('a checkpoint name in `model` cannot reach the model at all', () => {
  // The released each_small_section_score.json puts an internal training-run
  // name in `model` — a checkpoint and the recipe of the data it was trained on.
  // It is not ours to redistribute, so nothing in the parsed model may carry it,
  // and the string below stands in for it: the real one is not in this
  // repository either, which is the same rule applied to the test.
  const secret = 'org-x/internal_recipe_name_v3'
  const model = parse([
    fileOf('each_small_section_score.json', [{ model: secret, model_type: 'Generative RM', chat_template: null, 'hep-go': 0.96 }], { shape: 'json-object' }),
    fileOf('logs.json', [rewardBenchRecord()]),
  ])
  assert.ok(!JSON.stringify(model).includes(secret), 'a checkpoint name reached the model')
  assert.ok(!JSON.stringify(model).includes('Generative RM'))

  const note = noteMatching(model.notes, 'This view does not read that field')
  assert.ok(note, 'the reader is not told what happened to the field')
  // The promise is about what AgentLens does with the field. It cannot be about
  // the reader's screen: this note fires on a file the reader dropped
  // themselves, where the name is already in front of them and the shell's raw
  // record browser will show it on request.
  for (const side of [note.en, note.zh]) {
    assert.ok(!/never displayed|不(会)?显示|永不/.test(side), side)
  }
  assert.ok(note.zh.includes('`model`') && note.zh.includes('`chat_template`'), note.zh)
})

test('two runs’ score files are kept apart, never merged', () => {
  const model = parse([fileOf('rm-r1-compare.json', [twoRunBundle()], { shape: 'json-object' })])

  assert.deepEqual(
    model.officialScores.map((one) => [one.run, one.scores.sections?.Chat]),
    [
      ['run-A', 0.95],
      ['run-B', 0.8],
    ],
    'the second run’s score file must not overwrite the first',
  )
  // Either name reaches it: the run id, or a file label minted with that prefix.
  assert.equal(officialScoresFor(model, 'run-B')?.scores.sections?.Chat, 0.8)
  assert.equal(officialScoresFor(model, 'run-A/logs.json')?.scores.sections?.Chat, 0.95)
  assert.equal(runIdOf('run-A/logs.json'), 'run-A')
  assert.equal(runIdOf('logs.json'), 'logs.json')
})

test('an unattributable score file is shown to nobody rather than to whoever loaded last', () => {
  // Two checkpoints' RewardBench logs are both called `logs.json`, and so are
  // both their score files. Nothing in a dropped file says which is which.
  const model = parse([
    fileOf('logs.json', [rewardBenchRecord()]),
    fileOf('logs.json', [rewardBenchRecord()]),
    fileOf('main_score.json', [mainScore(0.95)], { shape: 'json-object' }),
  ])
  assert.equal(model.officialScores.length, 1)
  assert.equal(officialScoresFor(model, 'logs.json'), undefined)
  assert.equal(officialScoresFor(model, 'logs.json~2'), undefined)
})

test('two score files that disagree about one slot withhold it, whichever came last', () => {
  const model = parse([
    fileOf('logs.json', [rewardBenchRecord()]),
    fileOf('main_score.json', [mainScore(0.95)], { shape: 'json-object' }),
    fileOf('main_score.json', [mainScore(0.8)], { shape: 'json-object' }),
  ])
  assert.equal(officialScoresFor(model, 'logs.json')?.scores.sections, undefined)
  assert.ok(hasNote(model.notes, 'neither is shown'))

  // The same file twice is not a disagreement.
  const twice = parse([
    fileOf('logs.json', [rewardBenchRecord()]),
    fileOf('main_score.json', [mainScore(0.95)], { shape: 'json-object' }),
    fileOf('main_score.json', [mainScore(0.95)], { shape: 'json-object' }),
  ])
  assert.equal(officialScoresFor(twice, 'logs.json')?.scores.sections?.Chat, 0.95)
  assert.ok(!hasNote(twice.notes, 'neither is shown'))
})

test('the RM-Bench summary is compared against its own run’s published file or none', () => {
  const styleFiles = [1, 2, 3].map((n) =>
    fileOf(`total_dataset_${n}_M.json`, [rmBenchRecord(), rmBenchRecord({ id: 'math/1', domain: 'math' })]),
  )
  const finalResult = (hard: number) => ({
    chat: 0.7,
    math: 0.8,
    code: 0.6,
    safety: 0.9,
    hard_acc: hard,
    normal_acc: 0.8,
    easy_acc: 0.86,
    total_avg_acc: 0.79,
  })
  const one = parse([...styleFiles, fileOf('final_result.json', [finalResult(0.7)], { shape: 'json-object' })])
  assert.equal(one.rmBench?.official?.hard_acc, 0.7)

  // Two runs' final_result.json dropped together: neither is this matrix's.
  const two = parse([
    ...styleFiles,
    fileOf('final_result.json', [finalResult(0.7)], { shape: 'json-object' }),
    fileOf('final_result.json', [finalResult(0.66)], { shape: 'json-object' }),
  ])
  assert.equal(two.rmBench?.official, undefined, 'a published summary that cannot be attributed is not shown')
  assert.ok(hasNote(two.notes, 'neither is shown'))
})

/* ---------------------------------------------------------------- outcomes */

test('every record’s outcome is exposed per run, so a number can carry the benchmark’s name', () => {
  const model = parse([fileOf('rm-r1-compare.json', [twoRunBundle()], { shape: 'json-object' })])
  const sets = outcomesFor(model, 'rewardbench')
  assert.equal(sets.length, 2, 'one outcome set per run; pooling them would describe neither')
  assert.deepEqual(sets.map((set) => set.run), ['run-A', 'run-B'])
  assert.deepEqual(sets.map((set) => set.files), [['run-A/logs.json'], ['run-B/logs.json']])
  assert.ok(sets.every((set) => set.complete))

  // Six records each, not the two whose text is packed.
  assert.deepEqual(sets.map((set) => [set.total, set.correct, set.unrecorded]), [
    [6, 3, 0],
    [6, 3, 1],
  ])
  assert.deepEqual(sets[0].groups, [
    { group: 'alpacaeval-easy', total: 3, correct: 2, unrecorded: 0 },
    { group: 'math-prm', total: 3, correct: 1, unrecorded: 0 },
  ])
  assert.deepEqual(sets[1].groups, [
    { group: 'alpacaeval-easy', total: 3, correct: 1, unrecorded: 0 },
    { group: 'math-prm', total: 3, correct: 2, unrecorded: 1 },
  ])
  // The sample is 2 records and would give 1/2 and 2/2 — the reason the tables
  // exist at all.
  assert.equal(model.judgements.length, 4)

  assert.deepEqual(outcomesFor(model, 'rewardbench', 'run-B/logs.json').map((set) => set.run), ['run-B'])
  assert.deepEqual(outcomesFor(model, 'rm-bench'), [])
})

test('the agreement matrix pairs two runs over every record, and counts what did not pair', () => {
  const model = parse([fileOf('rm-r1-compare.json', [twoRunBundle()], { shape: 'json-object' })])
  const [a, b] = outcomesFor(model, 'rewardbench')
  const agreement = agreeOutcomes(a, b)
  assert.equal(agreement.aligned, 6)
  assert.deepEqual(agreement.counts, {
    'both-right': 2,
    'run1-only': 1,
    'run2-only': 1,
    'both-wrong': 1,
    indeterminate: 1,
  })
  assert.deepEqual(
    [agreement.determinate, agreement.oneRight, agreement.twoRight],
    [5, 3, 3],
    'the two rates share one denominator, and it excludes the unrecorded pair',
  )
  assert.deepEqual([agreement.onlyInRun1, agreement.onlyInRun2], [0, 0])

  // A run that scored half the benchmark aligns on half of it, and says so.
  const half = { ...b, records: b.records.slice(0, 3) }
  assert.deepEqual(
    [agreeOutcomes(a, half).aligned, agreeOutcomes(a, half).onlyInRun1, agreeOutcomes(a, half).onlyInRun2],
    [3, 3, 0],
  )
})

test('an RM-Bench table is nine outcomes per record, keyed by pairing', () => {
  const bundle = {
    agentlens_format: 'rm-r1@1',
    runs: [
      {
        run_id: 'run-A',
        logs: [],
        outcome_tables: [
          {
            benchmark: 'rm-bench',
            complete: true,
            columns: ['source_index', 'id', 'domain', 'result_1', 'result_2', 'result_3'],
            rows: [
              [0, 'chat/100', 'chat', [1, 1, 1], [0, 1, 1], [0, 1, 1]],
              [1, 'math/1', 'math', [1, 0, 1], [1, 1, 1], [0, 0, 1]],
            ],
          },
        ],
      },
    ],
  }
  const [set] = outcomesFor(parse([fileOf('p.json', [bundle], { shape: 'json-object' })]), 'rm-bench')
  assert.equal(set.total, 2 * 9)
  assert.equal(set.correct, 7 + 6)
  assert.deepEqual(set.groups, [
    { group: 'chat', total: 9, correct: 7, unrecorded: 0 },
    { group: 'math', total: 9, correct: 6, unrecorded: 0 },
  ])
  // `<record>:<file>:<slot>` — the same nine questions in the other run.
  assert.deepEqual(set.records.slice(0, 4).map((one) => one.key), ['0:1:0', '0:1:1', '0:1:2', '0:2:0'])
  assert.equal(set.records[0].id, 'chat/100')
})

test('the coverage note is per run, with that run’s own numerator', () => {
  const model = parse([fileOf('rm-r1-compare.json', [twoRunBundle()], { shape: 'json-object' })])
  const coverage = model.notes.filter((note) => note.en.includes('full text of'))
  assert.equal(coverage.length, 2, 'one note per run; two runs collapsed into one note names neither')
  for (const run of ['run-A', 'run-B']) {
    const note = coverage.find((one) => one.en.startsWith(`${run} — `))
    assert.ok(note, `no coverage note for ${run}`)
    // 2 of 6 for each run — not 4 of 6, which is both runs over one denominator.
    assert.ok(note.en.includes('all 6 records and the full text of 2 of them'), note.en)
    // The run it belongs to and both counts are the data's, so the Chinese
    // states the same three numbers about the same run.
    assert.ok(note.zh.startsWith(`${run} — `), note.zh)
    assert.ok(note.zh.includes('6') && note.zh.includes('2'), note.zh)
  }
})

/* ------------------------------------------------------------------ bundles */

test('a demo bundle expands back into the files it packed', () => {
  const model = parse([
    fileOf(
      'rm-r1-demo.json',
      [
        {
          agentlens_format: 'rm-r1@1',
          files: [
            { fileName: 'logs.json', records: [rewardBenchRecord(), rewardBenchRecord()], indices: [7, 91] },
            { fileName: 'raw_logs.json', records: [rmbBonRecord()] },
          ],
          notes: ['Sampled from the released 32B logs.'],
        },
      ],
      { shape: 'json-object' },
    ),
  ])
  assert.equal(sniff('rm-r1-demo.json', [{ agentlens_format: 'rm-r1@1', files: [] }]), 1)
  // `indices` keeps the original positions, so a link built against the dropped
  // file and one built against the demo are the same link.
  assert.deepEqual(model.judgements.map((one) => one.id), ['logs.json:7', 'logs.json:91', 'raw_logs.json:0'])
  // A package's own sentence is the package's words: shown as it arrived, in
  // both languages, because translating somebody's claim misquotes them.
  assert.ok(
    model.notes.some(
      (note) => note.en === 'Sampled from the released 32B logs.' && note.zh === note.en,
    ),
  )
})

/* ------------------------------------------------- bilingual by type, not by care */

/**
 * The notes are where the honesty disclosure lives, so a note that exists in one
 * language is a disclosure half the readers cannot read. `Str` makes that a
 * compile error; this makes a copy-paste Chinese one a test failure.
 */
test('every note the adapter writes carries both languages, and neither is the other', () => {
  const model = parse([
    fileOf('logs.json', [rewardBenchRecord(), 3]),
    fileOf('logs.json', [rmbPairwiseRecord()]),
    fileOf('raw_logs.json', [rmbBonRecord()]),
    fileOf('group_by_same_id_logs.json', [rmbBonRecord()], {
      salvaged: true,
      problems: [{ at: 20204, kind: 'malformed-json', excerpt: { en: 'trailing comma: }', zh: '多了一个逗号: }' } }],
    }),
    fileOf('total_dataset_1_M.json', [rmBenchRecord()]),
    fileOf('main_score.json', [mainScore(0.95)], { shape: 'json-object' }),
    fileOf('main_score.json', [mainScore(0.8)], { shape: 'json-object' }),
    fileOf('each_small_section_score.json', [{ model: 'org-x/internal_recipe_name_v3', model_type: 'Generative RM', chat_template: null, 'hep-go': 0.96 }], {
      shape: 'json-object',
    }),
  ])

  assert.ok(model.notes.length >= 8, `only ${model.notes.length} notes reached the model`)
  for (const note of model.notes) {
    assert.ok(note.en.trim() !== '' && note.zh.trim() !== '', JSON.stringify(note))
    // Nothing in this drop is a package, so every note is AgentLens's own words:
    // a Chinese side equal to the English is an English wall with a `zh` on it.
    assert.notEqual(note.zh, note.en, note.en)
    assert.ok(/[\u4e00-\u9fff]/.test(note.zh), note.zh)
  }
})

/* -------------------------------------------- the package's own disclosure */

/** The shape `scripts/build-demo-data/rm-r1.mjs` writes, cut down to one of each. */
function disclosingBundle(): Record<string, unknown> {
  return {
    agentlens_format: 'rm-r1@1',
    sampling: {
      deterministic: true,
      method: 'stratified systematic sampling over source file order; no RNG, no seed',
      rules: ['10 records from each of the 23 subsets, of which up to 4 are wrong.', ''],
      hand_picked: [
        {
          run_id: 'run-A',
          source_path: 'run-A/reward_bench/log_result/logs.json',
          source_index: 498,
          subset: 'llmbar-adver-neighbor',
          record_id: 'logs.json:498',
          why: 'the whole Chain-of-Rubrics shape in about 3 KB',
        },
      ],
      withheld: [{ source_path: 'run-A/RMB/BoN_set_Harmlessness/log_result/raw_logs.json', records: 2, reason: 'content' }],
      excluded: [{ source_path: 'run-A/RM-Bench/logs/final_result.json', reason: 'byte-identical duplicate' }],
      truncated: [
        {
          source_path: 'run-A/reward_bench/log_result/logs.json',
          source_index: 308,
          record_id: 'logs.json:308',
          field: 'answers',
          original_bytes: 44259,
          kept_bytes: 18118,
        },
      ],
    },
    coverage: [
      {
        figure: 'RewardBench accuracy by subset (all 23)',
        basis: 'full benchmark',
        denominator: 2985,
        from: 'runs[].outcome_tables[benchmark="rewardbench"]',
        note: 'Reproduces the run own each_small_section_score.json exactly.',
      },
      { basis: 'this sample', denominator: 40 },
    ],
    runs: [
      {
        run_id: 'run-A',
        logs: [{ source_path: 'run-A/reward_bench/log_result/logs.json', records: [rewardBenchRecord()] }],
      },
    ],
  }
}

test('the package\'s sampling rule and coverage reach the model, typed', () => {
  const model = parse([fileOf('package.json', [disclosingBundle()], { shape: 'json-object' })])

  const sampling = model.sampling
  assert.ok(sampling, 'the disclosure the builder wrote never reached the view')
  assert.equal(sampling.deterministic, true)
  // This fixture writes its disclosure as bare strings, which is what a package
  // built before the bilingual format — or by somebody else — carries. It still
  // opens, and the one language it has is shown to both readerships: translating
  // a claim its author made would misquote them, dropping it would delete the
  // disclosure to punish its author.
  assert.match(sampling.method?.en ?? '', /no RNG, no seed/)
  assert.equal(sampling.method?.zh, sampling.method?.en)
  assert.deepEqual(sampling.rules, [
    {
      en: '10 records from each of the 23 subsets, of which up to 4 are wrong.',
      zh: '10 records from each of the 23 subsets, of which up to 4 are wrong.',
    },
  ])
  assert.equal(sampling.handPicked.length, 1)
  // The deep-link id is what makes a hand-picked record checkable rather than
  // merely declared: a reader can open exactly the record that was chosen.
  assert.equal(sampling.handPicked[0].recordId, 'logs.json:498')
  assert.equal(sampling.handPicked[0].sourceIndex, 498)
  assert.equal(sampling.withheld[0].records, 2)
  assert.equal(sampling.excluded[0].sourcePath, 'run-A/RM-Bench/logs/final_result.json')
  assert.equal(sampling.truncated[0].recordId, 'logs.json:308')
  assert.deepEqual(
    [sampling.truncated[0].originalBytes, sampling.truncated[0].keptBytes],
    [44259, 18118],
  )

  assert.equal(model.coverage.length, 1, 'a denominator attached to no figure is not a disclosure')
  assert.equal(model.coverage[0].denominator, 2985)
  assert.equal(model.coverage[0].basis?.en, 'full benchmark')
})

test('two packages in one drop do not have their samples merged', () => {
  const second = disclosingBundle()
  ;(second.sampling as Record<string, unknown>).rules = ['A different rule, from a different package.']
  const model = parse([
    fileOf('first.json', [disclosingBundle()], { shape: 'json-object' }),
    fileOf('second.json', [second], { shape: 'json-object' }),
  ])
  assert.deepEqual(model.sampling?.rules, [
    {
      en: '10 records from each of the 23 subsets, of which up to 4 are wrong.',
      zh: '10 records from each of the 23 subsets, of which up to 4 are wrong.',
    },
  ])
  assert.equal(model.coverage.length, 1, 'two packages\' denominators must not be pooled')
  assert.ok(hasNote(model.notes, 'second.json declares a sample of its own'))
})

test('a dropped log claims no sampling and no coverage, because nobody said it was a sample', () => {
  const model = parse([fileOf('logs.json', [rewardBenchRecord()])])
  assert.equal(model.sampling, undefined)
  assert.deepEqual(model.coverage, [])
})

/* ------------------------------------------------------------ what a run is */

test('one checkpoint written into several files is one run, not several', () => {
  const model = parse([
    fileOf(
      'package.json',
      [
        {
          agentlens_format: 'rm-r1@1',
          runs: [
            {
              run_id: 'RM-R1-Qwen2.5-Instruct-32B',
              logs: [
                { source_path: 'x/reward_bench/log_result/logs.json', records: [rewardBenchRecord()] },
                { source_path: 'x/RMB/BoN_set_Helpfulness/log_result/raw_logs.json', records: [rmbBonRecord()] },
                { source_path: 'x/RM-Bench/logs/total_dataset_1_M.json', records: [rmBenchRecord()] },
                { source_path: 'x/RM-Bench/logs/total_dataset_2_M.json', records: [rmBenchRecord()] },
                { source_path: 'x/RM-Bench/logs/total_dataset_3_M.json', records: [rmBenchRecord()] },
              ],
            },
          ],
        },
      ],
      { shape: 'json-object' },
    ),
  ])
  // Five files, four benchmarks, one checkpoint. A Run 2 picker built from this
  // would offer this run its own files and call the result a comparison.
  assert.deepEqual(model.runs, [], 'a run is not two runs because it has two files')
})

test('two checkpoints of one benchmark are two runs, and their files travel with them', () => {
  const model = parse([fileOf('rm-r1-compare.json', [twoRunBundle()], { shape: 'json-object' })])
  assert.deepEqual(
    model.runs.map((run) => [run.run, run.benchmark, run.files]),
    [
      ['run-A', 'rewardbench', ['run-A/logs.json']],
      ['run-B', 'rewardbench', ['run-B/logs.json']],
    ],
  )
})

/* ---------------------------------------------------------------- real logs */

test('the released RewardBench log normalises whole', { skip: unless(REWARD_BENCH) }, () => {
  const model = parse([load(REWARD_BENCH)])
  assert.equal(model.judgements.length, 2985)
  assert.deepEqual(model.benchmarks, ['rewardbench'])
  assert.equal(model.groups.length, 23)
  assert.equal(new Set(model.judgements.map((one) => one.id)).size, 2985)
  assert.equal(model.judgements.filter((one) => one.correct === null).length, 0)
  assert.equal(model.judgements.filter((one) => one.cor.degraded).length, 11)
  // Nothing was invented: every judgement carries the two conversations it came with.
  assert.equal(model.judgements.filter((one) => one.chosen.length === 0).length, 0)
})

test(
  'the released score files parse without the checkpoint name',
  { skip: unless(MAIN_SCORE, SUBSET_SCORE, REWARD_BENCH) },
  () => {
    const model = parse([load(MAIN_SCORE), load(SUBSET_SCORE), load(REWARD_BENCH)])
    const scores = officialScoresFor(model, 'logs.json')?.scores
    assert.equal(Object.keys(scores?.perSubset ?? {}).length, 23)
    assert.equal(scores?.sections?.absoluate_Result, 0.9293132328308208)

    // The forbidden string is read out of the file rather than written here, so
    // the checkpoint name this asserts about stays out of the repository while
    // the assertion is made against the real one.
    const named = JSON.parse(fs.readFileSync(SUBSET_SCORE as string, 'utf8')) as Record<string, unknown>
    const checkpoint = typeof named.model === 'string' ? named.model : ''
    assert.ok(checkpoint.length > 8, 'the released score file no longer names a checkpoint in `model`')
    assert.ok(!JSON.stringify(model).includes(checkpoint), 'the checkpoint name reached the model')
  },
)

test(
  'the recomputed RM-Bench matrix reproduces the shipped one when it reproduces the bug',
  { skip: unless(...RM_BENCH, RM_BENCH_RESULT) },
  () => {
    const model = parse([...RM_BENCH.map(load), load(RM_BENCH_RESULT)])
    const summary = model.rmBench
    assert.ok(summary, 'three style files must yield a matrix')
    const bug = summary.reproducedOfficial
    assert.ok(bug, 'and the reproduction of the shipped computation')
    const official = summary.official as Record<string, number>

    // 1. Running process_final_result.py's own assembly, with data2 read from
    //    total_dataset_3 as that script does, reproduces final_result.json on
    //    all eight metrics — bit-for-bit as of this corpus; the tolerance is
    //    only there so a change of summation order is not a red build. That
    //    reproduction is what licenses the claim below.
    const reproduced: Record<string, number> = {
      hard_acc: bug.overall.hard,
      normal_acc: bug.overall.normal,
      easy_acc: bug.overall.easy,
      total_avg_acc: bug.totalAverage,
    }
    for (const domain of bug.domains) reproduced[domain.domain] = domain.average
    for (const [key, value] of Object.entries(reproduced)) {
      assert.ok(Math.abs(value - official[key]) < 1e-12, `${key}: ${value} vs shipped ${official[key]}`)
    }

    // 2. With data2 read from total_dataset_2, three cells stop collapsing onto
    //    their neighbours. `normal` is read from total_dataset_1 alone, so it
    //    cannot move — and it does not. That signature is what makes the
    //    difference checkable rather than a matter of trust.
    assert.equal(bug.overall.cells[0][1], bug.overall.cells[0][2])
    assert.equal(bug.overall.cells[1][2], bug.overall.cells[1][0])
    assert.equal(bug.overall.cells[2][0], bug.overall.cells[2][1])
    assert.equal(summary.overall.normal, bug.overall.normal)
    assert.notEqual(summary.overall.hard, bug.overall.hard)
    assert.notEqual(summary.overall.easy, bug.overall.easy)

    // 3. The corrected numbers, to two decimals, as recomputed from these logs.
    const pct = (value: number) => Number((value * 100).toFixed(2))
    assert.equal(pct(summary.overall.hard), 67.23)
    assert.equal(pct(summary.overall.normal), 80.51)
    assert.equal(pct(summary.overall.easy), 88.18)
    assert.equal(pct(summary.totalAverage), 78.64)
    assert.deepEqual(
      summary.domains.map((one) => [one.domain, pct(one.average)]),
      [
        ['chat', 74.94],
        ['math', 80.24],
        ['code', 65.79],
        ['safety', 93.6],
      ],
    )
    // hard_acc as shipped is 3.26 points higher than the logs support.
    assert.equal(pct(bug.overall.hard - summary.overall.hard), 3.26)

    assert.equal(model.judgements.length, 1327 * 3 * 3)
    assert.deepEqual(model.runs, [], 'three style files of one model are one run')
  },
)

test('a whole result directory is claimed, and every judgement in it is unique', { skip: unless(REWARD_BENCH, ...RM_BENCH) }, () => {
  const files = [load(REWARD_BENCH), ...RM_BENCH.map(load)]
  const scores = files.map((file) => sniff(file.fileName, file.records.slice(0, 5).map((r) => r.value)))
  assert.ok(Math.min(...scores) > 0.9)

  const model: RmR1Model = parse(files)
  assert.equal(new Set(model.judgements.map((one) => one.id)).size, model.judgements.length)
  assert.deepEqual(model.benchmarks, ['rewardbench', 'rm-bench'])
})
