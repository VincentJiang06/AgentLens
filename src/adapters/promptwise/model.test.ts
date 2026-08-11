/**
 * Tests for the PromptWise data layer. `node --test src/adapters/promptwise/model.test.ts`.
 *
 * The fixture is the package this repo ships, read from disk — not a copy of
 * it, and not a hand-written miniature. Every number the views will draw is
 * checked against the file it came out of, because the one failure mode that
 * looks like success here is a plausible chart of a mis-read run.
 *
 * Both shipped packages are read: `uniform.json`, where every model succeeds
 * about half the time, and `tiered.json`, where they do not. The two differ in
 * `config.success_rates` and in the prose that explains it, and the second half
 * of this file also builds a tiered config over the uniform runs, so that the
 * one thing that changes is the one thing under test.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { parse, sniff } from './model.ts'
import type { PromptWiseModel } from './contract.ts'
import type { ParsedFile } from '../../types.ts'
import { CONFIDENCE_FLOOR, parseFormatTag } from '../../shell/sniff.ts'

const DEMO = new URL('../../../public/demo-data/promptwise/uniform.json', import.meta.url)
const TIERED = new URL('../../../public/demo-data/promptwise/tiered.json', import.meta.url)

type Json = Record<string, any>

/** What the worker hands an adapter for a file whose top level is one object. */
function fileOf(fileName: string, value: unknown): ParsedFile {
  const fields = value as Json
  return {
    fileName,
    size: 0,
    shape: 'json-object',
    problems: [],
    salvaged: false,
    records: [{ index: 0, value }],
    declaredFormat: typeof fields?.agentlens_format === 'string' ? fields.agentlens_format : undefined,
  }
}

function raw(): Json {
  return JSON.parse(fs.readFileSync(DEMO, 'utf8')) as Json
}

function model(): PromptWiseModel {
  return parse([fileOf('uniform.json', raw())])
}

const METRICS = ['utility', 'cost', 'success', 'opr'] as const

/* --------------------------------------------------------------- the package */

test('the shipped package parses into its eight learners, in file order', () => {
  const package_ = raw()
  const parsed = model()
  assert.equal(parsed.runs.length, 8)
  assert.deepEqual(
    parsed.runs.map((run) => run.learner),
    package_.runs.map((run: Json) => run.learner),
  )
  assert.deepEqual(parsed.runs.map((run) => run.learner)[0], 'promptwise')
  // The pool, verbatim: names and prices are the run's record, not our vocabulary.
  assert.deepEqual(parsed.models, package_.config.models)
  assert.equal(parsed.models.length, 5)
})

test('every curve is as long as the run is long, and t is the whole 1..steps', () => {
  const parsed = model()
  assert.equal(parsed.config.steps, 1000)
  for (const run of parsed.runs) {
    assert.equal(run.curves.t.length, parsed.config.steps, run.learner)
    for (const metric of METRICS) {
      assert.equal(run.curves[metric].length, run.curves.t.length, `${run.learner}.${metric}`)
    }
    assert.equal(run.curves.t[0], 1)
    assert.equal(run.curves.t.at(-1), parsed.config.steps)
  }
})

test('final is exactly the last point of each of the run\'s own curves', () => {
  for (const run of model().runs) {
    for (const metric of METRICS) {
      assert.equal(run.final[metric], run.curves[metric].at(-1), `${run.learner}.${metric}`)
    }
  }
  // …and the shipped package therefore raises no disagreement note.
  for (const note of model().notes) assert.ok(!note.en.includes('but the last point'), note.en)
})

test('visitation is a share of the calls made: it sums to 1, over the pool\'s own names', () => {
  const parsed = model()
  const pool = new Set(parsed.models.map((one) => one.name))
  for (const run of parsed.runs) {
    const shares = Object.entries(run.visitation)
    assert.equal(shares.length, pool.size, run.learner)
    for (const [name, share] of shares) {
      assert.ok(pool.has(name), `${run.learner}: visitation names ${name}, which is not in the pool`)
      assert.ok(share >= 0 && share <= 1, `${run.learner}.${name} = ${share}`)
    }
    const total = shares.reduce((sum, [, share]) => sum + share, 0)
    // Each share is rounded to 5 dp before it is written, so five of them can
    // drift by 2.5e-5; anything past 1e-3 is a different quantity, not rounding.
    assert.ok(Math.abs(total - 1) < 1e-3, `${run.learner}: shares sum to ${total}`)
  }
})

