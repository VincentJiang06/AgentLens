/**
 * The RM-R1 adapter's one view: a tab strip over the three real views.
 *
 * It owns four things and nothing else.
 *
 *   - Which tab is showing. A `?record=` link always lands on Judgements,
 *     whatever tab the reader left open, because that link is how this project
 *     reaches people and it points at one judgement.
 *   - `model.notes`. Nothing else renders them, and they are where the model
 *     says what the numbers cannot: which records are a sample, what was
 *     dropped, which file was salvaged. A demo that shows a sample's accuracy
 *     with the caveat one click away is a demo that misleads — so the block is
 *     sized to the notes it has, states how many there are, and opens itself on
 *     the tab whose numbers those notes qualify.
 *   - The package's own sampling disclosure, and its coverage ledger. The
 *     direction of the bias ("the sample over-represents mistakes") is a note;
 *     the rule that produced it, the hand-picked records, the withheld one and
 *     the files left out are the evidence behind it, and a reader who suspects
 *     cherry-picking can only rule it out from the rule. The ledger says, figure
 *     by figure, which denominator each number on screen is over. Both are
 *     rendered, on whichever tab the reader arrives at, because a disclosure
 *     that has to be found is one the accusation gets to make first.
 *   - The hand-off from the compare view back to the judgement browser, which
 *     goes through the URL like every other selection, so the copied link is
 *     always the record on screen.
 *
 * Each tab's view owns its own scrolling, so this file gives them a bounded
 * box and stays out of it.
 */

import { useMemo, useState } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { selectRecord } from '../../shell/router'
import { JudgmentBrowser } from './JudgmentBrowser'
import { RunCompare, offeredRuns } from './RunCompare'
import { ScoreDashboard } from './ScoreDashboard'
import { alignKey } from './compare'
import type { Run } from './compare'
import type { Benchmark, CoverageEntry, HandPicked, RmR1Model, Sampling } from './contract'
import './view.css'

/** Benchmark names are the data's own; they are never translated. */
const BENCHMARK_LABELS: Record<Benchmark, string> = {
  rewardbench: 'RewardBench',
  'rm-bench': 'RM-Bench',
  'rmb-pairwise': 'RMB pairwise',
  'rmb-bon': 'RMB best-of-n',
}

type TabId = 'judgements' | 'scores' | 'compare'

interface Tab {
  id: TabId
  label: Str
  /** What is behind the tab, in records or runs. Never a claim, just a count. */
  hint: Str
}

