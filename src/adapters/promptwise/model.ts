/**
 * The pure half of the PromptWise adapter: fingerprint, and one
 * `promptwise@1` package normalised into `contract.ts`.
 *
 * `scripts/promptwise-runner/run.py` is the only producer, so this file is a
 * translation and not a negotiation: snake_case becomes camelCase, `rounds`
 * becomes `attempts`, `ucb_q` becomes `q`, and every sentence the runner wrote
 * about where the numbers came from is carried across untouched — a paraphrase
 * of a provenance sentence is a weaker disclosure than the one the run made.
 *
 * Nothing is defaulted. A field the package could have stated and did not is a
 * broken package: the run is dropped and the notes say which and why. Inventing
 * a zero would put a number on screen that no run ever produced.
 *
 * The one quantity computed here is `Step.totalCost` — see `totalCostOf`.
 *
 * No React and no DOM, so `model.test.ts` exercises every rule below from plain
 * node against the package this repo ships.
 */

import type { Confidence, ParsedFile } from '../../types'
// Type-only: `Str` is the shell's bilingual literal, and nothing in that module
// runs here — `model.ts` is exercised from plain node with no DOM.
import type { Str } from '../../shell/lang'
import type {
  Attempt,
  Beliefs,
  Config,
  Curves,
  ModelSpec,
  PromptWiseModel,
  Provenance,
  Run,
  Step,
  StepOutcome,
} from './contract'

/* -------------------------------------------------------------- fingerprint */

/**
 * Packages declare `"agentlens_format": "promptwise@1"`, and `shell/sniff`
 * matches the part before the `@` — `promptwise` — against the adapter's
 * registry name, which `index.ts` fixes at exactly that. A declared package
 * therefore routes here at confidence 1 without ever being scored, and this
 * fingerprint is what claims everything else: a package whose declaration was
 * stripped by a re-export, and a run assembled by hand from the runner's own
 * fields. `model.test.ts` pins both halves — the declaration the shipped
 * packages carry, and the score with that declaration deleted.
 *
 * `runs[]` is the gate: without a learner and its curves there is nothing here
 * for these views, whatever else the file carries. The three remaining marks
 * together stay under 1, which the shell reserves for a matched declaration.
 *
 * Marks are summed as integers out of `FULL_MARKS`, so a full house is exactly
 * 0.95 and not 0.9500000000000001.
 */
const FULL_MARKS = 100
const RUNS_MARK = 60
const CONFIG_MARK = 20
const SAMPLING_MARK = 10
const SOURCE_MARK = 5

export function sniff(_fileName: string, firstRecords: unknown[]): Confidence {
  if (firstRecords.length === 0) return 0
  let total = 0
  for (const record of firstRecords) total += scoreOne(record)
  return total / (FULL_MARKS * firstRecords.length)
}

function scoreOne(record: unknown): number {
  const fields = asObject(record)
  if (!fields || !looksLikeRuns(fields.runs)) return 0
  let marks = RUNS_MARK
  if (Array.isArray(asObject(fields.config)?.models)) marks += CONFIG_MARK
  if (asObject(fields.trace_sampling) !== null) marks += SAMPLING_MARK
  if (typeof asObject(fields.source)?.data === 'string') marks += SOURCE_MARK
  return marks
}

function looksLikeRuns(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false
  const first = asObject(value[0])
  return typeof first?.learner === 'string' && asObject(first.curves) !== null
}

/* -------------------------------------------------------------------- parse */