test('an escalated step really is a dearer model tried after a cheaper one failed', () => {
  const parsed = model()
  let escalations = 0
  for (const run of parsed.runs) {
    for (const step of run.steps) {
      if (!step.escalated) continue
      escalations += 1
      const where = `${run.learner} t=${step.t}`
      assert.ok(step.attempts.length > 1, `${where}: one attempt cannot be an escalation`)
      const first = step.attempts[0]
      const last = step.attempts.at(-1)!
      assert.ok(last.cost > first.cost, `${where}: ended on ${last.cost}, started at ${first.cost}`)
      for (const earlier of step.attempts.slice(0, -1)) {
        assert.equal(earlier.reward, 0, `${where}: escalated away from an attempt that did not fail`)
      }
    }
  }
  // Vacuously passing over zero escalations would be the easiest way to ship a
  // broken escalation view, so the count is asserted against the file itself.
  const stated = raw().runs.reduce(
    (sum: number, run: Json) => sum + run.steps.filter((step: Json) => step.escalated).length,
    0,
  )
  assert.equal(escalations, stated)
  assert.ok(escalations > 0)
})

test('no step\'s totalCost disagrees with the sum of its attempts — and no package states it', () => {
  for (const run of model().runs) {
    for (const step of run.steps) {
      const summed = step.attempts.reduce((sum, attempt) => sum + attempt.cost, 0)
      assert.ok(
        Math.abs(step.totalCost - summed) < 1e-6,
        `${run.learner} t=${step.t}: totalCost ${step.totalCost} vs ${summed}`,
      )
      assert.ok(step.totalCost > 0)
    }
  }
  // It is computed here because the runner never writes it; if it ever starts
  // writing one, this adapter must read that instead of adding up its own.
  for (const run of raw().runs) {
    for (const step of run.steps) {
      assert.equal(step.total_cost, undefined)
      assert.equal(step.totalCost, undefined)
    }
  }
})

test('the runner\'s snake_case arrives camel-cased, with nothing renamed away', () => {
  const package_ = raw()
  const parsed = model()

  assert.equal(parsed.config.costPara, package_.config.cost_para)
  assert.equal(parsed.config.rdBudget, package_.config.rd_budget)
  assert.equal(parsed.config.tauExp, package_.config.tau_exp)
  assert.equal(parsed.config.regMethod, package_.config.reg_method)
  assert.equal(parsed.config.kernelMethod, package_.config.kernel_method)
  assert.equal(parsed.config.successRates, package_.config.success_rates)
  assert.deepEqual(parsed.traceSampling, package_.trace_sampling)

  const run = parsed.runs[0]
  const rawRun = package_.runs[0]
  assert.equal(run.oracleUtility, rawRun.oracle_utility)
  assert.equal(run.steps.length, rawRun.steps.length)
  assert.deepEqual(
    run.steps.map((step) => step.promptId),
    rawRun.steps.map((step: Json) => step.prompt_id),
  )
  assert.deepEqual(
    run.steps.map((step) => step.attempts.length),
    rawRun.steps.map((step: Json) => step.rounds.length),
  )
})

test('beliefs keep pool order, and `ucb_q` becomes `q` without changing a value', () => {
  const package_ = raw()
  const parsed = model()
  const pool = parsed.models.length

  let withBeliefs = 0
  for (const [index, run] of parsed.runs.entries()) {
    for (const [stepIndex, step] of run.steps.entries()) {
      for (const [attemptIndex, attempt] of step.attempts.entries()) {
        const source = package_.runs[index].steps[stepIndex].rounds[attemptIndex]
        if (attempt.beliefs === undefined) {
          assert.equal(source.beliefs, undefined, `${run.learner}: beliefs were dropped`)
          continue
        }
        withBeliefs += 1
        assert.deepEqual(attempt.beliefs.q, source.beliefs.ucb_q)
        assert.deepEqual(attempt.beliefs.utility, source.beliefs.utility)
        assert.equal(attempt.beliefs.q.length, pool)
        assert.equal(attempt.beliefs.utility.length, pool)
      }
    }
  }
  assert.ok(withBeliefs > 0)
})

/* ------------------------------------------------------------ what it claims */

