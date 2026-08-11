/**
 * Tests for the Chain-of-Rubrics parser. `node --test src/adapters/rm-r1/cor.test.ts`.
 *
 * cor.ts reads one language model's raw output, so the interesting cases are all
 * malformations. The synthetic ones below are copied from records that are
 * actually in the released 32B log, and the last block runs the parser over all
 * 2,985 of them when AGENTLENS_REAL_LOGS points at that directory — a parser
 * that only ever sees hand-written fixtures has not met this input.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { corEvalSegments, parseCor, parseCorDetailed } from './cor.ts'
import type { CorDocument } from './contract.ts'

/* ------------------------------------------------- real logs, when available */

const REAL_LOGS = process.env.AGENTLENS_REAL_LOGS
const REAL_LOGS_HINT =
  'set AGENTLENS_REAL_LOGS to the RM-R1 eval result directory (the one holding reward_bench/, RM-Bench/, RMB/)'

function realLog(relative: string): string | null {
  if (!REAL_LOGS) return null
  const full = path.join(REAL_LOGS, relative)
  return fs.existsSync(full) ? full : null
}

const REWARD_BENCH = realLog('reward_bench/log_result/logs.json')

/** node prints the reason next to a skipped test, so a missing corpus is never silent. */
function unless(file: string | null): string | undefined {
  return file ? undefined : REAL_LOGS_HINT
}

interface RewardBenchRecord {
  answers: string
  results: number
  Is_Chosen_Answer_Shuffled_toPositionB: boolean
}

function rewardBench(): RewardBenchRecord[] {
  return JSON.parse(fs.readFileSync(REWARD_BENCH as string, 'utf8')) as RewardBenchRecord[]
}

/* ---------------------------------------------------------------- fixtures */

const CHAT = `<type>Chat</type>

<rubric>
1. Accuracy (60%): is it right?
- sub-point that hangs under 1
2. Clarity (40%): is it readable?

<justify>
Accuracy dominates because the client asked a factual question.
</justify>
</rubric>

<eval>
On accuracy:
<quote_A>A says the sky is green.</quote_A>
That is wrong.
<summary_B>Chatbot B gives the correct colour and a reason.</summary_B>
</eval>

<answer>[[B]]</answer>`

const REASONING = `<type>Reasoning</type>

<solution>
2 + 2 = 4.
</solution>

<eval>
<quote_B>B answers 5.</quote_B>
</eval>

<answer>[[A]]</answer>`

/** Structural invariants a view is allowed to assume no matter what went in. */
function assertIsCorDocument(doc: unknown, raw: string): asserts doc is CorDocument {
  assert.equal(typeof doc, 'object')
  assert.notEqual(doc, null)
  const one = doc as CorDocument
  assert.ok(['chat', 'reasoning', 'unknown'].includes(one.route))
  assert.ok(Array.isArray(one.criteria) && one.criteria.every((c) => typeof c === 'string'))
  assert.ok(Array.isArray(one.evidence))
  for (const span of one.evidence) {
    assert.ok(span.side === 'A' || span.side === 'B')
    assert.ok(span.kind === 'quote' || span.kind === 'summary')
    assert.equal(typeof span.text, 'string')
  }
  assert.ok(one.verdict === 'A' || one.verdict === 'B' || one.verdict === null)
  assert.equal(typeof one.ambiguous, 'boolean')
  assert.equal(typeof one.degraded, 'boolean')
  assert.equal(one.raw, raw)
}

/* -------------------------------------------------------------- happy paths */

test('a chat-route document parses into its parts', () => {
  const doc = parseCor(CHAT)
  assert.equal(doc.route, 'chat')
  assert.equal(doc.degraded, false)
  assert.equal(doc.verdict, 'B')
  assert.equal(doc.ambiguous, false)
  // One criterion per line, verbatim, sub-bullets included — the weights live in that text.
  assert.deepEqual(doc.criteria, [
    '1. Accuracy (60%): is it right?',
    '- sub-point that hangs under 1',
    '2. Clarity (40%): is it readable?',
  ])
  assert.match(doc.justification as string, /^Accuracy dominates/)
  assert.equal(doc.solution, undefined)
  assert.deepEqual(doc.evidence, [
    { side: 'A', kind: 'quote', text: 'A says the sky is green.' },
    { side: 'B', kind: 'summary', text: 'Chatbot B gives the correct colour and a reason.' },
  ])
})

