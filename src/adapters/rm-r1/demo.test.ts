/**
 * The committed demo packages, opened exactly as the shell opens them.
 * `node --test src/adapters/rm-r1/demo.test.ts`.
 *
 * These need no environment variable and no clone of anybody's logs: the
 * packages are in the repository, so this runs everywhere the rest of the suite
 * does. It is the only test that covers the whole chain a visitor takes — a
 * `?demo=` link, one JSON file, the adapter, the numbers on screen — and the
 * three things it pins are the three that would embarrass the project if they
 * broke quietly: the package still routes to this adapter, the deep link in the
 * outreach still lands on a judgement, and the RM-Bench numbers the outreach
 * quotes are still what the package produces.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { judgementIndexFor, parse, sniff } from './model.ts'
import type { ParsedFile } from '../../types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGES = path.resolve(HERE, '../../../public/demo-data/rm-r1')

/** What the shell's parser makes of a package: one record, the whole object. */
function open(fileName: string): { file: ParsedFile; declared: string } {
  const text = fs.readFileSync(path.join(PACKAGES, fileName), 'utf8')
  const value = JSON.parse(text) as Record<string, unknown>
  return {
    declared: String(value.agentlens_format),
    file: {
      fileName,
      size: Buffer.byteLength(text),
      shape: 'json-object',
      records: [{ index: 0, value }],
      problems: [],
      salvaged: false,
      declaredFormat: String(value.agentlens_format),
    },
  }
}

/* ------------------------------------------------------------------ routing */

test('both packages declare this adapter by name, not by a format of their own', () => {
  for (const name of ['rm-r1-32b.json', 'rm-r1-compare.json']) {
    const { declared, file } = open(name)
    // `shell/sniff.ts` matches the part before the `@` against `adapter.name`.
    // `rm-r1-bundle@1` would warn that no adapter handles it and fall through.
    assert.equal(declared, 'rm-r1@1', `${name} declares ${declared}`)
    assert.equal(sniff(name, [file.records[0].value]), 1)
  }
})

/* -------------------------------------------------------- the main package */

test('the 32B package opens with judgements, scores and the style matrix', () => {
  const model = parse([open('rm-r1-32b.json').file])

  assert.ok(model.judgements.length > 0)
  assert.deepEqual(model.benchmarks, ['rewardbench', 'rm-bench', 'rmb-pairwise', 'rmb-bon'])
  // One entry per run that shipped a score file, each naming its own run: two
  // checkpoints' score files have identical keys and different values, so a
  // merged map would belong to neither. The single-run package has exactly one.
  assert.equal(model.officialScores.length, 1)
  const [published] = model.officialScores
  assert.ok(published.run, 'a published score has to name the run that produced it')
  assert.equal(Object.keys(published.scores.perSubset ?? {}).length, 23)
  assert.equal(published.scores.sections?.absoluate_Result, 0.9293132328308208)

  // Every judgement carries the text it claims to: a package of empty records
  // would still satisfy every count above.
  for (const judgement of model.judgements) {
    assert.ok(judgement.chosen.length > 0 && judgement.rejected.length > 0, judgement.id)
  }
})

test('the deep link named in the outreach lands on a judgement', () => {
  const model = parse([open('rm-r1-32b.json').file])
  const at = judgementIndexFor(model, 'logs.json:498')
  assert.notEqual(at, -1, 'the featured record is not in the package under that id')
  const judgement = model.judgements[at]
  assert.equal(judgement.group, 'llmbar-adver-neighbor')
  assert.equal(judgement.cor.verdict, 'A')
  assert.equal(judgement.correct, true)
  assert.equal(judgement.cor.degraded, false)
  // All four evidence kinds, which is what the quote-to-response tie needs.
  assert.deepEqual(
    [...new Set(judgement.cor.evidence.map((one) => `${one.kind}_${one.side}`))].sort(),
    ['quote_A', 'quote_B', 'summary_A', 'summary_B'],
  )
})

/**
 * The finding, computed from the package alone.
 *
 * The package ships a sample of the traces but every record's outcome, so this
 * matrix is over all 1,327 RM-Bench items rather than the 30 the browser lists.
 * The middle column is this same code run the way `process_final_result.py`
 * runs it; that it lands on the released `final_result.json` is what licenses
 * the corrected column.
 */