export const View: FC<{ model: RmR1Model; recordId?: string }> = ({ model, recordId }) => {
  const t = useT()
  // The same list the Compare tab offers, so the hint under the tab and the
  // picker behind it count runs the same way — one run's several files are one
  // run, and a tab that says otherwise sends the reader to a screen that denies
  // it two lines later.
  const runs = useMemo(() => offeredRuns(model), [model])
  const alignable = useMemo(() => alignableBenchmarks(runs), [runs])
  const pairedRuns = useMemo(() => countPairedRuns(runs), [runs])

  const loaded = model.judgements.length.toLocaleString()
  const tabs: Tab[] = [
    {
      id: 'judgements',
      label: { en: 'Judgements', zh: '判例' },
      hint: { en: `${loaded} loaded`, zh: `已载入 ${loaded} 条` },
    },
    {
      id: 'scores',
      label: { en: 'Scores', zh: '分数' },
      hint: model.rmBench
        ? { en: 'incl. the RM-Bench 3×3 matrix', zh: '含 RM-Bench 3×3 矩阵' }
        : { en: 'recomputed from these logs', zh: '由这些日志重算' },
    },
    {
      id: 'compare',
      label: { en: 'Compare', zh: '对比' },
      // Only a benchmark whose runs share records is named. Counting runs is not
      // enough: two runs of one benchmark can still hold disjoint pairings — a
      // `total_dataset_1` from one checkpoint against a `total_dataset_2` from
      // another — and naming the benchmark here would advertise a screen that
      // opens on "0 records aligned".
      hint:
        alignable.length > 0
          ? asStr(alignable.map((one) => BENCHMARK_LABELS[one]).join(', '))
          : pairedRuns > 0
            ? { en: 'no two runs share a record', zh: '任意两次运行都没有共同记录' }
            : { en: 'needs two runs of one benchmark', zh: '需要同一基准的两次运行' },
    },
  ]

  // A link that names a record is a link to a judgement, so it decides the tab.
  // Judgements otherwise, except when there are none to browse.
  const initial: TabId = hasRecord(recordId) || model.judgements.length > 0 ? 'judgements' : 'scores'
  const [tab, setTab] = useState<TabId>(initial)

  // The reader's tab choice survives everything except a new `?record=`, which
  // is somebody else's link arriving and has to be obeyed. Adjusting during
  // render rather than in an effect: an effect would paint the old tab first,
  // and that frame is the whole first impression of a mailed link.
  const [lastRecordId, setLastRecordId] = useState(recordId)
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId)
    if (hasRecord(recordId)) setTab('judgements')
  }

  return (
    <section className="rmr1">
      <div className="rmr1-tabs" role="tablist" aria-label={t({ en: 'RM-R1 views', zh: 'RM-R1 视图' })}>
        {tabs.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            id={`rmr1-tab-${one.id}`}
            aria-selected={tab === one.id}
            aria-controls={`rmr1-panel-${one.id}`}
            className={tab === one.id ? 'rmr1-tab is-active' : 'rmr1-tab'}
            onClick={() => setTab(one.id)}
          >
            <span>{t(one.label)}</span>
            <span className="rmr1-tab-hint">{t(one.hint)}</span>
          </button>
        ))}
      </div>

      <About model={model} openByDefault={tab === 'scores'} />

      <div
        className="rmr1-panel-area"
        role="tabpanel"
        id={`rmr1-panel-${tab}`}
        aria-labelledby={`rmr1-tab-${tab}`}
      >
        {tab === 'judgements' ? (
          <JudgmentBrowser model={model} recordId={recordId} />
        ) : tab === 'scores' ? (
          <ScoreDashboard model={model} />
        ) : (
          <RunCompare
            model={model}
            recordId={recordId}
            onOpenRecord={(id) => {
              // The same convention as clicking a row in the browser: the
              // selection goes into the URL, so Copy link copies the record the
              // hand-off opened.
              selectRecord(id)
              setTab('judgements')
            }}
          />
        )}
      </div>
    </section>
  )
}

function hasRecord(recordId: string | undefined): boolean {
  return recordId !== undefined && recordId !== ''
}

/** A string that is the data's own, in a place that wants a `Str`. */
function asStr(text: string): Str {
  return { en: text, zh: text }
}

/* --------------------------------------------------------- comparable runs */

/**
 * Benchmarks with two runs that actually share a record.
 *
 * Counting runs is what the picker needs and is not enough for a tab hint: two
 * runs of RM-Bench that packed different style files hold disjoint sets of
 * pairings, so the hint would promise a comparison the data cannot make. The
 * alignment key is the same one the compare view aligns on, so what is named
 * here is what opens.
 */
function alignableBenchmarks(runs: readonly Run[]): Benchmark[] {
  const found: Benchmark[] = []
  for (const [benchmark, group] of byBenchmark(runs)) {
    if (group.length < 2) continue
    const owner = new Map<string, string>()
    let shared = false
    for (const run of group) {
      for (const judgement of run.judgements) {
        const key = alignKey(judgement)
        const seen = owner.get(key)
        if (seen === undefined) owner.set(key, run.key)
        else if (seen !== run.key) {
          shared = true
          break
        }
      }
      if (shared) break
    }
    if (shared) found.push(benchmark)
  }
  return found
}

/** How many runs belong to a benchmark that has more than one. */
function countPairedRuns(runs: readonly Run[]): number {
  let total = 0
  for (const [, group] of byBenchmark(runs)) if (group.length > 1) total += group.length
  return total
}

