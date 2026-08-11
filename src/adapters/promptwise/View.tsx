/**
 * The PromptWise adapter's one view: a tab strip over the three real views, and
 * the disclosure that has to be true on all three.
 *
 * It owns four things and nothing else.
 *
 *   - Which tab is showing. A `?record=` link always lands on Replay, whatever
 *     tab the reader left open: that link names one decision, and Replay is also
 *     the only view that reports a link it could not resolve. A package with no
 *     decision trace opens on Pareto instead of Curves — with the trace gone,
 *     the one figure that answers "which router, at what cost" is the honest
 *     first screen, and four panels of cumulative means are not.
 *   - `model.notes`. Nothing else renders them, and the first of them is the
 *     sentence that decides how every number under it should be read: this data
 *     is generated, not measured. So that note is on screen on every tab,
 *     unopened, and the rest are one click away.
 *   - The package's own provenance, its trace-sampling rule and the run's
 *     configuration — the denominators behind the figures the three views draw,
 *     and the only place the pool's prices and the success table are written
 *     out. Every string in that block is the runner's, quoted, never translated.
 *   - Nothing else. Each tab's view owns its own scrolling, its own legends and
 *     its own captions, so this file gives them a bounded box and stays out.
 *
 * The data these packages carry is invented. That is not a caveat this file may
 * put behind a toggle, and it is why the notes block is sized to the note rather
 * than to the space left over.
 */

import { useMemo, useState } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { Curves } from './Curves'
import { Pareto } from './Pareto'
import { Replay } from './Replay'
import type { Config, PromptWiseModel, Provenance } from './contract'
import './view.css'

type TabId = 'curves' | 'pareto' | 'replay'

interface Tab {
  id: TabId
  label: Str
  /** What is behind the tab, in runs or steps. Never a claim, just a count. */
  hint: Str
}

export const View: FC<{ model: PromptWiseModel; recordId?: string }> = ({ model, recordId }) => {
  const t = useT()

  const runs = model.runs.length
  const steps = model.config.steps
  const epochs = model.config.epochs
  // Steps the package actually carries, against the steps that epoch ran. The
  // Replay tab is a sample of a trace and says so itself; the hint here must not
  // promise more rows than there are.
  const kept = useMemo(() => model.runs.reduce((sum, run) => sum + run.steps.length, 0), [model.runs])
  const traced = useMemo(() => model.runs.some((run) => run.steps.length > 0), [model.runs])

  const tabs: Tab[] = [
    {
      id: 'curves',
      label: { en: 'Curves', zh: '曲线' },
      hint: {
        en: `${counted(runs, 'learner', 'learners')} × ${epochs.toLocaleString()} epochs`,
        zh: `${runs.toLocaleString()} 个学习器 × ${epochs.toLocaleString()} 个 epoch`,
      },
    },
    {
      id: 'pareto',
      label: { en: 'Cost vs success', zh: '成本与成功率' },
      hint: {
        en: `${counted(runs, 'run', 'runs')} at their last point`,
        zh: `${runs.toLocaleString()} 次运行的终点`,
      },
    },
    {
      id: 'replay',
      label: { en: 'Replay', zh: '回放' },
      hint: traced
        ? {
            en: `${counted(kept, 'sampled step', 'sampled steps')} of ${(runs * steps).toLocaleString()}`,
            zh: `${(runs * steps).toLocaleString()} 步里抽样保留的 ${kept.toLocaleString()} 步`,
          }
        : { en: 'no decision trace in this package', zh: '这个数据包里没有决策轨迹' },
    },
  ]

  const initial: TabId = hasRecord(recordId) ? 'replay' : traced ? 'curves' : 'pareto'
  const [tab, setTab] = useState<TabId>(initial)

  // The reader's tab choice survives everything except a new `?record=`, which
  // is somebody else's link arriving and has to be obeyed. Adjusted during
  // render rather than in an effect: an effect would paint the old tab first,
  // and that frame is the whole first impression of a mailed link.
  const [lastRecordId, setLastRecordId] = useState(recordId)
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId)
    if (hasRecord(recordId)) setTab('replay')
  }

  return (
    <section className="pwv">
      <div className="pwv-tabs" role="tablist" aria-label={t({ en: 'PromptWise views', zh: 'PromptWise 视图' })}>
        {tabs.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            id={`pwv-tab-${one.id}`}
            aria-selected={tab === one.id}
            aria-controls={`pwv-panel-${one.id}`}
            className={tab === one.id ? 'pwv-tab is-active' : 'pwv-tab'}
            onClick={() => setTab(one.id)}
          >
            <span>{t(one.label)}</span>
            <span className="pwv-tab-hint">{t(one.hint)}</span>
          </button>
        ))}
      </div>

      <About model={model} kept={kept} traced={traced} />

      <div
        className="pwv-panel-area"
        role="tabpanel"
        id={`pwv-panel-${tab}`}
        aria-labelledby={`pwv-tab-${tab}`}
      >
        {tab === 'curves' ? (
          <Curves model={model} />
        ) : tab === 'pareto' ? (
          <Pareto model={model} />
        ) : (
          // No `run`/`onSelectRun`: nothing above this view owns the run choice,
          // so Replay keeps its own picker and its own URL handling.
          <Replay model={model} recordId={recordId} />
        )}
      </div>
    </section>
  )
}