test('every provenance sentence arrives verbatim', () => {
  const source = raw().source as Json
  const provenance = model().provenance
  assert.equal(provenance.what, source.what)
  assert.equal(provenance.upstream, source.upstream)
  assert.equal(provenance.branch, source.branch)
  assert.equal(provenance.data, source.data)
  assert.equal(provenance.note, source.note)
  assert.equal(provenance.departure, source.departure)
  // Not trimmed, not reflowed, not shortened: the disclosure is the run's.
  assert.ok(provenance.data.startsWith('SYNTHETIC'))
  assert.equal(provenance.data.length, source.data.length)
})

test('data is never translated: names and the run\'s own sentences read identically on both sides', () => {
  const package_ = raw()
  const parsed = model()
  const rates = package_.config.success_rates as string
  const quoting = parsed.notes.filter((note) => note.en.includes(rates))
  assert.equal(quoting.length, 1)
  // The English sentence around it is translated; the quoted config value is not.
  assert.ok(quoting[0].zh.includes(rates))
  assert.notEqual(quoting[0].en, quoting[0].zh)
  for (const run of parsed.runs) assert.ok(package_.runs.some((one: Json) => one.learner === run.learner))
})

test('the notes say it is synthetic, that the trace is one sampled epoch, and both sides are written', () => {
  const parsed = model()
  const kept = parsed.runs.reduce((sum, run) => sum + run.steps.length, 0)
  const traced = parsed.runs.length * parsed.config.steps

  assert.ok(parsed.notes[0].en.startsWith('Synthetic data.'))
  assert.ok(parsed.notes[0].zh.startsWith('合成数据。'))

  // No figure without its denominator: the kept count, what it is kept out of,
  // and the epoch count the curves average over.
  const sampling = parsed.notes.find((note) => note.en.includes('Decision traces'))
  assert.ok(sampling)
  assert.ok(sampling.en.includes(`${kept} steps kept of the ${traced}`), sampling.en)
  assert.ok(sampling.zh.includes(`保留了 ${kept} 步`), sampling.zh)
  assert.ok(sampling.en.includes(`all ${parsed.config.epochs} epochs`))
  assert.ok(sampling.zh.includes(`${parsed.config.epochs} 个 epoch`))
  // Which epoch it is comes from the package, quoted the same way on both sides.
  assert.ok(sampling.en.includes(`"${parsed.traceSampling.epoch}"`), sampling.en)
  assert.ok(sampling.zh.includes(`"${parsed.traceSampling.epoch}"`), sampling.zh)
  assert.equal(parsed.traceSampling.epoch, raw().trace_sampling.epoch)

  for (const note of parsed.notes) {
    assert.ok(note.en.trim().length > 0, JSON.stringify(note))
    assert.ok(note.zh.trim().length > 0, JSON.stringify(note))
    assert.notEqual(note.en, note.zh)
  }
})

test('the uniform package says why escalation is not the point here, with the count it actually has', () => {
  const parsed = model()
  const kept = parsed.runs.reduce((sum, run) => sum + run.steps.length, 0)
  const escalated = parsed.runs.reduce(
    (sum, run) => sum + run.steps.filter((step) => step.escalated).length,
    0,
  )
  const note = parsed.notes.find((one) => one.en.includes('no per-model success rates'))
  assert.ok(note, parsed.notes.map((one) => one.en).join('\n'))
  assert.ok(note.en.includes('none is worth escalating TO'))
  // The claim is the count, not "none": the switch-on-failure baselines escalate
  // in this world by construction, and a note saying otherwise would be refuted
  // by the trace underneath it.
  assert.ok(escalated > 0)
  assert.ok(note.en.includes(`${escalated} of the ${kept} sampled steps still escalated`), note.en)
  const busiest = [...parsed.runs].sort(
    (a, b) => b.steps.filter((s) => s.escalated).length - a.steps.filter((s) => s.escalated).length,
  )[0]
  assert.ok(note.en.includes(`in ${busiest.learner} alone`), note.en)
  assert.ok(note.zh.includes(`来自 ${busiest.learner} 一个`), note.zh)
})