function byBenchmark(runs: readonly Run[]): Map<Benchmark, Run[]> {
  const grouped = new Map<Benchmark, Run[]>()
  for (const run of runs) {
    const list = grouped.get(run.benchmark)
    if (list) list.push(run)
    else grouped.set(run.benchmark, [run])
  }
  return grouped
}

/* ---------------------------------------------------------------- about box */

/** How many notes are shown before the reader asks for the rest. */
const NOTES_SHOWN_COLLAPSED = 5

/**
 * What the model knows that the numbers do not say, how the package was
 * sampled, and what each figure on screen is over.
 *
 * Not a disclosure triangle and not a 98px scroller: both mean most readers
 * never meet the caveat that decides how the next number down should be read.
 * Every note is rendered whole — a sentence is never cut mid-way.
 *
 * What is on screen before anyone clicks anything, on every tab: how many notes
 * there are, the shape of the sampling disclosure counted out (rules, hand-picked,
 * withheld, excluded, truncated), that every figure has a stated denominator, and
 * the sampling method in the packer's own words — the sentence that answers "is
 * this cherry-picked" is `method`, and it says no RNG and no seed. The rest opens
 * on the Scores tab, where the numbers it qualifies are.
 *
 * The box cannot grow past its cap. Below it is a virtual list whose rows have to
 * have somewhere to be; a disclosure that leaves no room for the thing it
 * qualifies has stopped qualifying anything.
 */
const About: FC<{ model: RmR1Model; openByDefault: boolean }> = ({ model, openByDefault }) => {
  const t = useT()
  const notes = model.notes
  const sampling = model.sampling
  const coverage = model.coverage
  const [asked, setAsked] = useState<boolean | null>(null)
  const disclosed = sampling !== undefined || coverage.length > 0
  const open = asked ?? openByDefault

  if (notes.length === 0 && !disclosed) return null

  const expandable = notes.length > NOTES_SHOWN_COLLAPSED || disclosed
  const shown = open ? notes : notes.slice(0, NOTES_SHOWN_COLLAPSED)
  const count = notes.length.toLocaleString()

  return (
    <section className="rmr1-about" aria-label={t({ en: 'About this data', zh: '关于这批数据' })}>
      <div className="rmr1-about-head">
        <span className="rmr1-about-title">
          {t({
            en: `About this data · ${count} note${notes.length === 1 ? '' : 's'}`,
            zh: `关于这批数据 · ${count} 条说明`,
          })}
        </span>
        {sampling && <span className="rmr1-about-chip">{t(samplingSummary(sampling))}</span>}
        {coverage.length > 0 && (
          <span className="rmr1-about-chip">
            {t({
              en:
                coverage.length === 1
                  ? '1 figure with its denominator'
                  : `${coverage.length} figures with their denominators`,
              zh: `${coverage.length} 组数字标明了分母`,
            })}
          </span>
        )}
        <span className="spacer" />
        {expandable && (
          <button
            type="button"
            className="btn ghost rmr1-about-toggle"
            aria-expanded={open}
            onClick={() => setAsked(!open)}
          >
            {open
              ? t({ en: 'Show fewer', zh: '收起' })
              : t({
                  en: `Show all ${count} note${notes.length === 1 ? '' : 's'}${disclosed ? ', the sampling rule and the denominators' : ''}`,
                  zh: `展开全部 ${count} 条说明${disclosed ? '、抽样规则与各自的分母' : ''}`,
                })}
          </button>
        )}
      </div>

      {/* The packer's own sentence, above the fold in both states. Everything
          else about the sample is a count or a list; this is the claim. */}
      {sampling?.method !== undefined && (
        <p className="rmr1-about-method">
          <span className="faint">{t({ en: 'sampled by', zh: '抽样方式' })}</span> {t(sampling.method)}
        </p>
      )}

      <div className={open ? 'rmr1-about-body is-open' : 'rmr1-about-body'}>
        <ul className="rmr1-note-list">
          {shown.map((note, index) => (
            <li key={index}>{t(note)}</li>
          ))}
        </ul>
        {open && sampling && <SamplingBlock sampling={sampling} />}
        {open && coverage.length > 0 && <CoverageBlock entries={coverage} />}
      </div>
    </section>
  )
}