export function parse(files: ParsedFile[]): PromptWiseModel {
  const packages: { fileName: string; fields: Record<string, unknown> }[] = []
  for (const file of files) {
    for (const record of file.records) {
      const fields = asObject(record.value)
      if (fields && looksLikeRuns(fields.runs)) packages.push({ fileName: file.fileName, fields })
    }
  }

  const first = packages.at(0)
  if (!first) {
    throw new Error('no promptwise@1 package here — no record carries runs[] with a learner and curves')
  }

  /** Everything read that a reader must be told; ordered under the headline notes. */
  const caveats: Str[] = []
  const read = readPackage(first.fields, caveats)

  // Two packages are two worlds — different success tables, different provenance
  // — and `PromptWiseModel` carries one config and one provenance. Merging them
  // would put one package's numbers under the other's disclosure, so the rest are
  // named and left out rather than folded in.
  if (packages.length > 1) {
    const others = packages.slice(1).map((one) => one.fileName)
    const listed = [...new Set(others)].join(', ')
    caveats.push({
      en:
        `${packages.length} PromptWise packages were dropped; only ${first.fileName} is shown. ` +
        `Each package is its own world with its own success table and its own provenance, ` +
        `so they are not combined. Not shown: ${listed}.`,
      zh:
        `一共拖进来 ${packages.length} 份 PromptWise 数据包，这里只显示 ${first.fileName}。` +
        `每份数据包都是各自的一个世界，有自己的成败表和自己的来源说明，因此不做合并。` +
        `未显示：${listed}。`,
    })
  }

  return { ...read, notes: [...headlineNotes(read), ...caveats] }
}

function readPackage(
  fields: Record<string, unknown>,
  caveats: Str[],
): Omit<PromptWiseModel, 'notes'> {
  const config = readConfig(fields.config)
  const provenance = readProvenance(fields.source)
  const traceSampling = readTraceSampling(fields.trace_sampling)

  const runs: Run[] = []
  for (const value of fields.runs as unknown[]) {
    try {
      runs.push(readRun(value, config.models, caveats))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      caveats.push({
        en: `A run in this package could not be read and is not shown: ${reason}.`,
        zh: `这份数据包里有一个 run 读不出来，没有显示：${reason}。`,
      })
    }
  }
  if (runs.length === 0) throw new Error('every run in this package failed to read')

  return { runs, config, provenance, traceSampling, models: config.models }
}

/* ------------------------------------------------------------------- config */

function readConfig(value: unknown): Config {
  const fields = asObject(value)
  if (!fields) throw new Error('package has no config object')
  const models = readModels(fields.models)
  return {
    models,
    steps: numberAt(fields, 'steps', 'config'),
    epochs: numberAt(fields, 'epochs', 'config'),
    seed: numberAt(fields, 'seed', 'config'),
    costPara: numberAt(fields, 'cost_para', 'config'),
    rdBudget: numberAt(fields, 'rd_budget', 'config'),
    tauExp: numberAt(fields, 'tau_exp', 'config'),
    regMethod: stringAt(fields, 'reg_method', 'config'),
    kernelMethod: stringAt(fields, 'kernel_method', 'config'),
    successRates: readSuccessRates(fields.success_rates),
  }
}

/** Pool order is the file's order: `Beliefs.q[i]` is about `models[i]`. */
function readModels(value: unknown): ModelSpec[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('config.models is empty')
  return value.map((one, index) => {
    const fields = asObject(one)
    if (!fields) throw new Error(`config.models[${index}] is not an object`)
    return {
      name: stringAt(fields, 'name', `config.models[${index}]`),
      cost: numberAt(fields, 'cost', `config.models[${index}]`),
    }
  })
}

/**
 * A table of rates, or the run's own sentence saying it drew one uniformly.
 * Both are kept as they arrived: which of the two it is decides whether
 * escalation can appear at all, and that is not ours to smooth over.
 */
function readSuccessRates(value: unknown): Config['successRates'] {
  if (typeof value === 'string') return value
  const fields = asObject(value)
  if (!fields) throw new Error('config.success_rates is neither a table nor a sentence')
  const rates: Record<string, number> = {}
  for (const [model, rate] of Object.entries(fields)) {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
      throw new Error(`config.success_rates["${model}"] is not a number`)
    }
    rates[model] = rate
  }
  return rates
}