function hasRecord(recordId: string | undefined): boolean {
  return recordId !== undefined && recordId !== ''
}

/**
 * An English count that inflects, and only that. The Chinese side of every
 * `Str` below writes its own measure word, because "1 条" and "8 条" are the
 * same word and a shared helper would only be a place for a wrong one to hide.
 */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/* ---------------------------------------------------------------- about box */

/**
 * What the model knows that the numbers do not say, and where the numbers came
 * from.
 *
 * The first note is never behind the toggle. On these packages it is the
 * sentence saying the data is generated rather than measured, and a synthetic
 * curve presented with its disclosure one click away is a curve that gets
 * screenshotted as a result. The rest — the trace-sampling denominator, the
 * mechanism notes, anything `parse()` had to drop — open with the provenance
 * block, which is where a reader who has decided to check goes next.
 *
 * The box cannot grow past its cap. Below it is the view the reader came for,
 * and a disclosure that leaves no room for the thing it qualifies has stopped
 * qualifying anything.
 */
const About: FC<{ model: PromptWiseModel; kept: number; traced: boolean }> = ({
  model,
  kept,
  traced,
}) => {
  const t = useT()
  const [open, setOpen] = useState(false)

  const notes = model.notes
  const headline = notes.at(0)
  const rest = notes.slice(1)
  const count = notes.length.toLocaleString()
  const runs = model.runs.length
  const steps = model.config.steps

  return (
    <section className="pwv-about" aria-label={t({ en: 'About this data', zh: '关于这批数据' })}>
      <div className="pwv-about-head">
        <span className="pwv-about-title">
          {t({
            en: `About this data · ${counted(notes.length, 'note', 'notes')}`,
            zh: `关于这批数据 · ${count} 条说明`,
          })}
        </span>
        <span className="pwv-about-chip">
          {t({
            en: `${counted(runs, 'learner', 'learners')} · ${steps.toLocaleString()} steps × ${model.config.epochs.toLocaleString()} epochs`,
            zh: `${runs.toLocaleString()} 个学习器 · ${steps.toLocaleString()} 步 × ${model.config.epochs.toLocaleString()} 个 epoch`,
          })}
        </span>
        <span className="pwv-about-chip">
          {traced
            ? t({
                en: `${counted(kept, 'sampled step', 'sampled steps')} of ${(runs * steps).toLocaleString()}`,
                zh: `抽样轨迹 ${kept.toLocaleString()} 步 / 共 ${(runs * steps).toLocaleString()} 步`,
              })
            : t({ en: 'no decision trace', zh: '没有决策轨迹' })}
        </span>
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost pwv-about-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open
            ? t({ en: 'Show fewer', zh: '收起' })
            : t({
                en: `Show all ${count} note${notes.length === 1 ? '' : 's'}, the provenance and the run's settings`,
                zh: `展开全部 ${count} 条说明、来源与这次运行的设置`,
              })}
        </button>
      </div>

      {/* Above the fold in both states. It is the one sentence a reader checks
          before believing any number below it. */}
      {headline !== undefined && <p className="pwv-about-headline">{t(headline)}</p>}

      {open && (
        <div className="pwv-about-body">
          {rest.length > 0 && (
            <ul className="pwv-note-list">
              {rest.map((note) => (
                // Keyed off the English side, as everywhere a `Str` needs a key:
                // a note's identity must not change when the reader switches
                // language.
                <li key={note.en}>{t(note)}</li>
              ))}
            </ul>
          )}
          <ProvenanceBlock provenance={model.provenance} sampling={model.traceSampling} />
          <SetupBlock config={model.config} />
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------------- provenance */

/**
 * The runner's own account of what this data is.
 *
 * Every value here is a string `scripts/promptwise-runner/run.py` wrote and
 * `model.ts` carried across untouched. It is rendered as it arrived — not
 * trimmed, not reflowed, and not translated, which for these packages means a
 * Chinese reader meets these particular sentences in English. That is stated
 * rather than hidden: quietly translating a provenance sentence would make the
 * disclosure this project's own paraphrase instead of the run's own words, and
 * the bilingual notes above already carry the substance on both sides.
 *
 * `upstream` is a URL out of the file and is shown as text, not as a link. A
 * dropped package is untrusted input; a clickable destination it chose is not
 * something this view should hand the reader.
 */
const ProvenanceBlock: FC<{
  provenance: Provenance
  sampling: PromptWiseModel['traceSampling']
}> = ({ provenance, sampling }) => {
  const t = useT()
  const rows: { label: Str; value: string; mono?: boolean }[] = [
    { label: { en: 'what', zh: '这是什么' }, value: provenance.what },
    { label: { en: 'upstream', zh: '上游代码' }, value: provenance.upstream, mono: true },
  ]
  if (provenance.branch !== undefined) {
    rows.push({ label: { en: 'branch', zh: '分支' }, value: provenance.branch, mono: true })
  }
  rows.push({ label: { en: 'data', zh: '数据' }, value: provenance.data })
  if (provenance.note !== undefined) {
    rows.push({ label: { en: 'why this world behaves so', zh: '这个世界为何如此' }, value: provenance.note })
  }
  if (provenance.departure !== undefined) {
    rows.push({ label: { en: 'departures from upstream', zh: '与上游的差异' }, value: provenance.departure })
  }
  rows.push({ label: { en: 'trace: which epoch', zh: '轨迹：哪个 epoch' }, value: sampling.epoch })
  rows.push({ label: { en: 'trace: which steps', zh: '轨迹：哪些步' }, value: sampling.rule })

  return (
    <section className="pwv-block">
      <h4 className="pwv-block-title">
        {t({ en: 'Where these numbers came from', zh: '这些数字是怎么来的' })}
      </h4>
      <p className="pwv-block-note">
        {t({
          en: "Quoted from the package, in the words and the language the run wrote them in.",
          zh: '以下内容照抄自数据包本身，保留这次运行写下时的原话和原文语言。',
        })}
      </p>
      <dl className="pwv-rows">
        {rows.map((row) => (
          <div key={row.label.en} className="pwv-row">
            <dt>{t(row.label)}</dt>
            <dd className={row.mono ? 'mono' : undefined} lang="en">
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/* -------------------------------------------------------------- run setting */

/**
 * The run's own configuration: the pool with its prices, the trade-off constant
 * every utility on screen is computed with, and the success table — or the
 * sentence saying no table was set.
 *
 * This is where the denominators live. `cost_para` is what makes 0.70 utility
 * mean anything, and whether `success_rates` is a table or a sentence decides
 * whether escalating to a dearer model can pay at all in this world. Both are
 * printed exactly as the file holds them: a rate re-rounded here would not be
 * the number the run drew from.
 */
const SetupBlock: FC<{ config: Config }> = ({ config }) => {
  const t = useT()
  const rates = config.successRates

  return (
    <section className="pwv-block">
      <h4 className="pwv-block-title">{t({ en: 'How the run was set up', zh: '这次运行是怎么设定的' })}</h4>
      <dl className="pwv-rows">
        <div className="pwv-row">
          <dt>{t({ en: 'model pool, with prices', zh: '模型池与各自的价格' })}</dt>
          <dd className="mono">
            {config.models.map((one) => `${one.name} ${String(one.cost)}`).join(' · ')}
          </dd>
        </div>
        <div className="pwv-row">
          <dt>
            {t({ en: 'success rate per model', zh: '每个模型的成功率' })}
          </dt>
          <dd className={typeof rates === 'string' ? undefined : 'mono'} lang={typeof rates === 'string' ? 'en' : undefined}>
            {typeof rates === 'string'
              ? rates
              : Object.entries(rates)
                  .map(([model, rate]) => `${model} ${String(rate)}`)
                  .join(' · ')}
          </dd>
        </div>
        <div className="pwv-row">
          <dt>{t({ en: 'utility trade-off (cost_para)', zh: '效用里的成本系数（cost_para）' })}</dt>
          <dd className="mono">{String(config.costPara)}</dd>
        </div>
        <div className="pwv-row">
          <dt>{t({ en: 'retry budget per prompt (rd_budget)', zh: '每条 prompt 的重试预算（rd_budget）' })}</dt>
          <dd className="mono">{String(config.rdBudget)}</dd>
        </div>
        <div className="pwv-row">
          <dt>{t({ en: 'forced exploration (tau_exp)', zh: '强制探索轮数（tau_exp）' })}</dt>
          <dd className="mono">{String(config.tauExp)}</dd>
        </div>
        <div className="pwv-row">
          <dt>{t({ en: 'regression · kernel', zh: '回归方法 · 核方法' })}</dt>
          <dd className="mono">{`${config.regMethod} · ${config.kernelMethod}`}</dd>
        </div>
        <div className="pwv-row">
          <dt>{t({ en: 'steps × epochs · seed', zh: '步数 × epoch 数 · 随机种子' })}</dt>
          <dd className="mono">{`${String(config.steps)} × ${String(config.epochs)} · ${String(config.seed)}`}</dd>
        </div>
      </dl>
    </section>
  )
}
