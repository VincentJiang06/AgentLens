/**
 * Tests for the adapter's pure core. `node --test src/adapters/arbiteros-preview/model.test.ts`.
 *
 * model.ts has no React and no DOM, which is the reason it is a separate file:
 * the rules that decide whether an emailed deep link lands on the right case are
 * checkable without a browser. The fixture is the demo package this repo ships,
 * read from disk — not a copy of it.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { caseId, caseIndexFor, parse, sniff } from './model.ts'
import type { ArbiterosPreviewModel } from './model.ts'
import type { ParsedFile } from '../../types.ts'

const DEMO = new URL('../../../public/demo-data/arbiteros-preview/cases.json', import.meta.url)

/** What the worker hands an adapter: one file, records in file order. */
function fileOf(fileName: string, values: unknown[]): ParsedFile {
  return {
    fileName,
    size: 0,
    shape: 'json-array',
    problems: [],
    salvaged: false,
    records: values.map((value, index) => ({ index, value })),
  }
}

function demoValues(): unknown[] {
  return JSON.parse(fs.readFileSync(DEMO, 'utf8')) as unknown[]
}

function demoModel(): ArbiterosPreviewModel {
  return parse([fileOf('cases.json', demoValues())])
}

test('the shipped demo package parses into cases', () => {
  const model = demoModel()
  assert.equal(model.cases.length, 105)
  assert.equal(model.skipped, 0)
  assert.equal(model.singleFile, true)
  assert.equal(model.cases[57].traceId, 'redteam-mail-unsafe-01-inbound-request-read-internal-file')
  assert.equal(model.cases[57].verdict, 'unsafe')
  assert.equal(model.cases[57].priorSteps, 3)
})

test('record ids carry no "#", so a deep link survives a URL', () => {
  const model = demoModel()
  for (const one of model.cases) assert.ok(!one.id.includes('#'), `id has a '#': ${one.id}`)

  // The README's outreach link, taken apart the way a browser takes it apart.
  const url = new URL(`https://example.org/agentlens/?demo=arbiteros-preview&record=${caseId('cases.json', 57)}`)
  assert.equal(url.hash, '')
  assert.equal(url.searchParams.get('record'), 'cases.json:57')
  assert.equal(caseIndexFor(model, url.searchParams.get('record') ?? undefined), 57)
})

test('a record id resolves by id, by trace id, and by bare index', () => {
  const model = demoModel()
  assert.equal(caseIndexFor(model, 'cases.json:57'), 57)
  assert.equal(caseIndexFor(model, model.cases[57].traceId), 57)
  assert.equal(caseIndexFor(model, '57'), 57)
})

test('a miss is -1, never a wrong case', () => {
  const model = demoModel()
  // What `?record=cases.json#57` collapses to once the browser eats the fragment.
  assert.equal(caseIndexFor(model, 'cases.json'), -1)
  assert.equal(caseIndexFor(model, 'cases.json:99999'), -1)
  assert.equal(caseIndexFor(model, 'no-such-trace'), -1)
  assert.equal(caseIndexFor(model, ''), -1)
  assert.equal(caseIndexFor(model, undefined), -1)
})

test('with several files, ids stay unique and a bare index stops resolving', () => {
  const values = demoValues()
  const model = parse([fileOf('a.json', values), fileOf('b.json', values)])
  assert.equal(model.singleFile, false)
  assert.equal(model.cases.length, 210)
  assert.equal(new Set(model.cases.map((one) => one.id)).size, 210)
  assert.equal(caseIndexFor(model, '57'), -1)
  assert.equal(caseIndexFor(model, 'b.json:57'), 105 + 57)
})

test('records that are not cases are counted, not dropped silently', () => {
  const model = parse([fileOf('mixed.json', [null, 3, 'x', [], {}, { trace_id: 1 }, { trace_id: 't' }])])
  assert.equal(model.cases.length, 1)
  assert.equal(model.skipped, 6)
  // The index is the record's position in the file, not its position among the cases.
  assert.equal(model.cases[0].id, 'mixed.json:6')
})

test('a case with no tool call still says what happened', () => {
  const model = parse([
    fileOf('a.json', [
      { trace_id: 'x-safe-1', current: { content: 'hello' } },
      { trace_id: 'x-1', current: {} },
      { trace_id: 'x-unsafe-1', prior: [1, 2], current: { tool_calls: [{ function: { name: 'read' } }, {}] } },
    ]),
  ])
  assert.deepEqual(
    model.cases.map((one) => [one.action, one.priorSteps, one.verdict]),
    [
      ['reply', 0, 'safe'],
      ['unknown', 0, undefined],
      ['read, unnamed tool', 2, 'unsafe'],
    ],
  )
})

test('sniff scores the real shape high and foreign records at zero', () => {
  const values = demoValues()
  assert.ok(sniff('cases.json', values.slice(0, 5)) > 0.9)
  assert.equal(sniff('rows.json', [{ id: 1, text: 'x' }, { id: 2 }]), 0)
  assert.equal(sniff('empty.json', []), 0)
})