test('steps that escalate but are not marked as escalations are counted, not reconciled', () => {
  const parsed = model()
  // The runner marks a step when its LAST attempt cost more than its FIRST. A
  // step that went cheap → dear → cheap escalated too, and gets no mark.
  const unmarked = raw().runs.reduce(
    (sum: number, run: Json) =>
      sum +
      run.steps.filter((step: Json) => {
        if (step.escalated) return false
        return step.rounds.some(
          (attempt: Json, index: number) =>
            attempt.reward === 0 &&
            step.rounds.slice(index + 1).some((later: Json) => later.cost > attempt.cost),
        )
      }).length,
    0,
  )
  assert.ok(unmarked > 0)
  const note = parsed.notes.find((one) => one.en.includes('is the run\'s own mark'))
  assert.ok(note, parsed.notes.map((one) => one.en).join('\n'))
  assert.ok(note.en.includes(`${unmarked} further sampled steps`), note.en)
  assert.ok(note.zh.includes(`另有 ${unmarked} 步`), note.zh)
})

/* ---------------------------------------------------------- the two packages */

test('the tiered package this repo ships reads by exactly the same rules', () => {
  const package_ = JSON.parse(fs.readFileSync(TIERED, 'utf8')) as Json
  const parsed = parse([fileOf('tiered.json', package_)])

  // The two packages differ in `config.success_rates` and in the prose that
  // explains it. Everything else about how they are read is the same file's job.
  assert.deepEqual(parsed.config.successRates, package_.config.success_rates)
  assert.equal(typeof parsed.config.successRates, 'object')
  assert.deepEqual(parsed.models, model().models)
  assert.deepEqual(parsed.traceSampling, model().traceSampling)
  assert.equal(parsed.provenance.data, package_.source.data)
  assert.equal(parsed.runs.length, 8)

  let escalations = 0
  for (const run of parsed.runs) {
    assert.equal(run.curves.t.length, parsed.config.steps)
    for (const metric of METRICS) {
      assert.equal(run.curves[metric].length, run.curves.t.length, `${run.learner}.${metric}`)
      assert.equal(run.final[metric], run.curves[metric].at(-1), `${run.learner}.${metric}`)
    }
    const shares = Object.values(run.visitation).reduce((sum, share) => sum + share, 0)
    assert.ok(Math.abs(shares - 1) < 1e-3, `${run.learner}: shares sum to ${shares}`)
    for (const step of run.steps) {
      const summed = step.attempts.reduce((sum, attempt) => sum + attempt.cost, 0)
      assert.ok(Math.abs(step.totalCost - summed) < 1e-6, `${run.learner} t=${step.t}`)
      if (!step.escalated) continue
      escalations += 1
      assert.ok(step.attempts.at(-1)!.cost > step.attempts[0].cost, `${run.learner} t=${step.t}`)
      for (const earlier of step.attempts.slice(0, -1)) assert.equal(earlier.reward, 0)
    }
  }
  // This is the package where escalation is meant to be visible, so a router
  // that never escalates in it would be a broken package, not a quiet one.
  assert.ok(escalations > 0)
  assert.ok(parsed.runs[0].steps.some((step) => step.escalated), 'promptwise itself never escalated')

  // The rates are a table here, so the note is the one that says a table was chosen.
  assert.ok(parsed.notes.some((note) => note.en.includes('per-model success rates in this package')))
  assert.ok(!parsed.notes.some((note) => note.en.includes('no per-model success rates')))
})

test('the same runs under a tiered config read identically — only the rates note changes', () => {
  const uniform = model()
  const source = raw()
  source.config.success_rates = { MODEL_A: 0.9, MODEL_B: 0.3, MODEL_C: 0.8, MODEL_D: 0.4, MODEL_E: 0.45 }
  source.source.data = 'SYNTHETIC — random embeddings, and a success table drawn from the per-model probabilities in config.success_rates, which are ours.'
  source.source.note = 'Models differ in competence here, which is what makes escalation visible at all.'
  const tiered = parse([fileOf('tiered.json', source)])

  assert.deepEqual(tiered.config.successRates, source.config.success_rates)
  assert.deepEqual(tiered.runs, uniform.runs)
  assert.deepEqual(tiered.models, uniform.models)
  assert.deepEqual(tiered.traceSampling, uniform.traceSampling)
  assert.equal(tiered.provenance.data, source.source.data)

  const note = tiered.notes.find((one) => one.en.includes('per-model success rates in this package'))
  assert.ok(note, tiered.notes.map((one) => one.en).join('\n'))
  assert.ok(note.en.includes('not a measurement of any model'))
  assert.ok(!tiered.notes.some((one) => one.en.includes('no per-model success rates')))
  // Both packages carry the same first sentence: it is true of the format, not
  // of one generation of it.
  assert.deepEqual(tiered.notes[0], uniform.notes[0])
})

