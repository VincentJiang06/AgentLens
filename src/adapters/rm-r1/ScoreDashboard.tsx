/**
 * V2 — the numbers view.
 *
 * Three panels: RewardBench accuracy by subset, the RM-Bench 3x3 style matrix,
 * and the per-domain hard/normal/easy breakdown.
 *
 * Two rules run through all of it. A number computed over a *sample* never
 * wears the benchmark's name — it is labelled as the sample's, gets no section
 * roll-up, and is never differenced against a published figure. And every
 * number and every difference names the run it belongs to; where a figure
 * cannot be attributed to one run, the panel shows nothing and says why.
 *
 * A shipped score file is only ever shown *beside* a computed number, never in
 * place of one, and the difference is displayed rather than resolved.
 *
 * No charting library. Bars are two divs and the matrix is a CSS grid — at
 * these shapes a library would only add a dependency and a canvas that cannot
 * be read by a screen reader.
 */

import { Fragment, useMemo } from 'react'
import type { CSSProperties, FC, ReactNode } from 'react'
import type {
  Judgement,
  OfficialScores,
  OutcomeSet,
  RmBenchSummary,
  RmR1Model,
  RunOfficialScores,
  StyleMatrix,
} from './contract'
import { foldDomain, metricRows } from './metrics'
import type { MetricRow } from './metrics'
import { RM_BENCH_STYLES, officialScoresFor, outcomesOfFile, runIdOf } from './model'
import { useLang } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import './dashboard.css'

/* ------------------------------------------------------------------ wording */

/**
 * `t` for a plain phrase, `pick` for one that carries markup. Data — subset
 * names, file names, run ids, metric keys, anything a log wrote — is never
 * passed through either.
 */
function useSay(): { t: (str: Str) => string; pick: (en: ReactNode, zh: ReactNode) => ReactNode } {
  const { lang, t } = useLang()
  return { t, pick: (en, zh) => (lang === 'zh' ? zh : en) }
}

/**
 * A figure wider than the panel it sits in.
 *
 * `.panel` is `overflow: hidden` and a table's head cells do not wrap, so
 * without this the right-hand columns are not narrow — they are gone, with no
 * scrollbar and no way back to them. The Δ column is always the last one, which
 * makes it the first thing lost, and it is the column every one of these figures
 * is about. Scrolling the figure rather than the page is what keeps the document
 * itself from scrolling sideways under the top bar.
 *
 * `tabIndex` is what makes the scroll container reachable without a pointer.
 */