test('the RM-Bench matrix in the package reproduces the shipped numbers and corrects them', () => {
  const model = parse([open('rm-r1-32b.json').file])
  const summary = model.rmBench
  assert.ok(summary, 'the package must carry enough to build the matrix')
  const bug = summary.reproducedOfficial
  assert.ok(bug)
  const official = summary.official as Record<string, number>

  const reproduced: Record<string, number> = {
    hard_acc: bug.overall.hard,
    normal_acc: bug.overall.normal,
    easy_acc: bug.overall.easy,
    total_avg_acc: bug.totalAverage,
  }
  for (const domain of bug.domains) reproduced[domain.domain] = domain.average
  for (const [metric, value] of Object.entries(reproduced)) {
    assert.ok(
      Math.abs(value - official[metric]) < 1e-9,
      `${metric}: reproduction ${value} vs shipped ${official[metric]}`,
    )
  }

  const round = (value: number) => Number((value * 100).toFixed(2))
  assert.equal(round(summary.overall.hard), 67.23)
  assert.equal(round(summary.overall.easy), 88.18)
  assert.equal(round(summary.totalAverage), 78.64)
  // `normal_acc` reads from total_dataset_1 in both assemblies, so the one line
  // cannot move it. That is the signature that makes the rest checkable.
  assert.equal(summary.overall.normal, bug.overall.normal)
  assert.equal(round(summary.overall.normal), 80.51)
})

/* ----------------------------------------------------- the compare package */

test('the compare package names its two runs apart', () => {
  const model = parse([open('rm-r1-compare.json').file])
  const files = model.runs.map((run) => run.fileName)
  // Both runs pack a file called `logs.json`; without the run id the compare
  // view would offer `logs.json` and `logs.json~2` and mean nothing by either.
  assert.deepEqual(files, [
    'RM-R1-Qwen2.5-Instruct-32B/logs.json',
    'RM-R1-DeepSeek-Distilled-Qwen-32B/logs.json',
  ])
  assert.deepEqual(model.runs.map((run) => run.run), [
    'RM-R1-Qwen2.5-Instruct-32B',
    'RM-R1-DeepSeek-Distilled-Qwen-32B',
  ])
  assert.equal(model.runs[0].count, model.runs[1].count)
  assert.ok(model.judgements.every((one) => one.id.includes(':')))
})

/**
 * The other half of the same rule. This package holds one checkpoint's whole
 * result directory — several log files across four benchmarks — and a compare
 * view that read those as runs would offer this run its own files as "Run 2".
 */
test('the single-run package offers no second run, however many files it packs', () => {
  const model = parse([open('rm-r1-32b.json').file])
  assert.ok(model.judgements.length > 500, 'this package packs several files')
  assert.deepEqual(model.runs, [], 'a run is not two runs because it has two files')
})

/* ------------------------------------------------------------------- honesty */

test('neither package can put the checkpoint name on screen', () => {
  for (const name of ['rm-r1-32b.json', 'rm-r1-compare.json']) {
    const raw = fs.readFileSync(path.join(PACKAGES, name), 'utf8')
    assert.ok(!/wzq016|filtered_sky/i.test(raw), `${name} carries the checkpoint name`)
    const model = parse([open(name).file])
    assert.ok(!/wzq016|filtered_sky/i.test(JSON.stringify(model)))
  }
})

test('each package says it is a sample, in its own notes', () => {
  for (const name of ['rm-r1-32b.json', 'rm-r1-compare.json']) {
    const model = parse([open(name).file])
    assert.ok(
      model.notes.some((note) => note.en.includes('is not the benchmark')),
      `${name} does not say its accuracy is the sample's`,
    )
    // AgentLens's own sentence, so it is on screen in whichever language the
    // reader is reading — the disclosure and the chrome switch together.
    const coverage = model.notes.filter((note) => note.en.includes('full text of'))
    assert.ok(coverage.length > 0, `${name} does not say how much of the benchmark it carries`)
    for (const note of coverage) {
      assert.ok(/[\u4e00-\u9fff]/.test(note.zh), `${name}: the coverage note has no Chinese`)
      assert.notEqual(note.zh, note.en)
    }
  }
})

