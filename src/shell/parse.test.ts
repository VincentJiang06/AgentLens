/**
 * Tests for the pure parse core. `node --test src/shell/parse.test.ts`.
 *
 * parse.ts has no DOM, no Worker and no File, so node drives it directly — the
 * same functions parse.worker.ts calls, not a re-implementation.
 *
 * Two of the inputs below are real research logs that are far too large to keep
 * in this repo. They are read from disk only when AGENTLENS_REAL_LOGS points at
 * the RM-R1 eval result directory, and reported as skipped otherwise; a skipped
 * test is not a passing one. Everything else is synthetic, and the synthetic
 * damage is copied from what those files actually contain.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { detectShape, looksLikeRecordMap, parseStream, parseText } from './parse.ts'
import type { ParseOutcome } from './parse.ts'

/* ------------------------------------------------------------------ helpers */

/** The browser hands the worker ~64 KiB text chunks; several defects only show at a chunk size. */
const BROWSER_CHUNK = 64 * 1024

async function* chunked(text: string, size = BROWSER_CHUNK): AsyncIterable<string> {
  for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size)
}

function values(outcome: ParseOutcome): unknown[] {
  return outcome.records.map((r) => r.value)
}

function kinds(outcome: ParseOutcome): string[] {
  return outcome.problems.map((p) => p.kind)
}

/** `{"i":0,"text":"row 0"}, …` — the shape of every log this project reads. */
function rows(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `{"i":${i},"text":"row ${i}"}`)
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

const REWARD_BENCH = realLog('reward_bench/log_result/logs.json')
const RM_BENCH = realLog('RM-Bench/logs/total_dataset_1_RM-R1-Qwen2.5-Instruct-32B.json')
const RMB = realLog('RMB/BoN_set_Helpfulness/log_result/group_by_same_id_logs.json')

/** node reports the reason next to the skipped test, so a missing corpus is never silent. */
function unless(file: string | null): string | undefined {
  return file ? undefined : REAL_LOGS_HINT
}

async function* fileChunks(file: string): AsyncIterable<string> {
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: BROWSER_CHUNK })
  for await (const chunk of stream) yield chunk as string
}

/* ------------------------------------------------------------ shape probing */

test('detectShape separates arrays, objects and JSONL', () => {
  assert.equal(detectShape('[{"a":1}]'), 'json-array')
  assert.equal(detectShape('{"a":1}'), 'json-object')
  assert.equal(detectShape('{"a":1}\n{"a":2}\n'), 'jsonl')
  assert.equal(detectShape('[\n  {"a":1}\n]'), 'json-array') // "[" alone is not a complete first line
  assert.equal(detectShape('42\n43\n'), 'jsonl') // bare scalars are only meaningful line by line
  assert.equal(detectShape(''), 'unknown')
  assert.equal(detectShape('   \n  '), 'unknown')
  assert.equal(detectShape('hello world'), 'unknown')
  // "n" can start `null`, so prose beginning with it reaches the line parser
  // rather than the unknown branch. Every line is then reported as malformed.
  assert.equal(detectShape('nonsense'), 'jsonl')
})

test('empty input is reported, not thrown', async () => {
  const outcome = await parseText('')
  assert.equal(outcome.shape, 'unknown')
  assert.deepEqual(outcome.records, [])
  assert.equal(outcome.problems.length, 1)
  assert.equal(outcome.salvaged, false)
})

test('an empty array is a clean parse with zero records', async () => {
  const outcome = await parseText('[]')
  assert.equal(outcome.shape, 'json-array')
  assert.equal(outcome.records.length, 0)
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
})

/* ------------------------------------------------------------- clean arrays */

test('a clean 3000-record array arrives whole, in browser-sized chunks', async () => {
  const outcome = await parseStream(chunked(`[${rows(3000).join(',')}]`))
  assert.equal(outcome.shape, 'json-array')
  assert.equal(outcome.records.length, 3000)
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
  assert.deepEqual(outcome.records[0], { index: 0, value: { i: 0, text: 'row 0' } })
  assert.deepEqual(outcome.records[2999].value, { i: 2999, text: 'row 2999' })
})