/* --------------------------------------------------------------- provenance */

/** Verbatim, every field. Not trimmed, not reflowed, not translated. */
function readProvenance(value: unknown): Provenance {
  const fields = asObject(value)
  if (!fields) throw new Error('package has no source object')
  return {
    what: stringAt(fields, 'what', 'source'),
    upstream: stringAt(fields, 'upstream', 'source'),
    branch: optionalStringAt(fields, 'branch'),
    data: stringAt(fields, 'data', 'source'),
    note: optionalStringAt(fields, 'note'),
    departure: optionalStringAt(fields, 'departure'),
  }
}

function readTraceSampling(value: unknown): PromptWiseModel['traceSampling'] {
  const fields = asObject(value)
  if (!fields) throw new Error('package has no trace_sampling object')
  return {
    epoch: stringAt(fields, 'epoch', 'trace_sampling'),
    rule: stringAt(fields, 'rule', 'trace_sampling'),
  }
}

/* ---------------------------------------------------------------------- run */

const CURVES: (keyof Omit<Curves, 't'>)[] = ['utility', 'cost', 'success', 'opr']

/** Each visitation share is rounded to 5 dp before it is written, so a pool drifts. */
const VISITATION_TOLERANCE = 1e-3

/**
 * A run, or a throw naming the field that stopped it. Its own caveats are held
 * locally and handed over only once the run is whole: a note about a run the
 * reader cannot see would name a learner that is not on screen.
 */
function readRun(value: unknown, models: ModelSpec[], caveats: Str[]): Run {
  const fields = asObject(value)
  if (!fields) throw new Error('a run is not an object')
  const learner = stringAt(fields, 'learner', 'run')
  const where = `run "${learner}"`
  const oracleUtility = numberAt(fields, 'oracle_utility', where)
  const own: Str[] = []

  const curvesFields = asObject(fields.curves)
  if (!curvesFields) throw new Error(`${where}: no curves object`)
  const t = numbersAt(curvesFields, 't', `${where}.curves`)
  const curves: Curves = {
    t,
    utility: numbersAt(curvesFields, 'utility', `${where}.curves`),
    cost: numbersAt(curvesFields, 'cost', `${where}.curves`),
    success: numbersAt(curvesFields, 'success', `${where}.curves`),
    opr: numbersAt(curvesFields, 'opr', `${where}.curves`),
  }
  for (const key of CURVES) {
    if (curves[key].length !== t.length) {
      throw new Error(`${where}: curves.${key} has ${curves[key].length} points, curves.t has ${t.length}`)
    }
  }

  const finalFields = asObject(fields.final)
  if (!finalFields) throw new Error(`${where}: no final object`)
  const final = {
    utility: numberAt(finalFields, 'utility', `${where}.final`),
    cost: numberAt(finalFields, 'cost', `${where}.final`),
    success: numberAt(finalFields, 'success', `${where}.final`),
    opr: numberAt(finalFields, 'opr', `${where}.final`),
  }
  // `final` is the package's own summary and the curve is the package's own
  // series. They are read separately and compared rather than one being taken
  // from the other: if they ever disagree, the reader is told which two numbers
  // disagree instead of being shown whichever one this file happened to prefer.
  for (const key of CURVES) {
    const last = curves[key].at(-1)
    if (last !== undefined && last !== final[key]) {
      own.push({
        en: `${learner}: the package states final ${key} = ${final[key]}, but the last point of its own ${key} curve is ${last}.`,
        zh: `${learner}：数据包写的最终 ${key} 是 ${final[key]}，但它自己的 ${key} 曲线最后一点是 ${last}。`,
      })
    }
  }

  const visitationFields = asObject(fields.visitation)
  if (!visitationFields) throw new Error(`${where}: no visitation object`)
  const visitation: Record<string, number> = {}
  for (const [model, share] of Object.entries(visitationFields)) {
    if (typeof share !== 'number' || !Number.isFinite(share)) {
      throw new Error(`${where}: visitation["${model}"] is not a number`)
    }
    visitation[model] = share
  }
  const shareTotal = Object.values(visitation).reduce((sum, share) => sum + share, 0)
  if (Math.abs(shareTotal - 1) > VISITATION_TOLERANCE) {
    own.push({
      en: `${learner}: the visitation shares sum to ${shareTotal.toFixed(5)}, not 1, so they are not a full account of the calls this run made.`,
      zh: `${learner}：各模型的调用占比加起来是 ${shareTotal.toFixed(5)}，不是 1，所以它们并没有把这次运行的调用算全。`,
    })
  }

  const rawSteps = fields.steps
  if (!Array.isArray(rawSteps)) throw new Error(`${where}: steps is not an array`)
  const steps: Step[] = []
  let unreadableSteps = 0
  let unreadableBeliefs = 0
  for (const raw of rawSteps) {
    const step = readStep(raw, models.length, () => {
      unreadableBeliefs += 1
    })
    if (step) steps.push(step)
    else unreadableSteps += 1
  }
  if (unreadableSteps > 0) {
    own.push({
      en: `${learner}: ${unreadableSteps} of the ${rawSteps.length} sampled steps could not be read and are not in the trace.`,
      zh: `${learner}：抽样的 ${rawSteps.length} 步里有 ${unreadableSteps} 步读不出来，不在轨迹里。`,
    })
  }
  if (unreadableBeliefs > 0) {
    own.push({
      en: `${learner}: ${unreadableBeliefs} attempts carried belief arrays that do not line up with the ${models.length} models in the pool. The attempts are kept; those beliefs are not shown.`,
      zh: `${learner}：有 ${unreadableBeliefs} 次调用带的置信数组跟池子里的 ${models.length} 个模型对不上。调用本身保留，这些置信值不显示。`,
    })
  }

  caveats.push(...own)
  return { learner, curves, visitation, final, oracleUtility, steps }
}