/**
 * The package's own account of how it was drawn.
 *
 * Every string inside `sampling` was written into the package by the builder and
 * is shown exactly as it arrived; only the labels around it are AgentLens's own
 * words. File paths, subset names and run ids are the data's and are never
 * translated.
 */
const SamplingBlock: FC<{ sampling: Sampling }> = ({ sampling }) => {
  const t = useT()
  return (
    <section className="rmr1-sampling">
      {/* `method` is not repeated here: it is already above the fold, in both
          the open and the collapsed state. */}
      <h4 className="rmr1-sampling-title">
        {t({ en: 'How this sample was drawn', zh: '这份样本是怎么抽的' })}
      </h4>

      {sampling.rules.length > 0 && (
        <ol className="rmr1-sampling-rules">
          {/* Keyed off the English side, as everywhere else a `Str` needs a key:
              the identity of a rule must not change when the reader switches
              language. */}
          {sampling.rules.map((rule) => (
            <li key={rule.en}>{t(rule)}</li>
          ))}
        </ol>
      )}

      {sampling.handPicked.length > 0 && (
        <div className="rmr1-sampling-part">
          <h5>
            {t({
              en: `Hand-picked on top of the quota · ${sampling.handPicked.length}`,
              zh: `配额之外另行手选 · ${sampling.handPicked.length}`,
            })}
          </h5>
          <ul>
            {sampling.handPicked.map((one, index) => (
              <li key={index}>
                <span className="mono">{recordLabel(one)}</span>
                {one.why !== undefined && <> — {t(one.why)}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sampling.withheld.length > 0 && (
        <div className="rmr1-sampling-part">
          <h5>
            {t({
              en: `Withheld from the package · ${sampling.withheld.length}`,
              zh: `未收入本包 · ${sampling.withheld.length}`,
            })}
          </h5>
          <ul>
            {sampling.withheld.map((one, index) => (
              <li key={index}>
                <span className="mono">{one.sourcePath ?? '—'}</span>
                {one.records !== undefined && (
                  <>
                    {' '}
                    {t({
                      en: `(${one.records.toLocaleString()} record${one.records === 1 ? '' : 's'})`,
                      zh: `（${one.records.toLocaleString()} 条记录）`,
                    })}
                  </>
                )}
                {one.reason !== undefined && <> — {t(one.reason)}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The files that are neither sampled nor withheld. Without this list the
          two lists above are a selection with no stated complement, which is
          precisely the shape a cherry-picking charge takes. */}
      {sampling.excluded.length > 0 && (
        <div className="rmr1-sampling-part">
          <h5>
            {t({
              en: `In the run's directory and not in this package · ${sampling.excluded.length}`,
              zh: `在该运行的目录里但未收入本包 · ${sampling.excluded.length}`,
            })}
          </h5>
          <ul>
            {sampling.excluded.map((one, index) => (
              <li key={index}>
                <span className="mono">{one.sourcePath ?? '—'}</span>
                {one.reason !== undefined && <> — {t(one.reason)}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sampling.truncated.length > 0 && (
        <div className="rmr1-sampling-part">
          <h5>
            {t({
              en: `Truncated, and marked in the record · ${sampling.truncated.length}`,
              zh: `已截断，并在记录里标出 · ${sampling.truncated.length}`,
            })}
          </h5>
          <ul>
            {sampling.truncated.map((one, index) => (
              <li key={index}>
                <span className="mono">
                  {one.sourcePath ?? '—'}
                  {one.sourceIndex === undefined ? '' : `:${one.sourceIndex}`}
                  {one.field === undefined ? '' : ` · ${one.field}`}
                </span>
                {one.originalBytes !== undefined && one.keptBytes !== undefined && (
                  <>
                    {' '}
                    {t({
                      en: `${one.originalBytes.toLocaleString()} → ${one.keptBytes.toLocaleString()} bytes`,
                      zh: `${one.originalBytes.toLocaleString()} → ${one.keptBytes.toLocaleString()} 字节`,
                    })}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/**
 * The package's figure-by-figure ledger: for every number the demo puts on
 * screen, what it is over and where in the file it came from.
 *
 * This is the second half of the same disclosure. `sampling` says how the
 * records were chosen; this says which numbers that choice touches and which it
 * does not — the distinction between a figure over 2,985 records and one over
 * 232 is the whole difference between a benchmark score and a sample's. A note
 * elsewhere in the model points the reader at this listing by name, so leaving
 * it in the file made that note a dead reference.
 *
 * Every string is the package's own and is shown verbatim; only the labels
 * around them are AgentLens's.
 */
const CoverageBlock: FC<{ entries: readonly CoverageEntry[] }> = ({ entries }) => {
  const t = useT()
  return (
    <section className="rmr1-coverage">
      <h4 className="rmr1-sampling-title">
        {t({ en: 'What each figure is over', zh: '每组数字各自的分母' })}
      </h4>
      <ul className="rmr1-coverage-list">
        {entries.map((one, index) => (
          <li key={index}>
            <p className="rmr1-cov-figure">{t(one.figure)}</p>
            <p className="rmr1-cov-basis">
              {/* No `mono` on the basis: it is a sentence the package wrote on
                  both sides, not a token quoted back, and setting a phrase the
                  reader is reading in their own language in a code face says it
                  is the file's literal text. `n = …` is the datum here. */}
              {one.basis !== undefined && <span>{t(one.basis)}</span>}
              {one.denominator !== undefined && (
                <>
                  {one.basis !== undefined && ' · '}
                  <span className="mono">n = {one.denominator.toLocaleString()}</span>
                </>
              )}
            </p>
            {one.from !== undefined && (
              <p className="rmr1-cov-from">
                <span className="faint">{t({ en: 'from', zh: '取自' })}</span>{' '}
                <span className="mono">{t(one.from)}</span>
              </p>
            )}
            {one.note !== undefined && <p>{t(one.note)}</p>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function recordLabel(one: HandPicked): string {
  const path = one.sourcePath ?? one.runId ?? ''
  const at = one.sourceIndex === undefined ? '' : `:${one.sourceIndex}`
  const subset = one.subset === undefined ? '' : ` · ${one.subset}`
  return `${path}${at}${subset}` || '—'
}

function samplingSummary(sampling: Sampling): Str {
  const parts: Str[] = []
  if (sampling.rules.length > 0) {
    parts.push({
      en: `${sampling.rules.length} sampling rule${sampling.rules.length === 1 ? '' : 's'}`,
      // The chip already says 抽样; repeating it in every part is the padding
      // that makes translated UI read as translated.
      zh: `${sampling.rules.length} 条规则`,
    })
  }
  if (sampling.handPicked.length > 0) {
    parts.push({
      en: `${sampling.handPicked.length} hand-picked`,
      zh: `${sampling.handPicked.length} 条手选`,
    })
  }
  if (sampling.withheld.length > 0) {
    parts.push({ en: `${sampling.withheld.length} withheld`, zh: `${sampling.withheld.length} 条未收录` })
  }
  if (sampling.excluded.length > 0) {
    parts.push({
      en: `${sampling.excluded.length} file${sampling.excluded.length === 1 ? '' : 's'} left out`,
      zh: `${sampling.excluded.length} 个文件未收入`,
    })
  }
  if (sampling.truncated.length > 0) {
    parts.push({ en: `${sampling.truncated.length} truncated`, zh: `${sampling.truncated.length} 条截断` })
  }
  if (parts.length === 0) return { en: 'sampling disclosed', zh: '已披露抽样方式' }
  return {
    en: `sampled · ${parts.map((one) => one.en).join(' · ')}`,
    zh: `抽样样本 · ${parts.map((one) => one.zh).join(' · ')}`,
  }
}

/* ------------------------------------------------------- sampling disclosure */

/**
 * `sampling` and `coverage` are the package's own disclosure. `parse()` reads
 * them off the dropped file, validates every field and carries them onto the
 * model, so this file renders what is there and claims nothing about what is
 * not: a package with no disclosure shows no block rather than an empty one.
 */