test('the real 15 MB RewardBench array yields exactly 2985 records', { skip: unless(REWARD_BENCH) }, async () => {
  if (!REWARD_BENCH) return
  let streamed = 0
  const outcome = await parseStream(fileChunks(REWARD_BENCH), {
    retainRecords: false,
    onBatch: (batch) => {
      streamed += batch.length
    },
  })
  assert.equal(outcome.shape, 'json-array')
  assert.equal(streamed, 2985)
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
})

test('the real 22 MB RM-Bench array yields exactly 1327 records', { skip: unless(RM_BENCH) }, async () => {
  if (!RM_BENCH) return
  let streamed = 0
  const outcome = await parseStream(fileChunks(RM_BENCH), {
    retainRecords: false,
    onBatch: (batch) => {
      streamed += batch.length
    },
  })
  assert.equal(outcome.shape, 'json-array')
  assert.equal(streamed, 1327)
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
})

/* ------------------------------------------------------ envelopes: {"k":[…]} */

test('the real malformed RMB envelope yields its 2 records and says it was salvaged', { skip: unless(RMB) }, async () => {
  if (!RMB) return
  const outcome = await parseStream(fileChunks(RMB))
  assert.equal(outcome.shape, 'json-object')
  assert.equal(outcome.records.length, 2)
  assert.equal(outcome.salvaged, true)
  assert.equal(outcome.problems.length, 1)
  assert.match(outcome.problems[0].excerpt, /trailing comma/)
})

test('an envelope with a trailing comma after the array keeps every record', async () => {
  // The real RMB log's damage: `{"0": [ … ], }`.
  const outcome = await parseText(`{"0":[${rows(1000).join(',')}],}`)
  assert.equal(outcome.shape, 'json-object')
  assert.equal(outcome.records.length, 1000)
  assert.equal(outcome.salvaged, true)
  assert.deepEqual(kinds(outcome), ['malformed-json'])
  assert.match(outcome.problems[0].excerpt, /trailing comma/)
})

test('an envelope with a trailing comma INSIDE the array keeps every record', async () => {
  const outcome = await parseText(`{"0":[${rows(1000).join(',')},]}`)
  assert.equal(outcome.records.length, 1000)
  assert.equal(outcome.salvaged, true)
  assert.match(outcome.problems[0].excerpt, /trailing comma/)
})

test('one broken element inside a 20 MB envelope costs one record, not the file', async () => {
  // Same size class as the real RM-Bench log, because the defect this pins was
  // also a memory defect: the inner array used to be buffered and JSON.parsed
  // whole, so the walker's buffer could not compact until the file was resident.
  const elements = Array.from({ length: 60000 }, (_, i) => `{"i":${i},"text":"${'y'.repeat(320)}"}`)
  elements[30000] = '{"i":30000,"oops":}'
  const document = `{"0":[${elements.join(',')}]}`
  assert.ok(document.length > 20_000_000, `expected a >20 MB document, got ${document.length}`)

  let streamed = 0
  const outcome = await parseStream(chunked(document), {
    retainRecords: false,
    onBatch: (batch) => {
      streamed += batch.length
    },
  })
  assert.equal(outcome.shape, 'json-object')
  assert.equal(streamed, 59999)
  assert.equal(outcome.salvaged, true)
  assert.equal(outcome.problems.length, 1)
  assert.match(outcome.problems[0].excerpt, /"i":30000/)
})