test('the eval prose keeps the quoted text but not the tags', () => {
  const doc = parseCor(CHAT)
  const evaluation = doc.evaluation as string
  assert.ok(!evaluation.includes('<quote_A>'), 'a view would render the raw tag to the reader')
  assert.ok(evaluation.includes('A says the sky is green.'), 'the quoted text must survive')
  assert.ok(evaluation.includes('That is wrong.'))
})

test('eval segments interleave prose and marked spans, in order', () => {
  assert.deepEqual(
    corEvalSegments(parseCor(CHAT)).map((s) =>
      s.kind === 'text' ? ['text', s.text.trim()] : ['span', s.evidence.side, s.evidence.kind],
    ),
    [
      ['text', 'On accuracy:'],
      ['span', 'A', 'quote'],
      ['text', 'That is wrong.'],
      ['span', 'B', 'summary'],
    ],
  )
})

test('the reasoning route carries a solution and no rubric', () => {
  const doc = parseCor(REASONING)
  assert.equal(doc.route, 'reasoning')
  assert.equal(doc.solution, '2 + 2 = 4.')
  assert.deepEqual(doc.criteria, [])
  assert.equal(doc.justification, undefined)
  assert.equal(doc.verdict, 'A')
  assert.equal(doc.degraded, false)
})

/* ------------------------------------------------------------ malformations */

test('a doubled </answer> closes nothing, so the document is not degraded', () => {
  // Verbatim shape of RewardBench record 2 and 116 others.
  const { doc, issues } = parseCorDetailed(`${CHAT}\n</answer>`)
  assert.equal(doc.verdict, 'B')
  assert.equal(doc.criteria.length, 3)
  assert.equal(doc.evidence.length, 2)
  assert.equal(doc.degraded, false, 'raw is NOT all a view can trust here; everything parsed')
  assert.deepEqual(
    issues.map((i) => [i.kind, i.tag]),
    [['stray-close', 'answer']],
    'the malformation is still reported, so a view can badge it',
  )
})

test('an unclosed tag ends at the next section rather than swallowing the rest', () => {
  const raw = `<type>Reasoning</type>
<solution>
never closed
<eval>the evaluation</eval>
<answer>[[A]]</answer>`
  const { doc, issues } = parseCorDetailed(raw)
  assert.equal(doc.solution, 'never closed')
  assert.equal(doc.evaluation, 'the evaluation')
  assert.equal(doc.verdict, 'A')
  assert.equal(doc.degraded, true)
  assert.deepEqual(issues.map((i) => i.kind), ['unclosed-tag'])
})

test('a truncated generation degrades and keeps the raw text', () => {
  const raw = `<type>Reasoning</type>\n<solution>x</solution>\n<eval>H2O + H2O + H2O`
  const doc = parseCor(raw)
  assert.equal(doc.degraded, true)
  assert.equal(doc.verdict, null)
  assert.equal(doc.raw, raw)
  assert.equal(doc.evaluation, 'H2O + H2O + H2O')
})

test('both [[A]] and [[B]] is no verdict, not the first one seen', () => {
  const doc = parseCor(`<type>Chat</type><eval>e</eval><answer>[[A]] or maybe [[B]]</answer>`)
  assert.equal(doc.ambiguous, true)
  assert.equal(doc.verdict, null)
  // Ambiguity is its own signal: the parse itself succeeded.
  assert.equal(doc.degraded, false)
})

test('a verdict outside <answer> is only read when there is no <answer> at all', () => {
  assert.equal(parseCor(`<type>Chat</type><eval>mentions [[B]]</eval>`).verdict, 'B')
  assert.equal(parseCor(`<type>Chat</type><eval>mentions [[B]]</eval><answer>[[A]]</answer>`).verdict, 'A')
})

test('missing structure degrades but still yields every field', () => {
  const doc = parseCor('the judge produced prose and no tags at all')
  assertIsCorDocument(doc, 'the judge produced prose and no tags at all')
  assert.equal(doc.route, 'unknown')
  assert.equal(doc.degraded, true)
})

test('non-strings never throw and never invent content', () => {
  for (const input of [undefined, null, 42, {}, [], NaN, Symbol('x')]) {
    const doc = parseCor(input)
    assertIsCorDocument(doc, '')
    assert.equal(doc.degraded, true)
    assert.equal(doc.verdict, null)
  }
})

test('tag names are matched loosely, prose that looks like markup is not', () => {
  assert.equal(parseCor('<TYPE>chat</TYPE><eval>e</eval><answer>[[A]]</answer>').route, 'chat')
  assert.equal(parseCor('<type>Chat</type><eval>e</eval><ANSWER>[[B]]</ANSWER>').verdict, 'B')
  // `<div>` is not ours; it must not open a frame or be stripped out of the prose.
  const doc = parseCor('<type>Chat</type><eval>use <div> tags</eval><answer>[[A]]</answer>')
  assert.equal(doc.degraded, false)
  assert.equal(doc.evaluation, 'use <div> tags')
})