/* --------------------------------------------------------------------- step */

const OUTCOMES: StepOutcome[] = ['success', 'gave_up', 'budget_exhausted']

function readStep(value: unknown, arms: number, onUnreadableBeliefs: () => void): Step | null {
  const fields = asObject(value)
  if (!fields) return null
  const t = finiteNumber(fields.t)
  const promptId = finiteNumber(fields.prompt_id)
  const outcome = OUTCOMES.find((one) => one === fields.outcome)
  if (t === null || promptId === null || outcome === undefined) return null
  if (typeof fields.escalated !== 'boolean') return null
  if (!Array.isArray(fields.rounds) || fields.rounds.length === 0) return null

  const attempts: Attempt[] = []
  for (const raw of fields.rounds) {
    const attempt = readAttempt(raw, arms, onUnreadableBeliefs)
    // A step is one prompt's whole history; half of it is not a shorter history,
    // it is a wrong one, and its total cost would be wrong too.
    if (!attempt) return null
    attempts.push(attempt)
  }

  return { t, promptId, attempts, outcome, escalated: fields.escalated, totalCost: totalCostOf(attempts) }
}

function readAttempt(value: unknown, arms: number, onUnreadableBeliefs: () => void): Attempt | null {
  const fields = asObject(value)
  if (!fields) return null
  const cost = finiteNumber(fields.cost)
  if (typeof fields.arm !== 'string' || cost === null) return null
  // `null` is a stated outcome — the round spent no call — so it is read, while
  // an absent `reward` is a missing one and takes the attempt with it. Reading
  // the second as the first would put "no call" on screen on no evidence.
  if (!('reward' in fields)) return null
  const reward = fields.reward === null ? null : finiteNumber(fields.reward)
  if (fields.reward !== null && reward === null) return null

  const attempt: Attempt = { arm: fields.arm, cost, reward }
  if (fields.beliefs !== undefined) {
    const beliefs = readBeliefs(fields.beliefs, arms)
    if (beliefs) attempt.beliefs = beliefs
    else onUnreadableBeliefs()
  }
  return attempt
}