test('a truncated envelope still yields the elements that arrived', async () => {
  const outcome = await parseText('{"0":[{"a":1},{"a":2},{"a":3}')
  assert.equal(outcome.shape, 'json-object')
  assert.deepEqual(values(outcome), [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.equal(outcome.salvaged, true)
  assert.deepEqual(kinds(outcome), ['unexpected-eof'])
})

test('an object that is not an envelope is still exactly one record', async () => {
  // Guard against over-eager descent: two keys means the object IS the record.
  const outcome = await parseText('{"meta":{"model":"x"},"runs":[{"a":1},{"a":2}]}')
  assert.equal(outcome.records.length, 1)
  assert.deepEqual(outcome.records[0].value, { meta: { model: 'x' }, runs: [{ a: 1 }, { a: 2 }] })
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
})

test('a map of id → record splits into records, in key order', async () => {
  const outcome = await parseText('{"7":{"a":1},"3":{"a":2},"9":{"a":3}}')
  assert.deepEqual(values(outcome), [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.equal(outcome.problems.length, 0)
})

test('looksLikeRecordMap needs instances of one thing, not fields of one thing', () => {
  assert.equal(looksLikeRecordMap([['0', { a: 1 }], ['1', { b: 2 }]]), true) // ordinal keys
  assert.equal(looksLikeRecordMap([['x', { a: 1 }], ['y', { a: 2 }]]), true) // same signature
  assert.equal(looksLikeRecordMap([['model', { a: 1 }], ['run', { b: 2, c: 3 }]]), false)
  assert.equal(looksLikeRecordMap([['only', { a: 1 }]]), false)
})

test('a declared agentlens_format is read off the envelope', async () => {
  const outcome = await parseText('{"agentlens_format":"arbiteros@1","rows":[{"a":1}]}')
  assert.equal(outcome.declaredFormat, 'arbiteros@1')
})

/* ------------------------------------------------------------------- JSONL */

test('a bad line in the middle of a JSONL file costs that line only', async () => {
  const outcome = await parseText('{"a":1}\n{"a":2\n{"a":3}\n{"a":4}\n')
  assert.equal(outcome.shape, 'jsonl')
  assert.deepEqual(values(outcome), [{ a: 1 }, { a: 3 }, { a: 4 }])
  assert.equal(outcome.salvaged, true)
  assert.equal(outcome.problems.length, 1)
  assert.equal(outcome.problems[0].at, 2) // 1-based line number
})

test('blank lines and stray comma-only lines are not errors', async () => {
  const outcome = await parseText('{"a":1}\n\n,\n{"a":2}\n')
  assert.deepEqual(values(outcome), [{ a: 1 }, { a: 2 }])
  assert.equal(outcome.problems.length, 0)
  assert.equal(outcome.salvaged, false)
})

test('a JSONL first line larger than the 64 KiB probe is still JSONL', async () => {
  // The longest physical line in the user's own RewardBench log is 77,073 chars,
  // so this regime is not hypothetical. Fed at the browser's chunk size, because
  // that is what decides how much of the first line the shape probe ever sees.
  for (const padding of [60_000, 70_000, 200_000]) {
    const first = JSON.stringify({ id: 0, pad: 'x'.repeat(padding) })
    const outcome = await parseStream(chunked(`${first}\n{"id":1}\n{"id":2}\n`))
    assert.equal(outcome.shape, 'jsonl', `padding ${padding}`)
    assert.equal(outcome.records.length, 3, `padding ${padding}`)
    assert.equal(outcome.problems.length, 0, `padding ${padding}`)
    assert.equal(outcome.salvaged, false, `padding ${padding}`)
  }
})

test('a first line ending exactly on a chunk boundary is still JSONL', async () => {
  // The probe reads whole 64 KiB chunks, so a first line of exactly k*65536-1 chars
  // puts its newline on the probe's last character with nothing after it to prove
  // more records follow. Rounded paddings never land here, which is how a green
  // suite hid the bug: only these exact lengths reproduce it.
  for (const lineLength of [65_535, 131_071, 196_607, 262_143]) {
    const pad = 'x'.repeat(lineLength - JSON.stringify({ id: 0, pad: '' }).length)
    const first = JSON.stringify({ id: 0, pad })
    assert.equal(first.length, lineLength, 'fixture must hit the boundary exactly')
    const outcome = await parseStream(chunked(`${first}\n{"id":1}\n{"id":2}\n`))
    assert.equal(outcome.shape, 'jsonl', `line ${lineLength}`)
    assert.equal(outcome.records.length, 3, `line ${lineLength}`)
    assert.equal(outcome.salvaged, false, `line ${lineLength}`)
  }
})

test('a first line past the 1 MiB probe budget is read as one JSON document', async () => {
  // Pins the documented ceiling rather than pretending there is none: past
  // MAX_PROBE_LINE the parser stops looking for a newline and treats the file as
  // a single JSON value, which for a JSONL file means everything after line 1 is
  // reported as trailing content.
  const first = JSON.stringify({ id: 0, pad: 'x'.repeat(1_500_000) })
  const outcome = await parseStream(chunked(`${first}\n{"id":1}\n{"id":2}\n`))
  assert.equal(outcome.shape, 'json-object')
  assert.equal(outcome.records.length, 1)
  assert.equal(outcome.salvaged, true)
  assert.match(outcome.problems[0].excerpt, /trailing content/)
})

/* ------------------------------------- the string-aware depth counter's killer */

test('brackets and escaped quotes inside a string do not end the element', async () => {
  const document = String.raw`[{"s":"a \" } ] b"},{"s":"z"}]`
  for (const size of [BROWSER_CHUNK, 7, 1]) {
    const outcome = await parseStream(chunked(document, size))
    assert.equal(outcome.records.length, 2, `chunk size ${size}`)
    assert.deepEqual(outcome.records[0].value, { s: 'a " } ] b' }, `chunk size ${size}`)
    assert.deepEqual(outcome.records[1].value, { s: 'z' }, `chunk size ${size}`)
    assert.equal(outcome.problems.length, 0, `chunk size ${size}`)
  }
})

test('a backslash before the closing quote does not swallow it', async () => {
  const outcome = await parseText(String.raw`[{"s":"ends with a backslash \\"},{"s":"next"}]`)
  assert.deepEqual(values(outcome), [{ s: 'ends with a backslash \\' }, { s: 'next' }])
  assert.equal(outcome.problems.length, 0)
})

/* ------------------------------------------------------------- truncation */

test('a truncated array keeps the records that arrived', async () => {
  const outcome = await parseText('[{"a":1},{"a":2},{"a":')
  assert.equal(outcome.shape, 'json-array')
  assert.deepEqual(values(outcome), [{ a: 1 }, { a: 2 }])
  assert.equal(outcome.salvaged, true)
  assert.deepEqual(kinds(outcome), ['unexpected-eof'])
})

test('an array truncated inside a string reports an unterminated string', async () => {
  const outcome = await parseText('[{"a":1},{"a":"unfinis')
  assert.deepEqual(values(outcome), [{ a: 1 }])
  assert.equal(outcome.salvaged, true)
  assert.deepEqual(kinds(outcome), ['unterminated'])
})

/* ------------------------------------------------- a stray quote mid-array */

test('a stray quote inside an array loses one element, not the tail', async () => {
  const elements = rows(200)
  elements[100] = '{"i":100,"text":"row " oops"}'
  const outcome = await parseText(`[${elements.join(',')}]`)
  assert.equal(outcome.shape, 'json-array')
  assert.equal(outcome.records.length, 199)
  assert.equal(outcome.salvaged, true)
  // Every surviving record is a real element, and the tail is present.
  assert.deepEqual(outcome.records[0].value, { i: 0, text: 'row 0' })
  assert.deepEqual(outcome.records[198].value, { i: 199, text: 'row 199' })
  assert.equal(values(outcome).some((v) => (v as { i: number }).i === 100), false)
})

/* --------------------------------------------------------- chunk boundaries */

test('a surrogate pair split across two chunks survives', async () => {
  const document = '[{"e":"😀"},{"e":"b"}]'
  const cut = document.indexOf('😀') + 1 // between the two UTF-16 code units
  const outcome = await parseStream(
    (async function* () {
      yield document.slice(0, cut)
      yield document.slice(cut)
    })(),
  )
  assert.deepEqual(values(outcome), [{ e: '😀' }, { e: 'b' }])
  assert.equal(outcome.problems.length, 0)
})

test('a UTF-8 sequence split across byte chunks survives TextDecoder → parseStream', async () => {
  // parse.ts takes text, so the byte split is handled upstream. This drives the
  // pipeline parse.worker.ts actually uses (a streaming TextDecoder feeding
  // parseStream) so the two halves are tested together.
  const document = '[{"e":"日本語 😀 café"},{"e":"b"}]'
  const bytes = new TextEncoder().encode(document)
  const decoder = new TextDecoder('utf-8')
  const cut = bytes.indexOf(0xe6) + 1 // inside the 3-byte sequence for 日
  assert.ok(cut > 0)
  const outcome = await parseStream(
    (async function* () {
      yield decoder.decode(bytes.subarray(0, cut), { stream: true })
      yield decoder.decode(bytes.subarray(cut), { stream: false })
    })(),
  )
  assert.deepEqual(values(outcome), [{ e: '日本語 😀 café' }, { e: 'b' }])
  assert.equal(outcome.problems.length, 0)
})

test('a BOM does not become part of the first record', async () => {
  const outcome = await parseText('﻿[{"a":1}]')
  assert.equal(outcome.shape, 'json-array')
  assert.deepEqual(values(outcome), [{ a: 1 }])
  assert.equal(outcome.problems.length, 0)
})

/* ------------------------------------------------- parseStream never throws */

test('a source error at byte 0 becomes a problem, not a rejection', async () => {
  const outcome = await parseStream(
    (async function* () {
      throw new Error('disk read failed at byte 0')
      // eslint-disable-next-line no-unreachable
      yield ''
    })(),
  )
  assert.equal(outcome.records.length, 0)
  assert.equal(outcome.salvaged, true)
  assert.ok(outcome.problems.some((p) => p.excerpt.includes('disk read failed at byte 0')))
})

test('a source error mid-file keeps the records already recovered', async () => {
  // The same failure at two very different offsets must give the same contract:
  // cutAfter 1 lands inside the shape probe, cutAfter 60 is ~87 KB in, past it.
  // It used to reject the promise before 64 KiB and resolve after it.
  const elements = rows(6000) // newline-separated below, so the probe stops at 64 KiB
  for (const cutAfter of [1, 60]) {
    const outcome = await parseStream(
      (async function* () {
        let emitted = 0
        for (let i = 0; i < elements.length; i += 50) {
          if (emitted === cutAfter) throw new Error('NotReadableError: file changed on disk')
          yield (i === 0 ? '[' : '') + elements.slice(i, i + 50).join(',\n') + ',\n'
          emitted++
        }
      })(),
    )
    assert.equal(outcome.shape, 'json-array', `cutAfter ${cutAfter}`)
    assert.equal(outcome.salvaged, true, `cutAfter ${cutAfter}`)
    assert.ok(
      outcome.problems.some((p) => p.excerpt.includes('NotReadableError')),
      `cutAfter ${cutAfter}`,
    )
    assert.equal(outcome.records.length, cutAfter * 50, `cutAfter ${cutAfter}`)
  }
})

test('random mutations of valid documents never throw out of parseStream', async () => {
  const seeds = [
    `[${rows(40).join(',')}]`,
    `{"0":[${rows(40).join(',')}]}`,
    rows(40).join('\n'),
    '{"a":{"b":[1,2,{"c":"d \\" e"}]},"f":null}',
    '[1,2,3,true,false,null,"x",-4.5e2]',
    '{"7":{"a":1},"3":{"a":2}}',
  ]
  let random = 123456789
  const next = (n: number) => {
    random = (random * 1103515245 + 12345) & 0x7fffffff
    return random % n
  }
  let runs = 0
  for (let round = 0; round < 600; round++) {
    const seed = seeds[next(seeds.length)]
    const cut = next(seed.length)
    const mutated =
      next(3) === 0
        ? seed.slice(0, cut)
        : next(2) === 0
          ? seed.slice(0, cut) + '"' + seed.slice(cut)
          : seed.slice(0, cut) + seed.slice(cut + 1)
    const outcome = await parseStream(chunked(mutated, 1 + next(5)))
    assert.ok(Array.isArray(outcome.records))
    // The contract: partial recovery is never reported as a clean parse.
    // (Zero records plus a problem is a failed parse, not a salvaged one.)
    if (outcome.records.length > 0 && outcome.problems.length > 0) {
      assert.equal(outcome.salvaged, true, `not flagged as salvaged: ${JSON.stringify(mutated)}`)
    }
    runs++
  }
  assert.equal(runs, 600)
})

/* --------------------------------------------------- streaming/retain contract */

test('retainRecords:false streams every record and keeps none', async () => {
  const seen: number[] = []
  const outcome = await parseStream(chunked(`[${rows(1000).join(',')}]`), {
    retainRecords: false,
    batchSize: 64,
    onBatch: (batch) => {
      for (const record of batch) seen.push(record.index)
    },
  })
  assert.equal(outcome.records.length, 0)
  assert.equal(seen.length, 1000)
  assert.equal(seen[0], 0)
  assert.equal(seen[999], 999)
})