/* -------------------------------------------------------------------- fuzz */

/** Deterministic, so a failure is reproducible from the seed printed in the name. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function mangle(raw: string, random: () => number): string {
  const how = Math.floor(random() * 5)
  const cut = Math.floor(random() * raw.length)
  if (how === 0) return raw.slice(0, cut) // truncated mid-anything
  if (how === 1) return raw.slice(cut) // head lost
  if (how === 2) return raw.split('\n').sort(() => random() - 0.5).join('\n') // shuffled lines
  if (how === 3) return raw.replace(/<\//g, '<') // every close tag becomes an open one
  return raw.slice(0, cut) + raw.slice(0, Math.floor(random() * raw.length)) // spliced
}

test('fuzzing real records never throws and always returns a CorDocument', { skip: unless(REWARD_BENCH) }, () => {
  const records = rewardBench()
  const random = lcg(20260811)
  for (let i = 0; i < 4000; i++) {
    const raw = mangle(records[Math.floor(random() * records.length)].answers, random)
    const doc = parseCor(raw)
    assertIsCorDocument(doc, raw)
    // Segmenting is a second pass over the same text; it must survive the same input.
    assert.ok(Array.isArray(corEvalSegments(doc)))
  }
})

test('fuzzing synthetic fixtures never throws', () => {
  const random = lcg(7)
  for (const fixture of [CHAT, REASONING, '', '<eval>', '</eval></eval>', '<answer>[[A]]']) {
    for (let i = 0; i < 500; i++) {
      const raw = mangle(fixture, random)
      assertIsCorDocument(parseCor(raw), raw)
    }
  }
})

/* --------------------------------------------------------------- real logs */

test('every released RewardBench record parses, and the counts are these', { skip: unless(REWARD_BENCH) }, () => {
  const records = rewardBench()
  assert.equal(records.length, 2985)

  const route = { chat: 0, reasoning: 0, unknown: 0 }
  let degraded = 0
  let noVerdict = 0
  let ambiguous = 0
  let strayCloseOnly = 0

  for (const record of records) {
    const { doc, issues } = parseCorDetailed(record.answers)
    route[doc.route] += 1
    if (doc.degraded) degraded += 1
    if (doc.verdict === null && !doc.ambiguous) noVerdict += 1
    if (doc.ambiguous) ambiguous += 1
    if (issues.length > 0 && issues.every((issue) => issue.kind === 'stray-close')) strayCloseOnly += 1
  }

  // The route split is the judge's own <type> decision, not ours.
  assert.deepEqual(route, { chat: 1382, reasoning: 1603, unknown: 0 })
  // 11 of 2,985 lose structure — every one of them by leaving a tag open; 7 of
  // those also close a tag out of order, 2 end with no verdict, 1 with no <eval>.
  assert.equal(degraded, 11)
  assert.equal(noVerdict, 2)
  // A view must not imply this is common: it has never happened in this corpus.
  assert.equal(ambiguous, 0)
  // The doubled-close malformation, which costs nothing and is reported anyway.
  assert.equal(strayCloseOnly, 175)
})

test(
  'the parsed verdict and the harness shuffle flag reproduce the harness result',
  { skip: unless(REWARD_BENCH) },
  () => {
    // An independent check on both halves at once: if we mis-read [[A]]/[[B]], or
    // mis-read Is_Chosen_Answer_Shuffled_toPositionB, this disagrees somewhere.
    let checked = 0
    for (const record of rewardBench()) {
      const doc = parseCor(record.answers)
      if (doc.verdict === null) continue
      const chosenShownAs = record.Is_Chosen_Answer_Shuffled_toPositionB ? 'B' : 'A'
      assert.equal(doc.verdict === chosenShownAs, record.results === 1)
      checked += 1
    }
    assert.equal(checked, 2983)
  },
)

test('the released rubrics survive as criteria', { skip: unless(REWARD_BENCH) }, () => {
  const chat = rewardBench()
    .map((record) => parseCor(record.answers))
    .filter((doc) => doc.route === 'chat')
  assert.equal(chat.length, 1382)
  assert.equal(chat.filter((doc) => doc.criteria.length === 0).length, 0)
  assert.equal(chat.filter((doc) => doc.justification === undefined).length, 0)
})
