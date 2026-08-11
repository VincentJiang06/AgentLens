/**
 * What the PromptWise views need from a router run.
 *
 * PromptWise routes each prompt to a model, and escalates to a dearer one when
 * the cheap one fails. The upstream repository open-sources the algorithms but
 * not the experiment pipeline — `utils/aux.py` defines `save_stats` and nothing
 * calls it — so there is no file format to adapt to. This one is ours, written
 * by `scripts/promptwise-runner/run.py`, which drives their classes unmodified.
 *
 * Field names and units match what that runner writes; it is the only producer.
 */

import type { Str } from '../../shell/lang'

/** A model in the pool, with the price the run charged for calling it. */
export interface ModelSpec {
  name: string
  cost: number
}

/**
 * What the router believed about each arm at the moment it chose one.
 *
 * `q` is the optimistic success estimate, `utility` the quantity actually
 * maximised: `1 - cost_para * cost[g] / q[g]`. Both are per-arm, in pool order.
 * They exist for one step only and the upstream code never persists them, so
 * without these two arrays a replay can show what was chosen but never why.
 */
export interface Beliefs {
  q: number[]
  utility: number[]
}

/** One call to one model, inside one prompt's attempt. */
export interface Attempt {
  arm: string
  cost: number
  /** 1 solved it, 0 did not. null when the round spent no call. */
  reward: number | null
  /** Absent during the forced-exploration phase, when no estimate exists yet. */
  beliefs?: Beliefs
}

export type StepOutcome = 'success' | 'gave_up' | 'budget_exhausted'

/** One prompt, and every model the router tried on it. */
export interface Step {
  t: number
  promptId: number
  attempts: Attempt[]
  outcome: StepOutcome
  /**
   * A dearer model was tried after a cheaper one failed — the paper's claim,
   * made concrete. The trace sampler keeps every one of these.
   */
  escalated: boolean
  totalCost: number
}

/** Cumulative means over steps, averaged across epochs, as `save_stats` defines them. */
export interface Curves {
  t: number[]
  utility: number[]
  cost: number[]
  success: number[]
  /** Optimal-pick rate: how often the arm chosen was one an oracle would pick. */
  opr: number[]
}

export interface Run {
  learner: string
  curves: Curves
  /** Share of calls that went to each arm, keyed by model name. */
  visitation: Record<string, number>
  final: { utility: number; cost: number; success: number; opr: number }
  /** The oracle's mean utility on the same stream — the ceiling, not a competitor. */
  oracleUtility: number
  /**
   * A sampled decision trace, epoch 0 only. Sampling is declared in
   * `PromptWiseModel.traceSampling`; the curves above are over every epoch.
   */
  steps: Step[]
}

/**
 * Where a package's numbers came from.
 *
 * Every field here is quoted from the package rather than composed by the view.
 * These runs are on invented data — a random success table, not any model's
 * real accuracy — and a chart that omits to say so is a chart that will be
 * screenshotted and misread as a reproduction of the paper.
 */
export interface Provenance {
  what: string
  upstream: string
  branch?: string
  /** What the data is, in the runner's own words. Always rendered, never elided. */
  data: string
  /** Why this world behaves as it does — e.g. whether escalation can appear at all. */
  note?: string
  /** Every way this run departs from upstream's `test.py`, stated. */
  departure?: string
}

export interface Config {
  models: ModelSpec[]
  steps: number
  epochs: number
  seed: number
  costPara: number
  rdBudget: number
  tauExp: number
  regMethod: string
  kernelMethod: string
  /**
   * Per-model success probability when the run set one, or a sentence saying the
   * table came from upstream's uniform `randint`. The difference decides whether
   * escalation is possible at all, so it belongs on screen and not in a footnote.
   */
  successRates: Record<string, number> | string
}

export interface PromptWiseModel {
  runs: Run[]
  config: Config
  provenance: Provenance
  traceSampling: { epoch: string; rule: string }
  /** Pool order, for colour assignment and for indexing `Beliefs` arrays. */
  models: ModelSpec[]
  /** Anything the reader must know that the numbers do not say themselves. */
  notes: Str[]
}