/**
 * Both arrays are per-arm in pool order, so a length that is not the pool's
 * cannot be indexed against the models — that is a dropped belief, not a
 * shorter one. `ucb_q` is the runner's name for what `contract.ts` calls `q`.
 */
function readBeliefs(value: unknown, arms: number): Beliefs | null {
  const fields = asObject(value)
  if (!fields) return null
  const q = numberArray(fields.ucb_q)
  const utility = numberArray(fields.utility)
  if (!q || !utility || q.length !== arms || utility.length !== arms) return null
  return { q, utility }
}

/**
 * The one number in `PromptWiseModel` that no package states.
 *
 * The runner writes the price of each call and never the step's total, so a
 * view that wants "what did this prompt cost" has to add it up. Rounded to the
 * 5 decimals the runner itself rounds to, which is float dust removal and not a
 * change of value: `1.37 + 1.6` is 2.9699999999999998 in binary.
 */
function totalCostOf(attempts: Attempt[]): number {
  const total = attempts.reduce((sum, attempt) => sum + attempt.cost, 0)
  return Math.round(total * 1e5) / 1e5
}

/* -------------------------------------------------------------------- notes */

/**
 * What a reader has to know before the first chart means anything. These are
 * AgentLens's own sentences, so they are `Str`; the package's own sentences are
 * in `provenance` and are never rewritten into these.
 */
function headlineNotes(model: Omit<PromptWiseModel, 'notes'>): Str[] {
  const notes: Str[] = []
  const { config, runs } = model

  notes.push({
    en:
      'Synthetic data. A promptwise@1 package is generated, not measured: random prompt embeddings, ' +
      'and a success table drawn from probabilities chosen when the run was made. These curves describe how ' +
      "the routers behave in that invented world — no number here is a model's real accuracy, and none " +
      'reproduces a figure from the PromptWise paper.',
    zh:
      '合成数据。promptwise@1 数据包是生成出来的，不是测出来的：prompt 向量是随机抽的，成败表是按生成这次运行时' +
      '选定的概率抽的。这些曲线描述的是路由器在那个虚构世界里的行为——这里没有一个数字是某个模型的真实准确率，' +
      '也没有一个复现了 PromptWise 论文里的图。',
  })

  const traced = runs.length * config.steps
  const kept = runs.reduce((sum, run) => sum + run.steps.length, 0)
  // Which epoch is the package's own sentence, quoted rather than restated: a
  // later run could trace a different one, and then a hardcoded "epoch 0" here
  // would be a claim about data this adapter had never seen.
  notes.push({
    en:
      `Decision traces are sampled, and cover one epoch — the package says: "${model.traceSampling.epoch}". ` +
      `${kept} steps kept of the ${traced} that epoch ran (${runs.length} learners × ${config.steps} steps); ` +
      `the curves are means over all ${config.epochs} epochs, so a step you can open and a point on a curve ` +
      'are not the same population.',
    zh:
      `决策轨迹是抽样的，而且只覆盖一个 epoch——数据包自己写的是："${model.traceSampling.epoch}"。` +
      `那个 epoch 一共跑了 ${traced} 步（${runs.length} 个学习器 × ${config.steps} 步），这里保留了 ${kept} 步；` +
      `曲线是全部 ${config.epochs} 个 epoch 的均值，所以能点开的某一步，和曲线上的某一点，不是同一批数据。`,
  })

  const escalated = runs.reduce((sum, run) => sum + run.steps.filter((step) => step.escalated).length, 0)
  if (typeof config.successRates === 'string') {
    // The uniform world. The count is stated rather than a claim that escalation
    // does not happen: the switch-on-failure baselines escalate here by
    // construction, and a note that said "none" would be contradicted by the
    // trace directly under it.
    const busiest = [...runs].sort(
      (a, b) => b.steps.filter((s) => s.escalated).length - a.steps.filter((s) => s.escalated).length,
    )[0]
    const busiestCount = busiest.steps.filter((step) => step.escalated).length
    notes.push({
      en:
        `This run set no per-model success rates — config.success_rates reads "${config.successRates}" — so ` +
        'every model succeeds about equally often and none is worth escalating TO. ' +
        (escalated === 0
          ? `None of the ${kept} sampled steps escalated.`
          : `${escalated} of the ${kept} sampled steps still escalated, ${busiestCount} of them in ${busiest.learner} alone.`),
      zh:
        `这次运行没有设定各模型的成功率——config.success_rates 写的是 "${config.successRates}"——所以每个模型的成功率` +
        '差不多，谁都不值得升级过去。' +
        (escalated === 0
          ? `抽样的 ${kept} 步里没有一步发生升级。`
          : `抽样的 ${kept} 步里仍有 ${escalated} 步升级了，其中 ${busiestCount} 步来自 ${busiest.learner} 一个。`),
    })
  } else {
    notes.push({
      en:
        "The per-model success rates in this package's config were chosen when the run was generated. They are " +
        'the input to a simulation, not a measurement of any model — they are what makes escalation possible ' +
        `here, and ${escalated} of the ${kept} sampled steps escalated.`,
      zh:
        '这份数据包 config 里的各模型成功率，是生成这次运行时设定的。它们是模拟的输入，不是对任何模型的测量——' +
        `正是它们让升级成为可能，抽样的 ${kept} 步里有 ${escalated} 步升级了。`,
    })
  }

  const unmarked = runs.reduce((sum, run) => sum + unmarkedEscalations(run.steps), 0)
  if (unmarked > 0) {
    notes.push({
      en:
        `"Escalated" is the run's own mark, and it means the last model tried cost more than the first. ` +
        `${unmarked} further sampled steps did try a dearer model after a cheaper one failed and then ended on a ` +
        'model no dearer than the one they started with; those carry no mark.',
      zh:
        `"升级"是这次运行自己打的标记，指的是最后调用的模型比第一个贵。另有 ${unmarked} 步确实在便宜的模型失败后` +
        '试过更贵的，但最后落在了不比起始模型更贵的模型上；这些步没有被标记。',
    })
  }

  return notes
}