const Wide: FC<{ label: Str; children: ReactNode }> = ({ label, children }) => {
  const { t } = useSay()
  return (
    <div className="rmr1-wide" role="group" tabIndex={0} aria-label={t(label)}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------- RewardBench weights */

/**
 * Copied verbatim from `rewardbench/constants.py`. The section score is a
 * weighted mean of the subset accuracies using these counts, NOT the record
 * counts in the log — `math-prm` is weighted 984 against the 447 rows it
 * actually has, deliberately, so Reasoning is not swamped by code. Reproducing
 * the shipped `main_score.json` requires the benchmark's own weights, and it is
 * only ever applied to a complete set of outcomes: these weights on a sample
 * produce a quantity with no denominator.
 */
const EXAMPLE_COUNTS: Record<string, number> = {
  'alpacaeval-easy': 100,
  'alpacaeval-length': 95,
  'alpacaeval-hard': 95,
  'mt-bench-easy': 28,
  'mt-bench-med': 40,
  'mt-bench-hard': 37,
  'math-prm': 984,
  'refusals-dangerous': 100,
  'refusals-offensive': 100,
  'llmbar-natural': 100,
  'llmbar-adver-neighbor': 134,
  'llmbar-adver-GPTInst': 92,
  'llmbar-adver-GPTOut': 47,
  'llmbar-adver-manual': 46,
  'xstest-should-refuse': 154,
  'xstest-should-respond': 250,
  donotanswer: 136,
  'hep-cpp': 164,
  'hep-go': 164,
  'hep-java': 164,
  'hep-js': 164,
  'hep-python': 164,
  'hep-rust': 164,
}

/** `SUBSET_MAPPING`, same file. The four headline sections, in leaderboard order. */
const SECTION_SUBSETS: [string, string[]][] = [
  ['Chat', ['alpacaeval-easy', 'alpacaeval-length', 'alpacaeval-hard', 'mt-bench-easy', 'mt-bench-med']],
  [
    'Chat Hard',
    [
      'mt-bench-hard',
      'llmbar-natural',
      'llmbar-adver-neighbor',
      'llmbar-adver-GPTInst',
      'llmbar-adver-GPTOut',
      'llmbar-adver-manual',
    ],
  ],
  [
    'Safety',
    ['refusals-dangerous', 'refusals-offensive', 'xstest-should-refuse', 'xstest-should-respond', 'donotanswer'],
  ],
  ['Reasoning', ['math-prm', 'hep-cpp', 'hep-go', 'hep-java', 'hep-js', 'hep-python', 'hep-rust']],
]

const SECTION_OF: Record<string, string> = {}
for (const [section, subsets] of SECTION_SUBSETS) {
  for (const subset of subsets) SECTION_OF[subset] = section
}

/** `main_score.json`'s plain accuracy over every record. Their spelling, read as it is written. */
const OVERALL_SCORE_KEY = 'absoluate_Result'

/* --------------------------------------------------------------- run identity */

/** `<file>:<index>` and `<file>:<index>:<style>` back to the file the records came from. */
function sourceLabelOf(judgement: Judgement): string {
  const parts = judgement.id.split(':')
  const trailing = judgement.styleIndex === undefined ? 1 : 2
  return parts.length > trailing ? parts.slice(0, parts.length - trailing).join(':') : judgement.id
}

const RM_BENCH_STYLE_FILE = /(dataset[_-]?)([123])(?![0-9])/i

/** The three `total_dataset_N` files of one run share this key. */
function rmBenchRunKey(label: string): string {
  return label.replace(RM_BENCH_STYLE_FILE, '$1{1,2,3}')
}

/* ------------------------------------------------- what this panel reads */

interface Tally {
  subset: string
  /** Records with a recorded outcome. The denominator of the accuracy, and nothing else. */
  n: number
  hit: number
}

/**
 * One run's numbers.
 *
 * `outcomes` is the complete outcome table — every record's id, group and
 * outcome, with none of its text — that a demo package ships beside its sample
 * of full traces. When it is present, per-subset accuracy and the four section
 * scores are the benchmark's own numbers for this run and may carry its names.
 * When it is absent, everything shown is the loaded records' and is labelled
 * that way.
 */
interface RunView {
  runId: string
  outcomes: OutcomeSet | null
  official?: OfficialScores
  sample: Tally[]
  sampleScored: number
  sampleUnscored: number
}

interface RewardBench {
  views: RunView[]
  /**
   * A RewardBench score file is loaded that no run could be given. Which run
   * wrote it is not this panel's to guess, and its absence is worth a sentence:
   * a reader who can see the file in the drop should not have to wonder where
   * its numbers went.
   */
  unattributed: boolean
}

/** Whether a score file says anything this panel would show. */
function speaksOfRewardBench(scores: OfficialScores): boolean {
  return scores.sections !== undefined || scores.perSubset !== undefined
}

function tallies(set: OutcomeSet): Tally[] {
  return set.groups
    .filter((group) => group.total > group.unrecorded)
    .map((group) => ({ subset: group.group, n: group.total - group.unrecorded, hit: group.correct }))
}

function rewardBenchViews(model: RmR1Model): RewardBench | null {
  const order: string[] = []
  const runs = new Map<
    string,
    { outcomes: OutcomeSet | null; tally: Map<string, Tally>; scored: number; unscored: number }
  >()

  for (const judgement of model.judgements) {
    if (judgement.benchmark !== 'rewardbench') continue
    const label = sourceLabelOf(judgement)
    const set = outcomesOfFile(model, label)
    const runId = set !== undefined && set.run !== '' ? set.run : runIdOf(label)
    let run = runs.get(runId)
    if (!run) {
      run = {
        outcomes: set !== undefined && set.complete ? set : null,
        tally: new Map(),
        scored: 0,
        unscored: 0,
      }
      runs.set(runId, run)
      order.push(runId)
    }
    if (judgement.correct === null) {
      run.unscored += 1
      continue
    }
    run.scored += 1
    const one = run.tally.get(judgement.group) ?? { subset: judgement.group, n: 0, hit: 0 }
    one.n += 1
    if (judgement.correct) one.hit += 1
    run.tally.set(judgement.group, one)
  }
  if (order.length === 0) return null

  // Which published file a run may be shown beside is the model's ruling, not
  // this panel's: it is the same question the compare view and the RM-Bench
  // panels ask, and two answers to it would eventually disagree.
  const taken = new Set<RunOfficialScores>()
  const views = order.map((runId) => {
    const run = runs.get(runId) as {
      outcomes: OutcomeSet | null
      tally: Map<string, Tally>
      scored: number
      unscored: number
    }
    const official = officialScoresFor(model, runId)
    if (official) taken.add(official)
    return {
      runId,
      outcomes: run.outcomes,
      official: official?.scores,
      sample: [...run.tally.values()],
      sampleScored: run.scored,
      sampleUnscored: run.unscored,
    }
  })

  const unattributed = model.officialScores.some(
    (one) => one.run === '' && speaksOfRewardBench(one.scores) && !taken.has(one),
  )
  return { views, unattributed }
}

interface SubsetRow extends Tally {
  section?: string
  acc: number
  official?: number
}

function subsetRows(tallies: Tally[], official?: Record<string, number>): SubsetRow[] {
  return tallies
    .map((one) => ({
      ...one,
      section: SECTION_OF[one.subset],
      acc: one.hit / one.n,
      official: official?.[one.subset],
    }))
    .sort((a, b) => b.acc - a.acc || a.subset.localeCompare(b.subset))
}

interface SectionRow {
  name: string
  /** null when none of this section's subsets are in the table. */
  value: number | null
  subsetsCounted: number
  subsetsTotal: number
  /**
   * The denominator this number is actually over. A section score is a weighted
   * mean, so it is the sum of the benchmark's own `EXAMPLE_COUNTS` and not the
   * row count — `math-prm` puts 984 into Reasoning against the 447 rows it has,
   * and a tile that showed 447 would be naming a denominator it does not use.
   */
  weight: number
  official?: number
}

function sectionRows(rows: SubsetRow[], official?: Record<string, number>): SectionRow[] {
  const accOf = new Map(rows.map((row) => [row.subset, row.acc]))
  return SECTION_SUBSETS.map(([name, subsets]) => {
    let weighted = 0
    let weight = 0
    let counted = 0
    for (const subset of subsets) {
      const acc = accOf.get(subset)
      if (acc === undefined) continue
      weighted += acc * EXAMPLE_COUNTS[subset]
      weight += EXAMPLE_COUNTS[subset]
      counted += 1
    }
    return {
      name,
      value: weight > 0 ? weighted / weight : null,
      subsetsCounted: counted,
      subsetsTotal: subsets.length,
      weight,
      official: official?.[name],
    }
  })
}

function totals(tallies: Tally[]): { n: number; hit: number; acc: number } {
  let n = 0
  let hit = 0
  for (const one of tallies) {
    n += one.n
    hit += one.hit
  }
  return { n, hit, acc: n > 0 ? hit / n : Number.NaN }
}

/* ------------------------------------------------------------------ formatting */

function pct(value: number, digits = 2): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—'
}

/** Differences between two accuracies are quoted in points, never as a percentage of a percentage. */
function points(delta: number): string {
  if (!Number.isFinite(delta)) return '—'
  const shown = (delta * 100).toFixed(2)
  return `${delta > 0 ? '+' : ''}${shown} pt`
}

/** The size of a difference, where the direction is not the point and a sign would suggest one. */
function pointSpan(size: number): string {
  return Number.isFinite(size) ? `${(size * 100).toFixed(2)} pt` : '—'
}

function count(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * A counted noun in English, which inflects at n = 1. The Chinese half of each
 * sentence is written out separately rather than derived from this: 条 and 个 are
 * measure words and take the same form whatever the numeral is.
 */
interface Countable {
  one: string
  many: string
}

const RECORD: Countable = { one: 'record', many: 'records' }
const JUDGEMENT: Countable = { one: 'judgement', many: 'judgements' }
const METRIC: Countable = { one: 'metric', many: 'metrics' }
const ID: Countable = { one: 'id', many: 'ids' }
const RUN: Countable = { one: 'run', many: 'runs' }

function counted(n: number, noun: Countable): string {
  return `${count(n)} ${n === 1 ? noun.one : noun.many}`
}

/* --------------------------------------------------------- panel 1: RewardBench */

const RunBlock: FC<{ view: RunView }> = ({ view }) => {
  const { t, pick } = useSay()
  const full = view.outcomes === null ? null : tallies(view.outcomes)
  const rows = subsetRows(full ?? view.sample, full ? view.official?.perSubset : undefined)
  const sections = full ? sectionRows(rows, view.official?.sections) : null
  const whole = totals(full ?? view.sample)
  const hasDelta = rows.some((row) => row.official !== undefined)
  const sampled = view.sampleScored + view.sampleUnscored
  const unrecorded = view.outcomes?.unrecorded ?? 0
  const publishedOverall = full ? view.official?.sections?.[OVERALL_SCORE_KEY] : undefined

  return (
    <div className="rb-run">
      <p className="rb-run-head">
        <span className="faint">{t({ en: 'run', zh: '运行' })}</span> <span className="mono">{view.runId}</span>
      </p>

      <p className="rmr1-lede">
        {full
          ? pick(
              <>
                Computed from the complete outcome table this package carries for this run — every one of its{' '}
                {counted(whole.n, RECORD)}, {count(whole.hit)} correct, {pct(whole.acc)}.
                {unrecorded > 0 && (
                  <>
                    {' '}
                    {count(unrecorded)} more {unrecorded === 1 ? 'carries' : 'carry'} no recorded outcome and{' '}
                    {unrecorded === 1 ? 'is' : 'are'} excluded.
                  </>
                )}
                {sampled > 0 && (
                  <> The judgement browser lists {count(sampled)} of them in full; no number here is that sample's.</>
                )}
                {publishedOverall !== undefined && (
                  <>
                    {' '}
                    This run's score file puts <code>{OVERALL_SCORE_KEY}</code> at {pct(publishedOverall)} ·{' '}
                    {points(whole.acc - publishedOverall)}.
                  </>
                )}
              </>,
              <>
                取自数据包里这个运行的完整结果表 —— 全量 {count(whole.n)} 条记录，{count(whole.hit)} 条判对，
                {pct(whole.acc)}。
                {unrecorded > 0 && <>另有 {count(unrecorded)} 条没有记录结果，已排除。</>}
                {sampled > 0 && <>判例浏览器里列出了其中 {count(sampled)} 条的完整文本；这里没有一个数字来自那份抽样样本。</>}
                {publishedOverall !== undefined && (
                  <>
                    该运行的官方分数文件里 <code>{OVERALL_SCORE_KEY}</code> 为 {pct(publishedOverall)} ·{' '}
                    {points(whole.acc - publishedOverall)}。
                  </>
                )}
              </>,
            )
          : pick(
              <>
                Computed from the {count(view.sampleScored)} scored RewardBench{' '}
                {view.sampleScored === 1 ? JUDGEMENT.one : JUDGEMENT.many} loaded for this run —{' '}
                {count(whole.hit)} correct, {pct(whole.acc)} over those {count(whole.n)}.
                {view.sampleUnscored > 0 && (
                  <>
                    {' '}
                    {count(view.sampleUnscored)} carried no recorded outcome and{' '}
                    {view.sampleUnscored === 1 ? 'is' : 'are'} excluded.
                  </>
                )}{' '}
                That is the accuracy of the records loaded here, not RewardBench's.
                {view.official !== undefined && (
                  <>
                    {' '}
                    A score file for this run is loaded. It covers the whole run, and nothing here says how much of
                    that run these records are, so it is not placed beside them.
                  </>
                )}
              </>,
              <>
                取自这个运行已载入的 {count(view.sampleScored)} 条有判定结果的 RewardBench 判例 —— {count(whole.hit)}{' '}
                条判对，在这 {count(whole.n)} 条上是 {pct(whole.acc)}。
                {view.sampleUnscored > 0 && <>另有 {count(view.sampleUnscored)} 条没有记录结果，已排除。</>}
                这是已载入这批记录的准确率，不是 RewardBench 的准确率。
                {view.official !== undefined && (
                  <>这个运行的官方分数文件也已载入。它对应的是整个运行，而已载入的内容里没有任何信息说明这批记录占整个运行的多少，所以不把它摆在这些数字旁边。</>
                )}
              </>,
            )}
      </p>

      {sections && (
        <div className="rb-sections">
          {sections.map((section) => (
            <div className="rb-section" key={section.name}>
              <span className="rb-section-name">{section.name}</span>
              <span className="rb-section-value">{section.value === null ? '—' : pct(section.value)}</span>
              <span className="rb-section-meta faint">
                {section.value === null
                  ? t({ en: 'none of its subsets are in the table', zh: '结果表中没有它的任何子集' })
                  : t({
                      en: `${section.subsetsCounted}/${section.subsetsTotal} subsets · weighted by ${count(section.weight)}`,
                      zh: `${section.subsetsCounted}/${section.subsetsTotal} 个子集 · 加权分母 ${count(section.weight)}`,
                    })}
              </span>
              {section.official !== undefined && section.value !== null && (
                <span className="rb-section-meta faint">
                  {t({ en: 'score file', zh: '官方分数' })} {pct(section.official)} ·{' '}
                  {points(section.value - section.official)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <Wide
        label={{
          en: `RewardBench subsets for ${view.runId}, scrollable`,
          zh: `${view.runId} 的 RewardBench 子集，可横向滚动`,
        }}
      >
      <div className={`rb-bars${hasDelta ? ' has-official' : ''}`}>
        <div className="rb-bar-row rb-bar-head">
          <span>{t({ en: 'subset', zh: '子集' })}</span>
          <span>{t({ en: 'section', zh: '分区' })}</span>
          <span />
          <span className="rb-num">{t({ en: 'accuracy', zh: '准确率' })}</span>
          <span className="rb-num">n</span>
          <span className="rb-num">Δ {t({ en: 'score file', zh: '官方分数' })}</span>
        </div>
        {rows.map((row) => (
          <div className="rb-bar-row" key={row.subset}>
            <span className="mono truncate">{row.subset}</span>
            <span className="faint truncate">{row.section ?? t({ en: 'unmapped', zh: '未归入分区' })}</span>
            <span className="rb-track" aria-hidden="true">
              <span className="rb-fill" style={{ width: `${row.acc * 100}%` }} />
            </span>
            <span className="rb-num">{pct(row.acc, 1)}</span>
            <span className="rb-num faint">{count(row.n)}</span>
            <span className="rb-num faint">{row.official === undefined ? '' : points(row.acc - row.official)}</span>
          </div>
        ))}
      </div>
      </Wide>
    </div>
  )
}

const RewardBenchPanel: FC<{ rollup: RewardBench | null }> = ({ rollup }) => {
  const { t, pick } = useSay()
  const views = rollup?.views ?? []
  const anyFull = views.some((view) => view.outcomes !== null)
  const anySample = views.some((view) => view.outcomes === null)
  const anyDelta = views.some((view) => view.outcomes !== null && view.official?.perSubset !== undefined)
  const unmapped = [
    ...new Set(
      views
        .flatMap((view) => (view.outcomes ? tallies(view.outcomes) : view.sample).map((one) => one.subset))
        .filter((subset) => SECTION_OF[subset] === undefined),
    ),
  ]

  return (
    <section className="panel rmr1-panel">
      <header className="panel-header">
        RewardBench · {t({ en: 'accuracy by subset', zh: '按子集的准确率' })}
      </header>
      <div className="panel-body rmr1-body">
        {rollup === null ? (
          <p className="notice">
            {t({
              en: 'No RewardBench judgements were loaded, so there is nothing to score here.',
              zh: '没有载入 RewardBench 判例，这里没有可计算的分数。',
            })}
          </p>
        ) : (
          <>
            {rollup.unattributed && (
              <p className="notice">
                {pick(
                  <>
                    A RewardBench score file is loaded that names no run. A published score belongs to one checkpoint,
                    and nothing loaded says which of the {counted(views.length, RUN)} below wrote this one, so it is
                    placed beside none of them.
                  </>,
                  <>
                    载入了一份没有标明所属运行的 RewardBench 官方分数文件。一份已发布的分数属于某一个检查点，而已载入的内容里没有说明这一份出自下面 {views.length} 个运行中的哪一个，所以不把它摆在其中任何一个旁边。
                  </>,
                )}
              </p>
            )}

            {views.map((view) => (
              <RunBlock key={view.runId} view={view} />
            ))}

            <ul className="rmr1-notes">
              {anyFull && (
                <li>
                  {pick(
                    <>
                      Section scores weight each subset by the benchmark's own <code>EXAMPLE_COUNTS</code>, not by the{' '}
                      <span className="nowrap">n</span> above — <code>math-prm</code> counts 984 against the rows it
                      has. That is what the shipped summariser does, so it is what is done here.
                    </>,
                    <>
                      分区分数按基准自带的 <code>EXAMPLE_COUNTS</code> 对每个子集加权，而不是按上面的{' '}
                      <span className="nowrap">n</span> —— <code>math-prm</code> 按 984 计，而不是它实际的行数。随附的汇总脚本就是这样做的，这里照做。
                    </>,
                  )}
                </li>
              )}
              {anySample && (
                <li>
                  {pick(
                    <>
                      A run whose outcomes are not carried in full gets its loaded records' own accuracy and stops
                      there: no section score, and no difference against a published figure. Weighting a sample by the
                      benchmark's counts produces a quantity with no denominator.
                    </>,
                    <>
                      如果一个运行的结果表没有被完整携带，这里只给出已载入记录自身的准确率，到此为止：不给分区分数，也不与已发布的数字作差。拿基准的计数去加权一份抽样样本，得到的是一个没有分母的量。
                    </>,
                  )}
                </li>
              )}
              {unmapped.length > 0 && (
                <li>
                  {pick(
                    <>
                      {unmapped.length} subset{unmapped.length === 1 ? '' : 's'} here{' '}
                      {unmapped.length === 1 ? 'is' : 'are'} not named by the benchmark's section map and{' '}
                      {unmapped.length === 1 ? 'contributes' : 'contribute'} to no section: {unmapped.join(', ')}.
                    </>,
                    <>
                      有 {unmapped.length} 个子集不在基准的分区映射中，不计入任何分区：{unmapped.join(', ')}。
                    </>,
                  )}
                </li>
              )}
              {anyDelta && (
                <li>
                  {pick(
                    <>
                      Δ compares each bar with the score file loaded alongside that run — for these demo packages, the
                      one shipped inside the package. Both cover the same records, so a difference here is a difference
                      in the numbers rather than in coverage.
                    </>,
                    <>
                      Δ 是每条柱与随这个运行一同载入的官方分数文件之差 —— 对这两个演示数据包来说，就是包里自带的那一份。两边算的是同一批记录，所以这里的差异是数字上的差异，不是覆盖范围的差异。
                    </>,
                  )}
                </li>
              )}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}

/* ------------------------------------------------- panel 2: the 3x3 style matrix */

/**
 * The style index is what the files carry; these words are our gloss on it, so
 * they are AgentLens's to translate. A style the model names but this map does
 * not renders exactly as the model names it, and the index leads either way.
 */
const STYLE_WORD: Record<string, Str> = {
  concise: { en: 'concise', zh: '简洁' },
  detailed: { en: 'detailed', zh: '详细' },
  'detailed + markdown': { en: 'detailed + markdown', zh: '详细 + markdown' },
}

function styleLabels(t: (str: Str) => string): string[] {
  return RM_BENCH_STYLES.map((name, index) => `${index} · ${t(STYLE_WORD[name] ?? { en: name, zh: name })}`)
}

/**
 * How the shipped assembly folds when `data2` and `data3` hold the same file:
 * each pair is [cell that repeats, the neighbour it takes its value from].
 * Whether it actually folded is checked against the numbers, not assumed.
 */
const COLLAPSE_PAIRS: [[number, number], [number, number]][] = [
  [
    [0, 1],
    [0, 2],
  ],
  [
    [1, 2],
    [1, 0],
  ],
  [
    [2, 0],
    [2, 1],
  ],
]

function regimeOf(chosen: number, rejected: number): 'hard' | 'normal' | 'easy' {
  if (chosen === rejected) return 'normal'
  return chosen < rejected ? 'hard' : 'easy'
}

/** A cell, named by the two style indices it pairs. */
function cellName(t: (str: Str) => string, chosen: number, rejected: number): string {
  return `${t({ en: 'chosen', zh: '优选' })} ${chosen} / ${t({ en: 'rejected', zh: '次选' })} ${rejected}`
}

const MatrixGrid: FC<{
  title: string
  note: string
  axis: { corner: string; described: string }
  matrix: StyleMatrix
  lo: number
  hi: number
  marked?: [number, number][]
}> = ({ title, note, axis, matrix, lo, hi, marked = [] }) => {
  const { t } = useSay()
  const labels = styleLabels(t)
  return (
  <figure className="rmb-figure">
    <figcaption className="rmb-caption">
      <strong>{title}</strong>
      <span className="faint">{note}</span>
    </figcaption>
    {/* Not a <table>: the row and column heads are read in order, and a grid of
        spans with table roles but no row structure is worse for AT than none. */}
    <div className="rmb-grid" aria-label={`${title}. ${axis.described}`}>
      <span className="rmb-corner faint">{axis.corner}</span>
      {labels.map((label) => (
        <span className="rmb-colhead" key={label}>
          {label}
        </span>
      ))}
      {matrix.cells.map((row, chosen) => (
        <Fragment key={chosen}>
          <span className="rmb-rowhead">{labels[chosen]}</span>
          {row.map((value, rejected) => {
            const isMarked = marked.some(([r, c]) => r === chosen && c === rejected)
            return (
              <span
                key={rejected}
                className={`rmb-cell ${regimeOf(chosen, rejected)}${isMarked ? ' marked' : ''}`}
                style={{ '--fill': shade(value, lo, hi) } as CSSProperties}
              >
                <span className="rmb-value">{pct(value)}</span>
                <span className="rmb-regime">{regimeOf(chosen, rejected)}</span>
              </span>
            )
          })}
        </Fragment>
      ))}
    </div>
  </figure>
  )
}

/** Percentage of --accent mixed into the cell. Kept shallow so the label keeps its contrast. */
function shade(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 20
  return Math.round(6 + ((value - lo) / (hi - lo)) * 34)
}

/** The four whole-benchmark metrics; the other four rows are per-domain and belong to panel 3. */
const OVERALL_METRICS = ['hard_acc', 'normal_acc', 'easy_acc', 'total_avg_acc']

/**
 * Close enough to be called a reproduction: half of the last digit shown, so
 * "worst difference 0.00 pt" is a claim a reader checks against the figures on
 * screen rather than a word taken on trust.
 */
const REPRODUCED_WITHIN = 0.00005

interface ReproductionGap {
  /** Metrics compared in this panel, and in the per-domain panel below it. */
  here: number
  below: number
  worst: number
  /** The shipped file summarises these same records. */
  lands: boolean
}

/**
 * How closely repeating the shipped assembly lands on the shipped file. This is
 * the one thing that licenses comparing the two matrices at all, so it is
 * measured on screen rather than asserted — and counted where it is shown,
 * since four of the metrics are in this panel and four in the next.
 *
 * When it does not land, the records in hand are not the set the shipped file
 * summarises — a partial drop, or another checkpoint's file — and a difference
 * against it would be a difference of coverage wearing the assembly's name.
 */
function reproductionGap(rows: MetricRow[]): ReproductionGap | null {
  let here = 0
  let below = 0
  let worst = 0
  for (const row of rows) {
    if (row.reproduced === undefined || row.official === undefined) continue
    if (OVERALL_METRICS.includes(row.metric)) here += 1
    else below += 1
    worst = Math.max(worst, Math.abs(row.reproduced - row.official))
  }
  return here + below > 0 ? { here, below, worst, lands: worst < REPRODUCED_WITHIN } : null
}

/**
 * Whether a `final_result.json` may be put beside these numbers at all: it has
 * to belong to a run this panel can name, and it has to describe these very
 * records. Both RM-Bench panels ask this, and one answer keeps them agreeing.
 */
function publishedIsComparable(summary: RmBenchSummary, runs: string[]): boolean {
  if (runs.length !== 1) return false
  const gap = reproductionGap(metricRows(summary))
  return gap !== null && gap.lands
}

/**
 * Which RM-Bench runs these matrices could belong to, one entry per run.
 *
 * The judgements are asked first, and the packed outcome tables after them: a
 * matrix is assembled from whichever of the two the package carries, and a
 * package that ships the complete table without a sample of its traces has a run
 * to name even though no judgement points at it. Reading only the judgements
 * left this list empty there, and "0 RM-Bench runs are loaded — and these
 * matrices are one of them" names a run the data does not contain.
 */
function rmBenchRuns(model: RmR1Model): string[] {
  const runs = new Set<string>()
  for (const judgement of model.judgements) {
    if (judgement.benchmark !== 'rm-bench') continue
    const label = sourceLabelOf(judgement)
    const set = outcomesOfFile(model, label)
    runs.add(set !== undefined && set.run !== '' ? set.run : rmBenchRunKey(label))
  }
  for (const set of model.outcomes) {
    if (set.benchmark !== 'rm-bench' || !set.complete || set.run === '') continue
    runs.add(set.run)
  }
  return [...runs]
}

/** The RM-Bench files loaded, whether or not they add up to a matrix. */
function rmBenchFiles(model: RmR1Model): string[] {
  const files = new Set<string>()
  for (const judgement of model.judgements) {
    if (judgement.benchmark !== 'rm-bench') continue
    files.add(sourceLabelOf(judgement))
  }
  return [...files]
}

/**
 * How many records the RM-Bench figures are over.
 *
 * Every cell of the matrix is one comparison per dataset id, so the matrix has
 * two honest denominators — the ids, and the nine comparisons each id
 * contributes — and both are stated rather than one being passed off as the
 * other. The count comes from the complete outcome table the package carries for
 * this run, which is the same table the matrix is assembled from.
 *
 * `null` when there is no such table, or when it cannot be tied to the one run
 * the matrix belongs to. `RmBenchSummary` does not carry a record count of its
 * own, so a run whose matrix was recomputed from dropped style files has no
 * denominator this panel may state — and it says so instead of guessing one.
 */
interface RmBenchScale {
  ids: number
  comparisons: number
  /** Ids per folded domain, so each row of the per-domain table can name its own. */
  perDomain: Map<string, number>
}

function rmBenchScale(model: RmR1Model, runs: string[]): RmBenchScale | null {
  if (runs.length !== 1) return null
  const sets = model.outcomes.filter(
    (set) => set.benchmark === 'rm-bench' && set.complete && set.run === runs[0],
  )
  if (sets.length !== 1) return null
  const [set] = sets
  const ids = new Set<string>()
  const byDomain = new Map<string, Set<string>>()
  for (const record of set.records) {
    ids.add(record.id)
    const domain = foldDomain(record.group)
    if (domain === null) continue
    const bucket = byDomain.get(domain) ?? new Set<string>()
    bucket.add(record.id)
    byDomain.set(domain, bucket)
  }
  if (ids.size === 0) return null
  return {
    ids: ids.size,
    comparisons: set.total,
    perDomain: new Map([...byDomain].map(([domain, held]) => [domain, held.size])),
  }
}

const StyleMatrixPanel: FC<{ model: RmR1Model; runs: string[] }> = ({ model, runs }) => {
  const { t, pick } = useSay()
  const summary = model.rmBench
  const axis = {
    corner: t({ en: 'chosen ↓ / rejected →', zh: '优选回答 ↓ / 次选回答 →' }),
    described: t({
      en: 'Rows are the chosen style, columns the rejected style.',
      zh: '行是优选回答的风格，列是次选回答的风格。',
    }),
  }

  if (!summary) {
    // `model.runs` is not the question here: it is deliberately empty when one
    // run is loaded, and RM-Bench's three style files are one run.
    const loaded = rmBenchFiles(model)
    return (
      <section className="panel rmr1-panel">
        <header className="panel-header">RM-Bench · {t({ en: '3×3 style matrix', zh: '3×3 风格矩阵' })}</header>
        <div className="panel-body rmr1-body">
          <p className="notice warn">
            {pick(
              <>
                The matrix needs all three <code>total_dataset_{'{1,2,3}'}</code> files: each one pairs the chosen
                responses against the rejected ones at a different offset, so one file alone fills only the diagonal.
                {loaded.length === 0
                  ? ' None are loaded.'
                  : ` What is loaded: ${loaded.join(', ')}. Which pairings that leaves short is in the notes.`}
              </>,
              <>
                这个矩阵需要 <code>total_dataset_{'{1,2,3}'}</code> 三个文件齐全：每个文件都以不同的偏移把优选回答与次选回答配对，所以单个文件只能填满对角线。
                {loaded.length === 0
                  ? '目前一个都没有载入。'
                  : `已载入：${loaded.join('、')}。还差哪些配对写在下面的注记里。`}
              </>,
            )}
          </p>
        </div>
      </section>
    )
  }

  const reproduced = summary.reproducedOfficial
  const all = reproduced
    ? [...summary.overall.cells.flat(), ...reproduced.overall.cells.flat()]
    : summary.overall.cells.flat()
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const rows = metricRows(summary)
  // The matrix is one run's — `buildRmBench` scores a single candidate — and a
  // published summary belongs to one checkpoint. With one RM-Bench run loaded
  // the two can only be each other; with more, this panel is not told which run
  // the matrix is, so the published column goes and a sentence takes its place.
  const attributed = runs.length === 1
  const scale = rmBenchScale(model, runs)
  const gap = attributed ? reproductionGap(rows) : null
  const published = gap !== null && gap.lands
  const collapsed = reproduced
    ? COLLAPSE_PAIRS.filter(
        ([[ar, ac], [br, bc]]) =>
          Math.abs(reproduced.overall.cells[ar][ac] - reproduced.overall.cells[br][bc]) < 1e-9,
      )
    : []

  return (
    <section className="panel rmr1-panel">
      <header className="panel-header">RM-Bench · {t({ en: '3×3 style matrix', zh: '3×3 风格矩阵' })}</header>
      <div className="panel-body rmr1-body">
        <p className="rmr1-lede">
          {pick(
            <>
              Rows are the style of the response the dataset labels better, columns the style of the worse one. Above
              the diagonal the better answer is the plainer one — that is the <strong>hard</strong> regime, and the
              benchmark's whole point. On the diagonal both sides share a style (<strong>normal</strong>); below it the
              better answer is also the more decorated one (<strong>easy</strong>).
            </>,
            <>
              行是优选回答（数据集判为更好的那条）的风格，列是次选回答的风格。对角线之上，优选回答反而是更朴素的那条 ——
              这是 <strong>hard</strong> 区间，也是这个基准的全部要点。对角线上两边风格相同（<strong>normal</strong>
              ）；对角线之下，优选回答同时也是更花哨的那条（<strong>easy</strong>）。
            </>,
          )}
        </p>

        <div className="rmb-grids">
          <MatrixGrid
            title={t({ en: 'Recomputed here', zh: '在此重算' })}
            /* Not "from N files": the summary exists only when all three
               pairings are in hand, and where they came from — three dropped
               logs, or a package's complete outcome table — is a sentence the
               model states in `notes`, with the record count this panel does
               not carry. */
            note={t({
              en: 'all three total_dataset pairings, each file read once',
              zh: 'total_dataset 三组配对齐全，每个文件各读一次',
            })}
            axis={axis}
            matrix={summary.overall}
            lo={lo}
            hi={hi}
          />
          {reproduced && (
            <MatrixGrid
              title={t({ en: 'As the shipped summariser assembles it', zh: '按随附汇总脚本的组装方式' })}
              note={t({ en: "same records, the script's own pairing", zh: '同一批记录，脚本自己的配对方式' })}
              axis={axis}
              matrix={reproduced.overall}
              lo={lo}
              hi={hi}
              marked={collapsed.map(([cell]) => cell)}
            />
          )}
        </div>

        <p className="rmr1-lede">
          {pick(
            <>
              Shading spans the cells shown, {pct(lo)} to {pct(hi)}; the number in each cell is the accuracy, and the
              colour is only there to make the shape of the matrix visible across a room.
            </>,
            <>
              底色深浅对应 {pct(lo)} 到 {pct(hi)}，也就是所示各格的取值范围；每格里的数字才是准确率，颜色只是为了让矩阵的形状在几米外也看得出来。
            </>,
          )}
        </p>

        {reproduced ? (
          <>
            <p className="rmr1-lede">
              {attributed
                ? pick(
                    <>
                      Every figure in this panel is <span className="mono">{runs[0]}</span>'s
                      {scale ? (
                        <>
                          , over all {count(scale.ids)} of its RM-Bench {scale.ids === 1 ? ID.one : ID.many} — one
                          comparison per id in each of the nine cells, {count(scale.comparisons)} in all
                        </>
                      ) : (
                        <>
                          . Nothing loaded says how many records are behind each cell, so no denominator is claimed
                          for them; any that failed to align across the three style files are counted in the notes
                          above the tabs
                        </>
                      )}
                      {published && (
                        <>
                          , and the published column is the <code>final_result.json</code> loaded with it
                        </>
                      )}
                      .
                    </>,
                    <>
                      这个面板里的每个数字都属于 <span className="mono">{runs[0]}</span>
                      {scale ? (
                        <>
                          ，覆盖它全部 {count(scale.ids)} 个 RM-Bench 记录 —— 九个格子里每个格子对每条记录各比一次，共{' '}
                          {count(scale.comparisons)} 次
                        </>
                      ) : (
                        <>
                          。已载入的内容里没有说明每一格背后有多少条记录，因此这里不为它们标注分母；三个风格文件之间没有对齐的记录，数量写在标签页上方的注记里
                        </>
                      )}
                      {published && (
                        <>
                          ，已发布的一列取自与它一同载入的 <code>final_result.json</code>
                        </>
                      )}
                      。
                    </>,
                  )
                : pick(
                    <>
                      {runs.length} RM-Bench runs are loaded — {runs.join(', ')} — and these matrices are one of them.
                      This panel is not told which, so no <code>final_result.json</code> column is placed beside them;
                      the two columns below are that one run's records, assembled two ways.
                    </>,
                    <>
                      已载入 {runs.length} 个 RM-Bench 运行 —— {runs.join('、')} —— 而这两个矩阵只属于其中一个。这个面板无从得知是哪一个，因此不在旁边放{' '}
                      <code>final_result.json</code> 一列；下面两列是那一个运行的同一批记录，按两种方式组装。
                    </>,
                  )}
            </p>
            <Wide
              label={{
                en: 'RM-Bench headline metrics, scrollable',
                zh: 'RM-Bench 总体指标，可横向滚动',
              }}
            >
            <table className="rmb-metrics">
              <thead>
                <tr>
                  <th>{t({ en: 'metric', zh: '指标' })}</th>
                  <th className="rb-num">{t({ en: 'recomputed', zh: '在此重算' })}</th>
                  <th className="rb-num">{t({ en: "script's assembly", zh: '按脚本组装' })}</th>
                  {published && (
                    <th className="rb-num">
                      <span className="verbatim">final_result.json</span>
                    </th>
                  )}
                  {published && <th className="rb-num">Δ</th>}
                </tr>
              </thead>
              <tbody>
                {rows
                  .filter((row) => OVERALL_METRICS.includes(row.metric))
                  .map((row) => (
                    <tr key={row.metric}>
                      <td className="mono">{row.metric}</td>
                      <td className="rb-num">{pct(row.corrected)}</td>
                      <td className="rb-num faint">
                        {row.reproduced === undefined ? '—' : pct(row.reproduced)}
                      </td>
                      {published && (
                        <td className="rb-num">{row.official === undefined ? '—' : pct(row.official)}</td>
                      )}
                      {published && (
                        <td className="rb-num">
                          {row.official === undefined ? '—' : points(row.corrected - row.official)}
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
            </Wide>

            <ul className="rmr1-notes">
              <li>
                {pick(
                  <>
                    The two matrices differ because{' '}
                    <code>eval/RM-Bench/scripts/process_final_result.py</code> opens <code>total_dataset_3</code> into{' '}
                    <code>data2</code> as well as <code>data3</code>, so <code>total_dataset_2</code> is not read and{' '}
                    <code>total_dataset_3</code> is counted twice.
                  </>,
                  <>
                    两个矩阵之所以不同，是因为 <code>eval/RM-Bench/scripts/process_final_result.py</code> 把{' '}
                    <code>total_dataset_3</code> 同时读入 <code>data2</code> 和 <code>data3</code>，于是{' '}
                    <code>total_dataset_2</code> 没有被读取，<code>total_dataset_3</code> 被计入两次。
                  </>,
                )}
              </li>
              {collapsed.length > 0 && (
                <li>
                  {pick(
                    <>
                      Three cells therefore carry a neighbour's value, dashed in the second matrix:{' '}
                      {collapsed
                        .map(([[ar, ac], [br, bc]]) => `${cellName(t, ar, ac)} = ${cellName(t, br, bc)}`)
                        .join('; ')}
                      . Two of them sit above the diagonal and one below, which is why <code>hard_acc</code> and{' '}
                      <code>easy_acc</code> move. The diagonal comes from <code>total_dataset_1</code> alone, so{' '}
                      <code>normal_acc</code> cannot.
                    </>,
                    <>
                      因此有三格取了相邻格的值，在第二个矩阵里以虚线标出：
                      {collapsed
                        .map(([[ar, ac], [br, bc]]) => `${cellName(t, ar, ac)} = ${cellName(t, br, bc)}`)
                        .join('；')}
                      。其中两格在对角线之上、一格在其下，<code>hard_acc</code> 与 <code>easy_acc</code>{' '}
                      因此移动；对角线三格只来自 <code>total_dataset_1</code>，<code>normal_acc</code>{' '}
                      在算术上没有移动的余地。
                    </>,
                  )}
                </li>
              )}
              {gap && (
                <li>
                  {pick(
                    gap.lands ? (
                      <>
                        Assembling these same records the script's way lands on the shipped{' '}
                        <code>final_result.json</code> across {counted(gap.here + gap.below, METRIC)} — the{' '}
                        {gap.here} above and the {gap.below} per-domain below — worst difference{' '}
                        {pointSpan(gap.worst)}. That is what makes the Δ column above a difference of one line rather
                        than a difference of data.
                      </>
                    ) : (
                      <>
                        A <code>final_result.json</code> is loaded, and assembling these records the script's way does
                        not arrive at it: worst difference {pointSpan(gap.worst)} across{' '}
                        {counted(gap.here + gap.below, METRIC)}.
                        The records in hand are then not the set that file summarises, so it is not placed beside these
                        numbers — a difference against it would be a difference of coverage rather than of assembly.
                      </>
                    ),
                    gap.lands ? (
                      <>
                        把同一批记录按脚本的方式组装，结果与随附的 <code>final_result.json</code> 在{' '}
                        {gap.here + gap.below} 个指标上一致 —— 上表的 {gap.here} 个，加上下方按领域的 {gap.below} 个 ——
                        最大差异 {pointSpan(gap.worst)}。正因如此，上表 Δ 列反映的是那一行读法的差别，而不是两批数据的差别。
                      </>
                    ) : (
                      <>
                        已载入一份 <code>final_result.json</code>，但把手上这批记录按脚本的方式组装并不会得到它：在{' '}
                        {gap.here + gap.below} 个指标上最大差异 {pointSpan(gap.worst)}。那么手上的记录就不是那份文件所汇总的那一批，所以不把它摆在这些数字旁边 —— 与它作差，差出来的是覆盖范围，而不是组装方式。
                      </>
                    ),
                  )}
                </li>
              )}
              <li>
                {pick(
                  <>
                    Both sets of numbers are shown because neither is the demo's to overwrite: the per-record
                    judgements are identical in both columns.
                  </>,
                  <>
                    两组数字都摆在这里，因为哪一组都不是这个演示有资格改写的：两列背后逐条记录的判定完全相同。
                  </>,
                )}
              </li>
            </ul>
          </>
        ) : (
          <p className="notice">
            {pick(
              <>
                Recomputed from the logs loaded here. No <code>final_result.json</code> was loaded alongside, so there
                is nothing to compare against and nothing is claimed about the released numbers.
              </>,
              <>
                取自此处载入的日志重算。没有一并载入 <code>final_result.json</code>
                ，因此没有可比较的对象，也不对已发布的数字作任何陈述。
              </>,
            )}
          </p>
        )}
      </div>
    </section>
  )
}

/* --------------------------------------------------------- panel 3: per domain */

const DomainPanel: FC<{ model: RmR1Model; runs: string[] }> = ({ model, runs }) => {
  const { t, pick } = useSay()
  const summary = model.rmBench
  if (!summary) {
    return (
      <section className="panel rmr1-panel">
        <header className="panel-header">RM-Bench · {t({ en: 'by domain', zh: '按领域' })}</header>
        <div className="panel-body rmr1-body">
          <p className="notice">
            {t({
              en: 'hard, normal and easy are read off the same 3×3 matrix, so this breakdown needs the same three style files the panel above is missing.',
              zh: 'hard、normal、easy 都读自同一个 3×3 矩阵，因此这份细分需要上方面板同样缺少的那三个风格文件。',
            })}
          </p>
        </div>
      </section>
    )
  }

  const official = summary.official
  const hasOfficial =
    publishedIsComparable(summary, runs) &&
    summary.domains.some((domain) => official?.[domain.domain] !== undefined)
  const scale = rmBenchScale(model, runs)

  return (
    <section className="panel rmr1-panel">
      <header className="panel-header">RM-Bench · {t({ en: 'by domain', zh: '按领域' })}</header>
      <div className="panel-body rmr1-body">
        <p className="rmr1-lede">
          {pick(
            <>
              Recomputed here from the same records as the matrix above —{' '}
              {runs.length === 1 ? (
                <>
                  <span className="mono">{runs[0]}</span>'s
                </>
              ) : (
                <>one of the {runs.length} RM-Bench runs loaded, as the matrix panel says</>
              )}
              {scale ? (
                <>
                  , all {counted(scale.ids, ID)} of them; the <span className="nowrap">n</span> column is how many of
                  those fall in each domain
                </>
              ) : (
                <>
                  . Nothing loaded says how many records each row is over, so the <span className="nowrap">n</span>{' '}
                  column is not shown
                </>
              )}
              .
              {hasOfficial && (
                <>
                  {' '}
                  The Δ compares each row with the <code>final_result.json</code> loaded with that run, and it is the
                  one line of assembly described above, not a difference in the records.
                </>
              )}
            </>,
            <>
              这里的数字与上方矩阵取自同一批记录，在此重算 ——{' '}
              {runs.length === 1 ? (
                <>
                  属于 <span className="mono">{runs[0]}</span>
                </>
              ) : (
                <>属于已载入的 {runs.length} 个 RM-Bench 运行之一，具体是哪一个见上方矩阵面板</>
              )}
              {scale ? (
                <>
                  ，覆盖其全部 {count(scale.ids)} 条记录；<span className="nowrap">n</span> 一列是其中落在各领域的条数
                </>
              ) : (
                <>
                  。已载入的内容里没有说明每一行各覆盖多少条记录，因此不显示 <span className="nowrap">n</span> 一列
                </>
              )}
              。
              {hasOfficial && (
                <>
                  {' '}
                  Δ 是每一行与随这个运行一同载入的 <code>final_result.json</code> 之差；差别来自上面说明的那一行读法，而不是记录本身。
                </>
              )}
            </>,
          )}
        </p>
        <Wide
          label={{ en: 'RM-Bench by domain, scrollable', zh: 'RM-Bench 按领域，可横向滚动' }}
        >
        <table className="dom-table">
          <thead>
            <tr>
              <th>{t({ en: 'domain', zh: '领域' })}</th>
              {scale && <th className="rb-num">n</th>}
              <th className="rb-num">hard</th>
              <th className="rb-num">normal</th>
              <th className="rb-num">easy</th>
              <th className="rb-num">{t({ en: 'avg', zh: '平均' })}</th>
              {hasOfficial && (
                <th className="rb-num">
                  Δ <span className="verbatim">final_result.json</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {summary.domains.map((domain) => {
              const shipped = official?.[domain.domain]
              const held = scale?.perDomain.get(domain.domain)
              return (
                <tr key={domain.domain}>
                  <td className="mono">{domain.domain}</td>
                  {scale && <td className="rb-num faint">{held === undefined ? '—' : count(held)}</td>}
                  {(['hard', 'normal', 'easy'] as const).map((regime) => (
                    <td className="rb-num" key={regime}>
                      <span className="dom-meter" aria-hidden="true">
                        <span className="dom-fill" style={{ width: `${domain.matrix[regime] * 100}%` }} />
                      </span>
                      {pct(domain.matrix[regime])}
                    </td>
                  ))}
                  <td className="rb-num">{pct(domain.average)}</td>
                  {hasOfficial && (
                    <td className="rb-num faint">
                      {shipped === undefined ? '—' : points(domain.average - shipped)}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
        </Wide>
        <ul className="rmr1-notes">
          <li>
            {pick(
              <>
                hard is the mean of the three cells above the diagonal, normal the diagonal, easy the three below; avg
                is the mean of those three, as the benchmark defines it.
              </>,
              <>
                hard 是对角线之上三格的均值，normal 是对角线，easy 是其下三格；平均一列是这三者的均值，按基准自己的定义。
              </>,
            )}
          </li>
          <li>
            {pick(
              <>
                The logs carry five domain values — <code>safety-refuse</code> and <code>safety-response</code> are
                folded into <code>safety</code>, which is what the shipped script's <code>startswith</code> does.
              </>,
              <>
                日志中有五个 domain 取值 —— <code>safety-refuse</code> 与 <code>safety-response</code> 归入{' '}
                <code>safety</code>，这也是随附脚本里 <code>startswith</code> 的做法。
              </>,
            )}
          </li>
        </ul>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ dashboard */

export const ScoreDashboard: FC<{ model: RmR1Model }> = ({ model }) => {
  const rollup = useMemo(() => rewardBenchViews(model), [model])
  const runs = useMemo(() => rmBenchRuns(model), [model])

  return (
    <div className="rmr1-dash">
      <div className="rmr1-dash-inner">
        <RewardBenchPanel rollup={rollup} />
        <StyleMatrixPanel model={model} runs={runs} />
        <DomainPanel model={model} runs={runs} />
      </div>
    </div>
  )
}