/* -------------------------------------------------------------- dispatch */

test('the shipped declaration names this adapter, and the fingerprint holds without it', () => {
  const package_ = raw()
  assert.equal(package_.agentlens_format, 'promptwise@1')
  const tag = parseFormatTag(package_.agentlens_format)
  // `shell/sniff` matches the part before the '@' against the registry name, and
  // this adapter fills the roadmap row `promptwise`, so `index.ts` registers it
  // under exactly that name with `formatVersions: ['1']`. The two have to agree:
  // when they did not, every reader who opened the demo met an `unknown-format`
  // warning saying no adapter in the build handled its own package. The version
  // is asserted too — `@2` from a later runner would route here and warn, which
  // is the intended behaviour and not a mismatch.
  assert.deepEqual(tag, { name: 'promptwise', version: '1' })
  assert.equal(sniff('uniform.json', [package_]), 0.95)
  assert.ok(sniff('uniform.json', [package_]) > CONFIDENCE_FLOOR)

  // Stripping the declaration changes nothing: the score is over fields only.
  delete package_.agentlens_format
  assert.equal(sniff('uniform.json', [package_]), 0.95)
})

test('sniff needs runs[] before it counts anything else, and scores foreign files at zero', () => {
  const package_ = raw()
  const runs = [{ learner: 'x', curves: {} }]
  assert.equal(sniff('bare.json', [{ runs }]), 0.6)
  assert.equal(sniff('half.json', [{ runs, config: { models: [] } }]), 0.8)
  // Everything but the runs: an rm-r1 bundle carries `config`-shaped fields too.
  assert.equal(sniff('other.json', [{ config: package_.config, source: package_.source }]), 0)
  assert.equal(sniff('rows.json', [{ id: 1 }, { id: 2 }]), 0)
  assert.equal(sniff('runs.json', [{ runs: [] }]), 0)
  assert.equal(sniff('runs.json', [{ runs: [{ learner: 'x' }] }]), 0)
  assert.equal(sniff('empty.json', []), 0)
  assert.equal(sniff('null.json', [null, 3, 'x', []]), 0)
})

/* ------------------------------------------------------- broken input */

test('nothing package-shaped is an error, not an empty viewer', () => {
  assert.throws(() => parse([]), /no promptwise@1 package/)
  assert.throws(() => parse([fileOf('rows.json', { id: 1 })]), /no promptwise@1 package/)
})

test('a missing config field drops the package rather than defaulting it', () => {
  const source = raw()
  delete source.config.cost_para
  assert.throws(() => parse([fileOf('uniform.json', source)]), /config\.cost_para is not a number/)

  const noSteps = raw()
  delete noSteps.config.steps
  assert.throws(() => parse([fileOf('uniform.json', noSteps)]), /config\.steps is not a number/)
})

test('a missing provenance sentence drops the package: an undisclosed run is not shown', () => {
  const source = raw()
  delete source.source.data
  assert.throws(() => parse([fileOf('uniform.json', source)]), /source\.data is not a string/)
})

test('one unreadable run is dropped and named; the other seven still open', () => {
  const source = raw()
  source.runs[3].curves.opr = source.runs[3].curves.opr.slice(0, 900)
  const parsed = parse([fileOf('uniform.json', source)])
  assert.equal(parsed.runs.length, 7)
  assert.ok(!parsed.runs.some((run) => run.learner === 'GtS'))
  const note = parsed.notes.find((one) => one.en.includes('could not be read'))
  assert.ok(note)
  assert.ok(note.en.includes('run "GtS": curves.opr has 900 points, curves.t has 1000'), note.en)
  assert.ok(note.zh.includes('run "GtS": curves.opr has 900 points'), note.zh)
})