/**
 * Steps the package did not mark as escalations but where a dearer model was
 * tried after a cheaper one failed. The runner compares only the last attempt
 * with the first, so this is the gap between that rule and the sentence
 * `contract.ts` uses to describe it — counted, not silently reconciled.
 */
function unmarkedEscalations(steps: Step[]): number {
  let count = 0
  for (const step of steps) {
    if (step.escalated) continue
    const dearerAfterFailure = step.attempts.some(
      (attempt, index) =>
        attempt.reward === 0 && step.attempts.slice(index + 1).some((later) => later.cost > attempt.cost),
    )
    if (dearerAfterFailure) count += 1
  }
  return count
}

/* ---------------------------------------------------------------- primitives */

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null
  const numbers: number[] = []
  for (const one of value) {
    const number = finiteNumber(one)
    if (number === null) return null
    numbers.push(number)
  }
  return numbers
}

function numberAt(fields: Record<string, unknown>, key: string, where: string): number {
  const number = finiteNumber(fields[key])
  if (number === null) throw new Error(`${where}.${key} is not a number`)
  return number
}

function stringAt(fields: Record<string, unknown>, key: string, where: string): string {
  const value = fields[key]
  if (typeof value !== 'string') throw new Error(`${where}.${key} is not a string`)
  return value
}

function optionalStringAt(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' ? value : undefined
}

function numbersAt(fields: Record<string, unknown>, key: string, where: string): number[] {
  const numbers = numberArray(fields[key])
  if (!numbers) throw new Error(`${where}.${key} is not an array of numbers`)
  return numbers
}