/**
 * The anti-cherry-picking disclosure, on the packages as they ship.
 *
 * A reader who suspects the sample was chosen to flatter the model can only be
 * answered by the rule that drew it, the records taken on top of the quota, the
 * file that was withheld and the ones that were left out. All of that is written
 * into the package; this is the test that it survives `parse()` and can reach a
 * view, which is where four rounds of this project lost it.
 */
test('the sampling rule and the coverage table reach the model, on both packages', () => {
  for (const name of ['rm-r1-32b.json', 'rm-r1-compare.json']) {
    const model = parse([open(name).file])
    const sampling = model.sampling
    assert.ok(sampling, `${name}: the sampling disclosure did not reach the model`)
    assert.ok(sampling.rules.length >= 5, `${name}: ${sampling.rules.length} sampling rules`)
    assert.ok(sampling.method !== undefined && sampling.method.en !== '' && sampling.method.zh !== '')
    // The rule that drew the sample is the disclosure, so it is held to what
    // every AgentLens sentence is held to: a rule a reader cannot read is a rule
    // they cannot check the screen against. Both packages shipped these in
    // English only for four rounds.
    for (const rule of sampling.rules) {
      assert.ok(/[\u4e00-\u9fff]/.test(rule.zh), `${name}: a sampling rule has no Chinese: ${rule.en}`)
      assert.notEqual(rule.zh, rule.en)
    }
    assert.ok(/[\u4e00-\u9fff]/.test(sampling.method.zh), `${name}: sampling.method has no Chinese`)
    // Every declared file names itself, so a reader can check the claim against
    // the release rather than take it.
    for (const one of [...sampling.withheld, ...sampling.excluded]) {
      assert.ok(one.sourcePath, `${name}: a withheld or excluded file with no path`)
      assert.ok(one.reason, `${name}: a withheld or excluded file with no reason`)
    }
    for (const one of sampling.truncated) {
      assert.ok(
        one.recordId !== undefined || one.sourceIndex !== undefined,
        `${name}: a truncation nobody can open`,
      )
      assert.ok(one.originalBytes !== undefined && one.keptBytes !== undefined)
    }

    assert.ok(model.coverage.length >= 4, `${name}: ${model.coverage.length} coverage entries`)
    for (const entry of model.coverage) {
      assert.ok(entry.figure.en !== '' && entry.figure.zh !== '', `${name}: a coverage entry names no figure`)
      // E2, in the data: a figure that names neither its run nor its denominator
      // is exactly the figure a reader cannot check.
      assert.ok(entry.basis !== undefined, `${name}: "${entry.figure.en}" declares no basis`)
      // The denominators live here. A ledger of them in one language answers the
      // misreading it exists to stop for half the readership only.
      for (const [field, written] of [
        ['figure', entry.figure],
        ['basis', entry.basis],
        ['note', entry.note],
      ] as const) {
        if (written === undefined) continue
        assert.ok(
          /[\u4e00-\u9fff]/.test(written.zh),
          `${name}: coverage ${field} has no Chinese: ${written.en}`,
        )
        assert.notEqual(written.zh, written.en)
      }
    }
  }
})

test('the 32B package hand-picks in the open, with the id a reader can open', () => {
  const model = parse([open('rm-r1-32b.json').file])
  const sampling = model.sampling
  assert.ok(sampling)
  // The three declarations that answer "what is not here": the file held back
  // for content reasons, the files left out of the package, and the one record
  // whose text was cut.
  assert.ok(sampling.withheld.length > 0, 'nothing is declared withheld')
  assert.ok(sampling.excluded.length > 0, 'nothing is declared excluded')
  assert.ok(sampling.truncated.length > 0, 'the truncation is not declared')

  const picked = sampling.handPicked
  assert.ok(picked.length > 0, 'the package declares no hand-picked record')
  for (const one of picked) {
    assert.ok(one.why, 'a record taken on top of the quota with no reason given')
    const id = one.recordId ?? ''
    // Declared and openable: the id resolves to a judgement in this package.
    assert.notEqual(judgementIndexFor(model, id), -1, `hand-picked ${id} is not in the package`)
  }
})