test('an unreadable step is dropped and counted, and a mis-shaped belief loses only itself', () => {
  const source = raw()
  const run = source.runs[0]
  const believing = run.steps.findIndex((step: Json) => step.rounds[0].beliefs !== undefined)
  assert.ok(believing > 1)
  run.steps[1].outcome = 'exploded'
  run.steps[believing].rounds[0].beliefs.ucb_q = [0.1, 0.2]
  const parsed = parse([fileOf('uniform.json', source)])
  const first = parsed.runs[0]

  assert.equal(first.steps.length, run.steps.length - 1)
  assert.ok(!first.steps.some((step) => step.t === run.steps[1].t))
  // The attempt survives; only the belief that cannot be indexed is dropped.
  const kept = first.steps.find((step) => step.t === run.steps[believing].t)
  assert.ok(kept)
  assert.equal(kept.attempts[0].beliefs, undefined)
  assert.equal(kept.attempts[0].arm, run.steps[believing].rounds[0].arm)

  const dropped = parsed.notes.find((one) => one.en.includes('sampled steps could not be read'))
  assert.ok(dropped)
  assert.ok(dropped.en.includes('promptwise: 1 of the'), dropped.en)
  const beliefs = parsed.notes.find((one) => one.en.includes('belief arrays that do not line up'))
  assert.ok(beliefs)
  assert.ok(beliefs.en.includes('promptwise: 1 attempts'), beliefs.en)
  assert.ok(beliefs.zh.includes('5 个模型对不上'), beliefs.zh)
})

test('a stated null reward is kept; an absent one takes its step with it', () => {
  const source = raw()
  const run = source.runs[0]
  // The runner writes `null` when the round spent no call. That is an outcome.
  run.steps[0].rounds[0].reward = null
  // A missing reward is not that outcome, and reading it as one would put "no
  // call" on screen on no evidence.
  delete run.steps[3].rounds[0].reward
  const parsed = parse([fileOf('uniform.json', source)])
  const first = parsed.runs[0]

  assert.equal(first.steps[0].attempts[0].reward, null)
  assert.equal(first.steps.length, run.steps.length - 1)
  assert.ok(!first.steps.some((step) => step.t === run.steps[3].t))
})

test('a run that fails to read leaves behind no note naming a learner nobody can see', () => {
  const source = raw()
  // A caveat-worthy field first, then a fatal one: the caveat must not survive
  // the run it describes.
  source.runs[0].final.cost = 99
  source.runs[0].steps = 'not an array'
  const parsed = parse([fileOf('uniform.json', source)])

  assert.equal(parsed.runs.length, 7)
  assert.ok(!parsed.notes.some((note) => note.en.includes('states final cost = 99')))
  const dropped = parsed.notes.find((note) => note.en.includes('could not be read and is not shown'))
  assert.ok(dropped)
  assert.ok(dropped.en.includes('run "promptwise": steps is not an array'), dropped.en)
})

test('a final that is not the curve\'s last point is reported, not quietly replaced', () => {
  const source = raw()
  source.runs[0].final.cost = 99
  const parsed = parse([fileOf('uniform.json', source)])
  assert.equal(parsed.runs[0].final.cost, 99)
  const note = parsed.notes.find((one) => one.en.includes('but the last point'))
  assert.ok(note)
  assert.ok(note.en.includes('promptwise: the package states final cost = 99'), note.en)
  assert.ok(note.en.includes(String(parsed.runs[0].curves.cost.at(-1))))
})

test('visitation that does not sum to 1 is reported with the sum it does reach', () => {
  const source = raw()
  source.runs[0].visitation.MODEL_B = 0.5
  const parsed = parse([fileOf('uniform.json', source)])
  const note = parsed.notes.find((one) => one.en.includes('visitation shares sum to'))
  assert.ok(note)
  assert.ok(note.en.includes('promptwise: the visitation shares sum to 0.51982'), note.en)
})

test('two packages are two worlds: the second is named, never merged into the first', () => {
  const second = raw()
  second.config.success_rates = { MODEL_A: 0.9, MODEL_B: 0.3, MODEL_C: 0.8, MODEL_D: 0.4, MODEL_E: 0.45 }
  const parsed = parse([fileOf('uniform.json', raw()), fileOf('tiered.json', second)])

  assert.equal(parsed.runs.length, 8)
  assert.equal(parsed.config.successRates, raw().config.success_rates)
  const note = parsed.notes.find((one) => one.en.includes('PromptWise packages were dropped'))
  assert.ok(note)
  assert.ok(note.en.includes('2 PromptWise packages were dropped; only uniform.json is shown'), note.en)
  assert.ok(note.en.includes('Not shown: tiered.json'), note.en)
  assert.ok(note.zh.includes('tiered.json'), note.zh)
})
