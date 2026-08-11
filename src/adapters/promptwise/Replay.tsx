/**
 * V3 — the replay. Why the router chose what it chose.
 *
 * A run's `steps` are one prompt each, and a step is a chain of calls: the
 * router picks an arm, the arm fails, it picks again. The paper's claim lives in
 * that chain, so the chain is the row — arm names and costs in order, on the
 * primary line, at the same height for every row so the eye can run down 268 of
 * them and see escalation without opening anything.
 *
 * Five things here are not obvious:
 *
 *   - the panel exists to show a decision, not an outcome. The bars are
 *     `beliefs.q` and `beliefs.utility` for every arm at the moment of the
 *     choice, with the chosen arm and the utility argmax both marked, and
 *     underneath them `utility = 1 - cost_para * cost / q` recomputed from the
 *     config's own `costPara` and the pool's own costs. The identity is checked,
 *     not asserted: every arm of every round is recomputed and the round says
 *     how many matched. A package whose numbers do not satisfy it will say so on
 *     screen rather than have this file claim they do;
 *   - "the chosen arm is the maximum" is likewise computed per round and never
 *     assumed. It is true of every belief-bearing round in the uniform package,
 *     and it is exactly what a learner like `random` will not do, and both are
 *     the sentence the reader is owed;
 *   - rounds with no beliefs are the forced-exploration rounds — the runner
 *     records an estimate only where the router had one. They say so. Five empty
 *     bar pairs would read as "the router believed nothing", which is a
 *     different and false claim. A run in which NO round carries beliefs (only
 *     `promptwise` publishes them in the uniform package) says that too, once,
 *     rather than repeating the same absence on every step;
 *   - the list is a sample of one epoch, and that is stated above the list with
 *     the package's own `traceSampling` strings quoted verbatim — near the rows
 *     it qualifies, not in a footer. Every count on screen carries the run it
 *     belongs to and what it is out of;
 *   - `↗` in a chain means only that the round cost more than the round before
 *     it. The word "escalated" is the run's own per-step flag, and the two can
 *     disagree — 9 steps of the uniform package's `RtS` run carry a cost
 *     increase without the flag. The legend says which is which, the filter uses
 *     the flag, and a selected step where they disagree says so.
 *
 * Arm names, learner names, outcome tokens, costs and every number out of a
 * belief array are DATA: they render exactly as they arrived, in every language.
 */

import { useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { selectRecord } from '../../shell/router'
import { VirtualList } from '../../shell/VirtualList'
import type { Attempt, ModelSpec, PromptWiseModel, Run, Step, StepOutcome } from './contract'
import './replay.css'

/**
 * Matches `--rp-row-h` in replay.css: 5 + 18 + 2 + 15 + 5 padding/lines/gap plus
 * the 1px rule under the row. The scrollbar is made of this estimate until every
 * row has been measured, so it tracks the stylesheet exactly.
 */
const ROW_HEIGHT = 46

type EscalationFilter = 'all' | 'escalated'
type OutcomeFilter = StepOutcome | 'all'

/** The order outcomes are offered in; anything else follows, in first-seen order. */
const OUTCOME_ORDER: StepOutcome[] = ['success', 'gave_up', 'budget_exhausted']

export interface ReplayProps {
  model: PromptWiseModel
  /** `?record=` — `<learner>:<t>`. See `stepId`. */
  recordId?: string
  /** Pins the run when something above this view owns that choice. */
  run?: Run
  /** Given with `run`, the picker stays and hands the choice back up. */
  onSelectRun?: (run: Run) => void
}

/**
 * The id a deep link carries: `<learner>:<t>`.
 *
 * `t` alone would name eight different steps in the uniform package — one per
 * learner — and the whole point of mailing one of these is that it opens the
 * decision the sender was looking at. Learner names are the run's own and are
 * not encoded here; `types.ts` requires ids to survive a retype without
 * encoding, and no learner name in any package so far carries `#`, `?`, `&` or
 * a space. `resolveStep` splits on the LAST colon, so a learner name that ever
 * carries one still resolves.
 */
export function stepId(run: Run, step: Step): string {
  return `${run.learner}:${step.t}`
}

export interface LocatedStep {
  run: Run
  step: Step
}

/**
 * `?record=` back to a step, in the two forms that get typed into an email: the
 * minted `<learner>:<t>`, and a bare `t` — but a bare `t` only when exactly one
 * run in the package carries a trace, so that it can name only one step. A
 * record id that names a run explicitly and misses is a miss, never a fallback
 * to a guess: silently opening someone else's run is worse than reporting it.
 */
export function resolveStep(model: PromptWiseModel, recordId: string | undefined): LocatedStep | null {
  if (recordId === undefined || recordId === '') return null

  const cut = recordId.lastIndexOf(':')
  if (cut > 0) {
    const learner = recordId.slice(0, cut)
    const tail = recordId.slice(cut + 1)
    if (!/^\d+$/.test(tail)) return null
    const t = Number(tail)
    for (const run of model.runs) {
      if (run.learner !== learner) continue
      const step = run.steps.find((one) => one.t === t)
      if (step) return { run, step }
    }
    return null
  }

  if (!/^\d+$/.test(recordId)) return null
  const traced = model.runs.filter((one) => one.steps.length > 0)
  if (traced.length !== 1) return null
  const t = Number(recordId)
  const step = traced[0].steps.find((one) => one.t === t)
  return step ? { run: traced[0], step } : null
}

export const Replay: FC<ReplayProps> = ({ model, recordId, run, onSelectRun }) => {
  const t = useT()
  const [escalation, setEscalation] = useState<EscalationFilter>('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')

  // `?record=` resolves against the whole package, not the run on screen: a link
  // into a run the reader is not looking at must still open it.
  const linked = useMemo(() => resolveStep(model, recordId), [model, recordId])
  const linkMissed = recordId !== undefined && recordId !== '' && linked === null

  const traced = useMemo(() => model.runs.filter((one) => one.steps.length > 0), [model.runs])
  const fallbackRun = traced[0] ?? model.runs[0]

  // The deep link is the initial selection, not an effect that corrects one —
  // an effect paints the wrong step first, and that frame is what a mailed link
  // is judged on.
  const [ownRun, setOwnRun] = useState<string>(() => (linked?.run ?? fallbackRun)?.learner ?? '')
  const [selectedT, setSelectedT] = useState<number | null>(linked?.step.t ?? null)
  const [lastRecordId, setLastRecordId] = useState(recordId)
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId)
    setSelectedT(linked?.step.t ?? null)
    if (linked) setOwnRun(linked.run.learner)
  }

  // Steps this view put in the URL itself. A `?record=` from outside is
  // somebody's link and scrolls the list to its step; one written by the click
  // below is the row already under the cursor, and scrolling to it would yank
  // the list away.
  const selfSelected = useRef<string | null>(null)

  const activeRun = run ?? model.runs.find((one) => one.learner === ownRun) ?? fallbackRun
  const steps = activeRun?.steps ?? []

  const outcomes = useMemo(() => {
    const seen = [...new Set(steps.map((one) => one.outcome))]
    return seen.sort((a, b) => orderOf(a) - orderOf(b))
  }, [steps])

  const filtered = useMemo(
    () => steps.filter((one) => stepMatches(one, escalation, outcome)),
    [steps, escalation, outcome],
  )

  const escalations = useMemo(() => steps.filter((one) => one.escalated).length, [steps])
  const largestT = useMemo(() => steps.reduce((most, one) => Math.max(most, one.t), -1), [steps])
  const anyBeliefs = useMemo(
    () => steps.some((one) => one.attempts.some((attempt) => attempt.beliefs !== undefined)),
    [steps],
  )
  const believers = useMemo(
    () =>
      model.runs
        .filter((one) => one.steps.some((step) => step.attempts.some((a) => a.beliefs !== undefined)))
        .map((one) => one.learner),
    [model.runs],
  )

  const pool = model.models.length > 0 ? model.models : model.config.models

  if (activeRun === undefined) {
    return (
      <section className="rp rp-bare">
        <p className="notice">
          {t({
            en: 'This package carries no runs, so there is no decision to replay.',
            zh: '这个数据包里没有任何运行，也就没有可回放的决策。',
          })}
        </p>
      </section>
    )
  }

  const selected =
    steps.find((one) => one.t === selectedT) ?? filtered[0] ?? steps[0] ?? undefined
  const hiddenByFilter =
    selected !== undefined && !filtered.some((one) => one.t === selected.t)

  // Only a link from outside drives scrolling.
  const linkedHere = linked !== null && linked.run.learner === activeRun.learner
  const scrollTo =
    linkedHere && linked !== null && stepId(linked.run, linked.step) !== selfSelected.current
      ? filtered.findIndex((one) => one.t === linked.step.t)
      : -1

  const shown = filtered.length.toLocaleString()
  const sampled = steps.length.toLocaleString()
  const perEpoch = model.config.steps
  // The denominator is only used when the package's own step count can actually
  // contain this trace. A trace whose largest `t` is past it would make "N of M"
  // a false statement about the run, so the disagreement is reported instead.
  const denominatorHolds = perEpoch > 0 && largestT < perEpoch

  return (
    <section className="rp">
      <div className="rp-left">
        <div className="rp-filters cluster">
          {/* Hidden only when the choice is owned above this view and no way was
              given to hand it back — never because there is one run: with one
              run the picker is still what names it on screen. */}
          {(run === undefined || onSelectRun !== undefined) && model.runs.length > 0 && (
            <label className="rp-field">
              <span className="sr-only">{t({ en: 'Run', zh: '运行' })}</span>
              <select
                value={activeRun.learner}
                onChange={(event) => {
                  const next = model.runs.find((one) => one.learner === event.target.value)
                  if (!next) return
                  setSelectedT(null)
                  if (onSelectRun) onSelectRun(next)
                  else setOwnRun(next.learner)
                  // The URL is the selection. Left alone, it would still name a
                  // step of the run just left, and the shell's "Copy link" would
                  // hand someone a decision that is not the one on screen. The
                  // step written here is the one this view is about to select —
                  // the same fallback the render below makes.
                  const opening =
                    next.steps.find((one) => stepMatches(one, escalation, outcome)) ?? next.steps[0]
                  if (opening === undefined) selectRecord(undefined)
                  else {
                    // Written by this view, so it must not also scroll the list.
                    selfSelected.current = stepId(next, opening)
                    selectRecord(selfSelected.current)
                  }
                }}
              >
                {model.runs.map((one) => (
                  <option key={one.learner} value={one.learner}>
                    {/* The learner name is the run's own; the count beside it is
                        this view's, and says what the picker is picking. */}
                    {one.learner} ·{' '}
                    {t({
                      en: `${one.steps.length.toLocaleString()} sampled`,
                      zh: `抽样 ${one.steps.length.toLocaleString()} 步`,
                    })}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="rp-field">
            <span className="sr-only">{t({ en: 'Escalations', zh: '是否升级' })}</span>
            <select
              value={escalation}
              onChange={(event) => setEscalation(event.target.value as EscalationFilter)}
            >
              <option value="all">{t({ en: 'All sampled steps', zh: '全部抽样步骤' })}</option>
              <option value="escalated">
                {t({
                  en: `Escalations only (${escalations.toLocaleString()})`,
                  zh: `只看升级的步骤（${escalations.toLocaleString()}）`,
                })}
              </option>
            </select>
          </label>

          <label className="rp-field">
            <span className="sr-only">{t({ en: 'Outcome', zh: '结束方式' })}</span>
            <select
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
            >
              <option value="all">{t({ en: 'Any outcome', zh: '不限结束方式' })}</option>
              {outcomes.map((one) => (
                // The token is the runner's own word and is never translated;
                // only the frame around it is this view's.
                <option key={one} value={one}>
                  {t({ en: `only ${one}`, zh: `只看 ${one}` })}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="rp-counts">
          <span>
            {t({
              en: `${shown} of ${sampled} sampled steps`,
              zh: `抽样 ${sampled} 步，显示 ${shown} 步`,
            })}
          </span>
          <span>
            {t({ en: `· run ${activeRun.learner}`, zh: `· 运行 ${activeRun.learner}` })}
          </span>
          <span>
            {t({
              en: `· ${escalations.toLocaleString()} of them escalated`,
              zh: `· 其中 ${escalations.toLocaleString()} 步发生升级`,
            })}
          </span>
        </div>

        {/* The disclosure sits here, above the rows it qualifies, because a
            reader who scrolls a list of 104 steps and never learns it is a
            sample of 1,000 has been misled by this panel's silence. Both
            `traceSampling` strings are the package's own and are quoted whole. */}
        <div className="rp-sampling">
          <p>
            {denominatorHolds
              ? t({
                  en: `A sampled trace, not the whole run: ${sampled} of the ${perEpoch.toLocaleString()} steps run ${activeRun.learner} takes in an epoch${epochsTail(model.config.epochs).en}.`,
                  zh: `这是抽样的轨迹，不是整段运行：运行 ${activeRun.learner} 每个 epoch 走 ${perEpoch.toLocaleString()} 步，这里取了其中 ${sampled} 步${epochsTail(model.config.epochs).zh}。`,
                })
              : t({
                  en: `A sampled trace, not the whole run: ${sampled} steps of run ${activeRun.learner}. The package puts ${perEpoch.toLocaleString()} steps in an epoch, which does not reach this trace's largest t (${largestT.toLocaleString()}), so it is not used as a denominator here.`,
                  zh: `这是抽样的轨迹，不是整段运行：来自运行 ${activeRun.learner}，共 ${sampled} 步。数据包说一个 epoch 有 ${perEpoch.toLocaleString()} 步，但这条轨迹里最大的 t 是 ${largestT.toLocaleString()}，两者对不上，所以这里不拿它当分母。`,
                })}
          </p>
          <p>
            <span className="faint">{t({ en: 'epoch', zh: 'epoch' })}</span>{' '}
            <q className="rp-quote">{model.traceSampling.epoch}</q>
          </p>
          <p>
            <span className="faint">{t({ en: 'sampling rule', zh: '抽样规则' })}</span>{' '}
            <q className="rp-quote">{model.traceSampling.rule}</q>
          </p>
          <p className="faint">
            {t({
              en: "Both lines are the package's own words, quoted as they arrived.",
              zh: '以上两行是数据包里的原话，原样引出。',
            })}
          </p>
        </div>

        {linkMissed && (
          <p className="notice warn">
            {t({ en: `no step “${recordId}” here`, zh: `这里没有「${recordId}」这一步` })}
          </p>
        )}

        {linked !== null && !linkedHere && (
          <p className="notice">
            {t({
              en: `The linked step is in run ${linked.run.learner}; this list is run ${activeRun.learner}.`,
              zh: `链接指向的那一步在运行 ${linked.run.learner} 里，而当前列表是运行 ${activeRun.learner}。`,
            })}
          </p>
        )}

        <p className="rp-legend faint">
          <span>
            <span className="rp-rail ok" aria-hidden="true" /> success
          </span>
          <span>
            <span className="rp-rail warn" aria-hidden="true" /> gave_up
          </span>
          <span>
            <span className="rp-rail bad" aria-hidden="true" /> budget_exhausted
          </span>
          <span className="rp-legend-hint">
            {t({
              en: 'each row: the chain of calls with its costs, then t, the prompt and how the step ended. ✓ solved it, ✗ did not; ↗ means that call cost more than the one before it',
              zh: '每行两行：上面是这一步依次调用了谁、各花多少，下面是 t、提示编号和结束方式。✓ 表示这次调用解决了，✗ 表示没有；↗ 表示这次调用比上一次更贵',
            })}
          </span>
        </p>

        <div className="rp-list">
          <VirtualList
            items={filtered}
            estimateSize={ROW_HEIGHT}
            scrollToIndex={scrollTo >= 0 ? scrollTo : undefined}
            getKey={(one) => one.t}
            label={t({
              en: `Sampled steps of run ${activeRun.learner}`,
              zh: `运行 ${activeRun.learner} 的抽样步骤`,
            })}
            empty={
              <span className="muted">
                {t({
                  en: 'No step in this run matches these filters.',
                  zh: '这次运行里没有步骤符合当前筛选。',
                })}
              </span>
            }
            renderRow={(one) => (
              <button
                type="button"
                className="list-row rp-row"
                aria-current={one.t === selected?.t || undefined}
                onClick={() => {
                  // The URL is the selection, so the shell's "Copy link" hands
                  // over the decision on screen. It replaces rather than pushes:
                  // Back leaves the demo instead of walking every row clicked.
                  selfSelected.current = stepId(activeRun, one)
                  setSelectedT(one.t)
                  selectRecord(stepId(activeRun, one))
                }}
              >
                <span className={`rp-rail ${outcomeClass(one.outcome)}`} aria-hidden="true" />
                <span className="sr-only">{one.outcome},</span>
                <span className="rp-row-lines">
                  <span className="rp-chain truncate">
                    {one.attempts.map((attempt, index) => (
                      <span key={index} className="rp-link">
                        {index > 0 && (
                          <Arrow dearer={attempt.cost > one.attempts[index - 1].cost} />
                        )}
                        <span className="rp-arm">{attempt.arm}</span>
                        <span className="rp-cost">{dataNumber(attempt.cost)}</span>
                        <Mark reward={attempt.reward} />
                      </span>
                    ))}
                  </span>
                  <span className="rp-row-meta truncate">{metaOf(one, t)}</span>
                </span>
              </button>
            )}
          />
        </div>
      </div>

      {selected ? (
        <Detail
          model={model}
          pool={pool}
          run={activeRun}
          step={selected}
          hiddenByFilter={hiddenByFilter}
          runHasBeliefs={anyBeliefs}
          believers={believers}
        />
      ) : (
        <div className="rp-main panel">
          <div className="panel-body rp-blank muted">
            {t({
              en: `Run ${activeRun.learner} carries no sampled steps. The run picker above says how many each run has.`,
              zh: `运行 ${activeRun.learner} 没有抽样步骤。上面的运行下拉框标出了每次运行各有多少步。`,
            })}
          </div>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------- detail */

interface DetailProps {
  model: PromptWiseModel
  pool: readonly ModelSpec[]
  run: Run
  step: Step
  hiddenByFilter: boolean
  /** Whether any round of this run carries beliefs; decides which absence is stated. */
  runHasBeliefs: boolean
  /** The runs that do carry them, named so the reader can go and find one. */
  believers: readonly string[]
}

const Detail: FC<DetailProps> = ({
  model,
  pool,
  run,
  step,
  hiddenByFilter,
  runHasBeliefs,
  believers,
}) => {
  const t = useT()
  const summed = step.attempts.reduce((total, one) => total + one.cost, 0)
  // `totalCost` is assembled by this adapter's parse, not carried by the runner,
  // and it is the only figure on this screen that no package states. Showing it
  // over a chain that adds up to something else would be a number the rows
  // themselves contradict, so it is checked against them rather than trusted.
  // The slack is the rounding the parse documents — 5 decimals — and nothing
  // more, so a real disagreement still surfaces.
  const sumAgrees = Math.abs(summed - step.totalCost) <= 5e-6 + 1e-9 * Math.max(1, Math.abs(summed))
  const dearerRound = step.attempts.some(
    (one, index) => index > 0 && one.cost > step.attempts[index - 1].cost,
  )

  return (
    <div className="rp-main panel">
      <header className="rp-head">
        <div className="cluster">
          <span className={`badge ${outcomeClass(step.outcome)}`}>{step.outcome}</span>
          {step.escalated && <span className="badge info">escalated</span>}
          <span className="rp-head-line">
            {t({
              en: `Step t = ${step.t} of run ${run.learner}`,
              zh: `运行 ${run.learner} 里 t = ${step.t} 的这一步`,
            })}
          </span>
          {hiddenByFilter && (
            <span className="badge warn">
              {t({ en: 'outside the current filter', zh: '不在当前筛选范围内' })}
            </span>
          )}
        </div>

        <div className="rp-meta faint">
          <span>{t({ en: `prompt id ${step.promptId}`, zh: `提示 id ${step.promptId}` })}</span>
          <span>· {t(roundsWord(step.attempts.length))}</span>
          <span>
            ·{' '}
            {t({
              en: `rd_budget ${model.config.rdBudget}`,
              zh: `rd_budget ${model.config.rdBudget}`,
            })}
          </span>
          <span>
            ·{' '}
            {t({
              en: `total cost ${sumNumber(step.totalCost)}`,
              zh: `总成本 ${sumNumber(step.totalCost)}`,
            })}
          </span>
          <span className="rp-id">
            · {t({ en: 'link id', zh: '链接 id' })} <code>{stepId(run, step)}</code>
          </span>
        </div>

        {!sumAgrees && (
          <p className="notice warn">
            {t({
              en: `The rounds below cost ${sumNumber(summed)} together, and the step's own totalCost is ${sumNumber(step.totalCost)}. Both are shown; neither is corrected here.`,
              zh: `下面各轮加起来是 ${sumNumber(summed)}，而这一步自己的 totalCost 是 ${sumNumber(step.totalCost)}。两个数都照原样显示，这里不做修正。`,
            })}
          </p>
        )}

        {/* The flag and the costs are two different statements, and a reader who
            sees ↗ on a step the run did not flag deserves to be told which is
            which rather than left to assume a rendering fault. */}
        {dearerRound !== step.escalated && (
          <p className="notice">
            {step.escalated
              ? t({
                  en: 'The run flags this step escalated, though no round here cost more than the one before it. The flag is the run’s own field; the ↗ marks are read off the costs.',
                  zh: '这次运行把这一步标成了升级，但这里没有哪一轮比上一轮更贵。升级标记是运行自己的字段，↗ 则是按成本算出来的。',
                })
              : t({
                  en: 'A round here cost more than the one before it, and the run does not flag this step escalated. The flag is the run’s own field; the ↗ marks are read off the costs.',
                  zh: '这里有一轮比上一轮更贵，但这次运行没有把这一步标成升级。升级标记是运行自己的字段，↗ 则是按成本算出来的。',
                })}
          </p>
        )}
      </header>

      <div className="panel-body rp-body">
        {!runHasBeliefs && (
          <p className="notice">
            {believers.length > 0
              ? t({
                  en: `No round of run ${run.learner} carries beliefs, so there is nothing to draw for any of its steps. The runs that do record them: ${believers.join(', ')}.`,
                  zh: `运行 ${run.learner} 的每一轮都没有记录 beliefs，因此它的任何一步都画不出信念条。有记录的运行是：${believers.join('、')}。`,
                })
              : t({
                  en: 'No run in this package records beliefs, so no round can show what the router believed at the moment it chose.',
                  zh: '这个数据包里没有任何一次运行记录了 beliefs，所以没有哪一轮能显示路由器下决定时的信念。',
                })}
          </p>
        )}

        <ol className="rp-rounds">
          {step.attempts.map((attempt, index) => (
            <Round
              key={index}
              index={index}
              attempt={attempt}
              pool={pool}
              costPara={model.config.costPara}
              runHasBeliefs={runHasBeliefs}
            />
          ))}
        </ol>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- round */

interface RoundProps {
  index: number
  attempt: Attempt
  pool: readonly ModelSpec[]
  costPara: number
  runHasBeliefs: boolean
}

const Round: FC<RoundProps> = ({ index, attempt, pool, costPara, runHasBeliefs }) => {
  const t = useT()
  const beliefs = attempt.beliefs

  return (
    <li className="rp-round">
      <header className="rp-round-head">
        <span className="rp-round-n">
          {t({ en: `round ${index + 1}`, zh: `第 ${index + 1} 轮` })}
        </span>
        <span className="rp-arm rp-arm-lead">{attempt.arm}</span>
        <span className="faint">
          {t({ en: `cost ${dataNumber(attempt.cost)}`, zh: `成本 ${dataNumber(attempt.cost)}` })}
        </span>
        <span className={`badge ${rewardClass(attempt.reward)}`}>{t(rewardWord(attempt.reward))}</span>
      </header>

      {beliefs === undefined ? (
        <p className="rp-noBeliefs muted">
          {runHasBeliefs
            ? t({
                en: 'This round records no beliefs. The runner writes them only where the router had an estimate to maximise; the forced-exploration rounds at the start of a run have none, so there is nothing to draw rather than nothing to believe.',
                zh: '这一轮没有记录 beliefs。运行脚本只在路由器已经有可最大化的估计时才写下它们；一次运行开头的强制探索轮没有估计，所以这里是无从可画，而不是路由器什么都不信。',
              })
            : t({
                en: 'This round records no beliefs — as no round of this run does.',
                zh: '这一轮没有记录 beliefs——这次运行的每一轮都没有。',
              })}
        </p>
      ) : (
        <Bars beliefs={beliefs} chosen={attempt.arm} pool={pool} costPara={costPara} />
      )}
    </li>
  )
}

/* --------------------------------------------------------------------- bars */

interface BarsProps {
  beliefs: { q: number[]; utility: number[] }
  chosen: string
  pool: readonly ModelSpec[]
  costPara: number
}

/**
 * One bar pair per arm, plus the two things that make the pair mean something:
 * which arm was chosen, and which arm the utility argmax was.
 *
 * The axis is 0 → 1 for both bars. `q` is a probability estimate and `utility`
 * is `1 - cost_para * cost / q`, which is at most 1 but can go negative when an
 * arm is dear and its estimate is low — so values outside the axis are clamped
 * to its ends AND counted in a sentence under the bars. The number beside every
 * bar is the file's own, printed as it arrived, so a clamped bar can never be
 * mistaken for the value.
 */
const Bars: FC<BarsProps> = ({ beliefs, chosen, pool, costPara }) => {
  const t = useT()
  const { q, utility } = beliefs

  // A belief array that does not line up with the pool cannot be labelled: the
  // arrays are positional, so drawing them against the wrong names would be a
  // confident lie. Say what is there instead.
  if (q.length !== pool.length || utility.length !== pool.length) {
    return (
      <p className="notice warn">
        {t({
          en: `These beliefs carry ${q.length} q values and ${utility.length} utility values for a pool of ${pool.length} arms. They are positional, so they cannot be tied to arm names here.`,
          zh: `这一轮的 beliefs 里有 ${q.length} 个 q、${utility.length} 个 utility，而模型池有 ${pool.length} 个。这些数组是按位置对应的，对不上就无法把它们和具体的模型名连起来。`,
        })}
      </p>
    )
  }

  const winners = argmaxIndices(utility)
  const chosenIndex = pool.findIndex((one) => one.name === chosen)
  const identities = pool.map((spec, index) => identityOf(spec, q[index], utility[index], costPara))
  const matched = identities.filter((one) => one.matches).length
  const offAxis =
    q.filter((one) => one < 0 || one > 1).length +
    utility.filter((one) => one < 0 || one > 1).length

  return (
    <div className="rp-bars">
      {/* Repeated per row as `rp-bar-label`, which is what a screen reader and a
          narrow window get; this row is the same words laid out as columns. */}
      <div className="rp-bars-head faint" aria-hidden="true">
        <span className="rp-arm-name">{t({ en: 'arm', zh: '模型' })}</span>
        <span className="rp-marks" />
        <span className="rp-col">beliefs.q</span>
        <span className="rp-col">beliefs.utility</span>
      </div>

      {pool.map((spec, index) => {
        const isChosen = index === chosenIndex
        const isMax = winners.includes(index)
        return (
          <div
            key={spec.name}
            className="rp-arm-row"
            data-chosen={isChosen || undefined}
            data-max={isMax || undefined}
          >
            <span className="rp-arm-name">
              <span className="rp-arm">{spec.name}</span>
              <span className="faint rp-arm-cost">{dataNumber(spec.cost)}</span>
            </span>
            <span className="rp-marks">
              {isChosen && (
                <span className="rp-mark-chip is-chosen">{t({ en: 'chosen', zh: '本轮所选' })}</span>
              )}
              {isMax && (
                <span className="rp-mark-chip is-max">
                  {t({ en: 'max utility', zh: 'utility 最大' })}
                </span>
              )}
            </span>
            <Bar value={q[index]} tone="q" label="beliefs.q" />
            <Bar
              value={utility[index]}
              tone="utility"
              label="beliefs.utility"
              unmatched={!identities[index].matches}
            />
          </div>
        )
      })}

      <p className="rp-formula">
        <span className="faint">{t({ en: 'the rule being maximised', zh: '被最大化的式子' })}</span>{' '}
        <code>utility = 1 - cost_para * cost / q</code>
      </p>

      {chosenIndex >= 0 && q[chosenIndex] !== 0 && (
        <p className="rp-substitution">
          <code>
            {`1 - ${dataNumber(costPara)} * ${dataNumber(pool[chosenIndex].cost)} / ${dataNumber(q[chosenIndex])} = ${fixedLike(1 - (costPara * pool[chosenIndex].cost) / q[chosenIndex], utility[chosenIndex])}`}
          </code>{' '}
          <span className="faint">
            {t({
              en: `recomputed for ${pool[chosenIndex].name}; the file records ${dataNumber(utility[chosenIndex])}`,
              zh: `这是替 ${pool[chosenIndex].name} 重算的；文件里记的是 ${dataNumber(utility[chosenIndex])}`,
            })}
          </span>
        </p>
      )}

      <p className="rp-check faint">
        {t({
          en: `${matched.toLocaleString()} of the ${pool.length.toLocaleString()} arms match that rule to the precision the file prints`,
          zh: `按文件里写出的位数比对，${pool.length.toLocaleString()} 个模型中有 ${matched.toLocaleString()} 个与该式子相符`,
        })}
        {matched < pool.length && (
          <>
            {' — '}
            {t({
              en: `the rest are marked; their recomputed value is not the recorded one: ${identities
                .map((one, index) => (one.matches ? null : `${pool[index].name} ${one.expected === null ? '—' : fixedLike(one.expected, utility[index])}`))
                .filter((one) => one !== null)
                .join(', ')}`,
              zh: `其余几个已标出，重算值与记录值不一致：${identities
                .map((one, index) => (one.matches ? null : `${pool[index].name} ${one.expected === null ? '—' : fixedLike(one.expected, utility[index])}`))
                .filter((one) => one !== null)
                .join('、')}`,
            })}
          </>
        )}
      </p>

      <p className="rp-verdict">{t(choiceVerdict(pool, winners, chosenIndex, chosen))}</p>

      {offAxis > 0 && (
        <p className="rp-offaxis faint">
          {t({
            en: `${offAxis.toLocaleString()} of the values on this round fall outside the 0 → 1 axis. Their bars stop at its ends; the numbers beside them are the file's.`,
            zh: `这一轮有 ${offAxis.toLocaleString()} 个数落在 0 → 1 这条轴之外。它们的条形停在轴的两端，旁边的数字仍是文件里的原值。`,
          })}
        </p>
      )}
    </div>
  )
}

/**
 * One bar on the shared 0 → 1 axis, with the file's own number beside it.
 *
 * `label` is the contract's field name, so it is the same word in both
 * languages. It is in the DOM on every row — visible when the pane is too narrow
 * for a header row, and read out either way — while the header above is marked
 * decorative so the two do not double up.
 */
const Bar: FC<{ value: number; tone: 'q' | 'utility'; label: string; unmatched?: boolean }> = ({
  value,
  tone,
  label,
  unmatched,
}) => {
  const width = Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) * 100 : 0
  return (
    <span className="rp-bar" data-tone={tone} data-unmatched={unmatched || undefined}>
      <span className="rp-bar-label">{label}</span>
      <span className="rp-bar-track" aria-hidden="true">
        <span className="rp-bar-fill" style={{ width: `${width}%` }} />
      </span>
      <span className="rp-num">{dataNumber(value)}</span>
    </span>
  )
}

/* ------------------------------------------------------------------- parts */

const Arrow: FC<{ dearer: boolean }> = ({ dearer }) => {
  const t = useT()
  return (
    <span className={dearer ? 'rp-arrow is-dearer' : 'rp-arrow'}>
      <span aria-hidden="true">{dearer ? '↗' : '→'}</span>
      <span className="sr-only">
        {dearer
          ? t({ en: ' then, dearer: ', zh: ' 随后改用更贵的： ' })
          : t({ en: ' then ', zh: ' 随后 ' })}
      </span>
    </span>
  )
}

/**
 * The round's result, in the contract's own terms: 1 solved it, 0 did not, and
 * null is a round that spent no call. The glyph carries it as well as the colour.
 */
const Mark: FC<{ reward: number | null }> = ({ reward }) => {
  const t = useT()
  const glyph = reward === null ? '·' : reward === 1 ? '✓' : '✗'
  return (
    <span className={`rp-mark ${rewardClass(reward)}`}>
      <span aria-hidden="true">{glyph}</span>
      <span className="sr-only"> {t(rewardWord(reward))} </span>
    </span>
  )
}

/* ----------------------------------------------------------------- pure-ish */

/**
 * `utility[g] = 1 - cost_para * cost[g] / q[g]`, recomputed and compared.
 *
 * The tolerance is derived, not chosen. Both numbers arrive rounded to whatever
 * precision the package printed, and a rounding of ±h in q moves the utility by
 * `cost_para * cost / q² * h` — so the bound is that, plus the utility's own
 * half-ulp. It is capped so that a package printing few decimals cannot widen
 * the check into meaninglessness.
 */
function identityOf(
  spec: ModelSpec,
  q: number,
  utility: number,
  costPara: number,
): { expected: number | null; matches: boolean } {
  if (!Number.isFinite(q) || q === 0 || !Number.isFinite(utility)) {
    return { expected: null, matches: false }
  }
  const expected = 1 - (costPara * spec.cost) / q
  const slack = Math.min(
    halfUlp(utility) + halfUlp(q) * Math.abs((costPara * spec.cost) / (q * q)),
    1e-3,
  )
  return { expected, matches: Math.abs(expected - utility) <= slack }
}

/** Half of the last digit the number was printed with. */
function halfUlp(value: number): number {
  const text = String(value)
  if (text.includes('e') || text.includes('E')) return Math.abs(value) * Number.EPSILON * 4
  const dot = text.indexOf('.')
  const decimals = dot < 0 ? 0 : text.length - dot - 1
  return 0.5 * Math.pow(10, -decimals)
}

/** Every index holding the maximum — ties are ties, not a first-wins pick. */
function argmaxIndices(values: readonly number[]): number[] {
  let best = -Infinity
  let winners: number[] = []
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return
    if (value > best) {
      best = value
      winners = [index]
    } else if (value === best) {
      winners.push(index)
    }
  })
  return winners
}

/**
 * Whether the choice was the maximum — computed for this round, never assumed.
 * It holds on every belief-bearing round of the uniform package's `promptwise`
 * run and is exactly what a learner that does not maximise utility will break,
 * which is why it is a sentence per round rather than a claim in a header.
 */
function choiceVerdict(
  pool: readonly ModelSpec[],
  winners: readonly number[],
  chosenIndex: number,
  chosen: string,
): Str {
  if (chosenIndex < 0) {
    return {
      en: `The arm called here, ${chosen}, is not in the pool these beliefs are over, so the choice cannot be compared with them.`,
      zh: `这一轮调用的 ${chosen} 不在这些 beliefs 所覆盖的模型池里，无法把它和这些数值对上。`,
    }
  }
  if (winners.length === 0) {
    return {
      en: 'No utility value on this round is a number, so there is no maximum to compare the choice with.',
      zh: '这一轮没有一个 utility 是可用的数值，也就没有最大值可以和所选项比较。',
    }
  }
  if (!winners.includes(chosenIndex)) {
    const names = winners.map((index) => pool[index].name).join(', ')
    return {
      en: `The arm called here, ${chosen}, is not the utility maximum — ${names} stands higher.`,
      zh: `这一轮调用的是 ${chosen}，但它不是 utility 最大的那个——更高的是 ${names}。`,
    }
  }
  if (winners.length > 1) {
    const others = winners.filter((index) => index !== chosenIndex).map((index) => pool[index].name)
    return {
      en: `${chosen} is at the utility maximum, tied with ${others.join(', ')}.`,
      zh: `${chosen} 处在 utility 的最大值上，与 ${others.join('、')} 并列。`,
    }
  }
  return {
    en: `${chosen} is the utility maximum: the router called the arm its own rule ranked first.`,
    zh: `${chosen} 就是 utility 最大的那个：路由器调用的正是它自己这条规则排在第一的模型。`,
  }
}

/**
 * The row's second line, ordered by what may be lost off its right edge.
 *
 * Both lines are clamped to one line, so that every row is the same 46px the
 * scrollbar is estimated from; at a narrow width the tail ellipsises. `t` leads
 * because it is what the link is made of and what tells one row from the next;
 * the prompt id and the outcome follow, both the run's own tokens; the two
 * counts this view adds are last, and are the first to go.
 */
function metaOf(step: Step, t: (str: Str) => string): string {
  const parts: string[] = [
    `t ${step.t}`,
    t({ en: `prompt ${step.promptId}`, zh: `提示 ${step.promptId}` }),
    step.outcome,
  ]
  if (step.escalated) parts.push(t({ en: 'escalated', zh: '已升级' }))
  parts.push(t(roundsWord(step.attempts.length)))
  parts.push(t({ en: `cost ${sumNumber(step.totalCost)}`, zh: `成本 ${sumNumber(step.totalCost)}` }))
  return parts.join(' · ')
}

function roundsWord(count: number): Str {
  return {
    en: `${count.toLocaleString()} round${count === 1 ? '' : 's'}`,
    zh: `${count.toLocaleString()} 轮`,
  }
}

/**
 * The second denominator: which epoch of how many. Silent when the run had one,
 * where "one epoch of the 1 it ran" would be noise rather than a qualification.
 */
function epochsTail(epochs: number): { en: string; zh: string } {
  if (!Number.isFinite(epochs) || epochs <= 1) return { en: '', zh: '' }
  return {
    en: `, and one epoch of the ${epochs.toLocaleString()} it ran`,
    zh: `；整次运行共 ${epochs.toLocaleString()} 个 epoch，这条轨迹只来自其中一个`,
  }
}

/** The two filters, in one place: the list and the run switch must agree. */
function stepMatches(step: Step, escalation: EscalationFilter, outcome: OutcomeFilter): boolean {
  return (escalation === 'all' || step.escalated) && (outcome === 'all' || step.outcome === outcome)
}

function orderOf(outcome: StepOutcome): number {
  const at = OUTCOME_ORDER.indexOf(outcome)
  return at < 0 ? OUTCOME_ORDER.length : at
}

function outcomeClass(outcome: StepOutcome): string {
  if (outcome === 'success') return 'ok'
  if (outcome === 'gave_up') return 'warn'
  return 'bad'
}

function rewardClass(reward: number | null): string {
  if (reward === null) return ''
  return reward === 1 ? 'ok' : 'bad'
}

/** The contract's own words for what the three values mean. */
function rewardWord(reward: number | null): Str {
  if (reward === null) return { en: 'no call spent', zh: '这一轮没有调用' }
  return reward === 1 ? { en: 'solved', zh: '解决了' } : { en: 'not solved', zh: '没解决' }
}

/**
 * A number that came out of the package, printed exactly as it arrived. Costs,
 * `q` and `utility` are the run's record; re-rounding them for tidiness would
 * put a figure on screen that is in nobody's file.
 */
function dataNumber(value: number): string {
  return String(value)
}

/**
 * A number this adapter computed by adding the package's own. Float addition
 * leaves 5.610000000000001 where the rounds read 0.75 + 1.37 + …, and that tail
 * is an artefact of the sum, not a digit anyone recorded — so it is trimmed at
 * the sixth decimal and no further.
 */
function sumNumber(value: number): string {
  return String(Number(value.toFixed(6)))
}

/** A recomputed value, printed to the same decimals as the recorded one it sits beside. */
function fixedLike(value: number, like: number): string {
  const text = String(like)
  const dot = text.indexOf('.')
  const decimals = dot < 0 || text.includes('e') ? 5 : text.length - dot - 1
  return value.toFixed(Math.min(decimals, 20))
}
