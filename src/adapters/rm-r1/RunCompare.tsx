/**
 * V3 · Run Compare — two runs of one benchmark, aligned and diffed.
 *
 * The view is the thin half: every rule about how two runs line up, and about
 * what the comparison may claim, lives in compare.ts where it can be tested
 * without a DOM. What is decided here is only how it reads.
 *
 * Three of those choices are load-bearing. The runs are called Run 1 and Run 2,
 * never A and B, because on this screen A and B are the judge's answer slots.
 * The position note below states measured counts — the harness shuffles the
 * slots unseeded, so how often two runs mirror each other is a fact about the
 * files in hand, not a rate this view is entitled to assume.
 *
 * And every figure states what it is over. A demo package carries the complete
 * outcome of every record plus the full text of a sample, so the matrix and the
 * movement table are computed from the complete tables — the benchmark's own
 * numbers — while the list underneath can only show the records that have text.
 * Those are two different denominators on one screen, so each panel prints its
 * own rather than borrowing the header's.
 *
 * All of that survives translation: 运行 1 / 运行 2 keeps the digits away from
 * the letters, and the counts are counts in either language. What never gets
 * translated is anything the files wrote — file names, run ids, group ids,
 * routes, `[[A]]`/`[[B]]`, and every word of the judge's own text.
 */

import { Fragment, useMemo, useState } from 'react'
import type { FC, ReactNode } from 'react'
import { VirtualList } from '../../shell/VirtualList'
import {
  alignKey,
  alignRuns,
  clip,
  comparableBenchmarks,
  formatCount,
  formatPercent,
  formatPoints,
  matchesFilter,
  pickedSide,
  questionOf,
  splitRuns,
} from './compare'
import type { Alignment, Cell, CellFilter, GroupDelta, Pair, Run } from './compare'
import { agreeOutcomes, outcomesFor, outcomesOfFile } from './model'
import type {
  Benchmark,
  CorDocument,
  Judgement,
  Message,
  OutcomeAgreement,
  OutcomeSet,
  RmR1Model,
} from './contract'
import { useLang } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import './compare.css'

/* ------------------------------------------------------------------ wording */

/** `t` for a plain phrase, `pick` for one that carries markup. Data goes through neither. */
function useSay(): { t: (str: Str) => string; pick: (en: ReactNode, zh: ReactNode) => ReactNode } {
  const { lang, t } = useLang()
  return { t, pick: (en, zh) => (lang === 'zh' ? zh : en) }
}

const BENCHMARK_LABEL: Record<Benchmark, string> = {
  rewardbench: 'RewardBench',
  'rm-bench': 'RM-Bench',
  'rmb-pairwise': 'RMB pairwise',
  'rmb-bon': 'RMB best-of-n',
}

/** Where the counterpart file lives in the release, per family. */
const COUNTERPART_PATH: Record<Benchmark, string> = {
  rewardbench: 'reward_bench/log_result/logs.json',
  'rm-bench': 'RM-Bench/logs/total_dataset_{1,2,3}_<model>.json',
  'rmb-pairwise': 'RMB/Pairwise_set_*/log_result/logs.json',
  'rmb-bon': 'RMB/BoN_set_*/log_result/raw_logs.json',
}

/**
 * Our gloss on RM-Bench's style index, not a field any log carries — the file
 * holds the index, and these are the words for it. The index stays beside the
 * gloss so a reader can always get back to what is written in the data.
 */
const STYLE_LABEL: Str[] = [
  { en: 'concise', zh: '简洁' },
  { en: 'detailed', zh: '详细' },
  { en: 'detailed + markdown', zh: '详细 + markdown' },
]

const CELL_LABEL: Record<Cell, Str> = {
  'both-right': { en: 'both right', zh: '两边都判对' },
  'run1-only': { en: 'Run 1 only', zh: '仅运行 1 判对' },
  'run2-only': { en: 'Run 2 only', zh: '仅运行 2 判对' },
  'both-wrong': { en: 'both wrong', zh: '两边都判错' },
  indeterminate: { en: 'no result recorded', zh: '没有记录结果' },
}

const RUN_ONE: Str = { en: 'Run 1', zh: '运行 1' }
const RUN_TWO: Str = { en: 'Run 2', zh: '运行 2' }

const CHOSEN: Str = { en: 'chosen', zh: '优选回答' }
const REJECTED: Str = { en: 'rejected', zh: '次选回答' }

function styleWord(t: (str: Str) => string, index: number): string {
  const label = STYLE_LABEL[index]
  return label ? t(label) : String(index)
}

/* ---------------------------------------------------------------- counting */

/**
 * A counted noun in English, which inflects at n = 1. The Chinese half of every
 * sentence below is written out separately rather than derived from this: 条 and
 * 行 are measure words and take the same form whatever the numeral is.
 */
interface Countable {
  one: string
  many: string
}

const RECORD: Countable = { one: 'record', many: 'records' }
const ROW: Countable = { one: 'row', many: 'rows' }
const JUDGEMENT: Countable = { one: 'judgement', many: 'judgements' }

function counted(n: number, noun: Countable): string {
  return `${formatCount(n)} ${n === 1 ? noun.one : noun.many}`
}

/* ---------------------------------------------------------- what is a run */

/**
 * One run, as the model layer counts runs, with its judgements gathered.
 *
 * `splitRuns` groups judgements by the file they arrived in. That is the right
 * question for a record list and the wrong one for this picker: one checkpoint
 * writes RM-Bench into three `total_dataset_N` files and RMB into a directory
 * per set, so a package holding a single checkpoint's whole result directory
 * offers several "runs" that are all the same run. The panels below then refuse
 * to draw a figure — correctly — which leaves the picker's vocabulary claiming a
 * second run that the rest of the screen denies.
 *
 * `model.runs` is the model layer's own answer: one entry per run, and only for
 * a benchmark that has two of them (see `LoadedRun` in `contract.ts`). It is
 * empty for that single-checkpoint package however many files it packs, and this
 * view then shows what is loaded and how to get a counterpart instead of a
 * picker.
 */
export interface Offered extends Run {
  /** The run id the package declared, or `''` when it declared none. */
  runId: string
  /** Every file label this run's judgements arrived in, in load order. */
  files: string[]
}

export function offeredRuns(model: RmR1Model): Offered[] {
  const byFile = new Map<string, Run>()
  for (const run of splitRuns(model)) byFile.set(`${run.fileName} :: ${run.benchmark}`, run)

  const offered: Offered[] = []
  for (const loaded of model.runs) {
    const judgements: Judgement[] = []
    for (const file of loaded.files) {
      const part = byFile.get(`${file} :: ${loaded.benchmark}`)
      if (part) judgements.push(...part.judgements)
    }
    if (judgements.length === 0) continue
    // Recounted over the whole run rather than summed per file: three style
    // files repeat no pair between them, and three per-file counts of zero say
    // nothing about the merged run either way.
    const seen = new Set<string>()
    let duplicateKeys = 0
    for (const judgement of judgements) {
      const key = alignKey(judgement)
      if (seen.has(key)) duplicateKeys += 1
      else seen.add(key)
    }
    offered.push({
      key: `${loaded.run === '' ? loaded.fileName : loaded.run} :: ${loaded.benchmark}`,
      fileName: loaded.fileName,
      benchmark: loaded.benchmark,
      judgements,
      duplicateKeys,
      runId: loaded.run,
      files: [...loaded.files],
    })
  }
  return offered
}

/* ------------------------------------------------------------------- basis */

/**
 * What the matrix, the movement table and the two accuracies are computed over.
 *
 * `benchmark` when both runs packed a *complete* outcome table under their own
 * run id: those tables hold every record the benchmark has, so the figures are
 * the benchmark's and the panels say whose tables they came from. `aligned` is
 * the fallback for two dropped logs, which carry no table — then the figures are
 * over the records the two files share and the panels say that instead.
 *
 * Nothing in between, and no third case where the denominator is left to the
 * reader: `runs` is the attribution and `agreement.aligned` is the denominator,
 * and both are printed wherever a number from here is.
 */
interface Basis {
  kind: 'benchmark' | 'aligned'
  /** The two run ids the tables name, in order. Empty for `aligned`. */
  runs: string[]
  agreement: OutcomeAgreement
  groups: GroupDelta[]
  /** One agreement per group, so the record list can quote its own filter's size. */
  byGroup: Map<string, OutcomeAgreement>
}

/**
 * The complete outcome table behind one run, or nothing.
 *
 * `run !== ''` is not pedantry. A table that does not name its run cannot be
 * attributed, and an unattributable figure is the one thing this view will not
 * draw — it shows the caveat instead.
 */
function completeTableFor(model: RmR1Model, run: Offered): OutcomeSet | undefined {
  // Every file of the run, because one run's table is packed under the files it
  // was read from and `fileName` is only the first of them — RM-Bench's is named
  // `total_dataset_{1,2,3}_…`, which is a run's name and no file's.
  const byFile = run.files
    .map((file) => outcomesOfFile(model, file))
    .find((one) => one !== undefined)
  const set =
    byFile ?? outcomesFor(model, run.benchmark, run.runId === '' ? run.fileName : run.runId)[0]
  return set !== undefined && set.benchmark === run.benchmark && set.complete && set.run !== ''
    ? set
    : undefined
}

function inGroup(set: OutcomeSet, group: string): OutcomeSet {
  return { ...set, records: set.records.filter((record) => record.group === group) }
}

function basisOf(model: RmR1Model, one: Offered, two: Offered, alignment: Alignment): Basis {
  const setOne = completeTableFor(model, one)
  const setTwo = completeTableFor(model, two)
  // Two tables that name the same run are one table: comparing it with itself
  // would report a run in perfect agreement with itself and call that two runs.
  // The picker no longer offers one run twice; this holds whether or not it does.
  if (setOne !== undefined && setTwo !== undefined && setOne.run !== setTwo.run) {
    const agreement = agreeOutcomes(setOne, setTwo)
    if (agreement.aligned > 0) {
      const byGroup = new Map<string, OutcomeAgreement>()
      const groups: GroupDelta[] = []
      for (const tally of setOne.groups) {
        const slice = agreeOutcomes(inGroup(setOne, tally.group), inGroup(setTwo, tally.group))
        byGroup.set(tally.group, slice)
        if (slice.determinate === 0) continue
        groups.push({
          group: tally.group,
          aligned: slice.determinate,
          oneRight: slice.oneRight,
          twoRight: slice.twoRight,
          delta: (100 * (slice.twoRight - slice.oneRight)) / slice.determinate,
        })
      }
      groups.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.aligned - a.aligned)
      return { kind: 'benchmark', runs: [setOne.run, setTwo.run], agreement, groups, byGroup }
    }
  }
  return {
    kind: 'aligned',
    runs: [],
    agreement: {
      aligned: alignment.pairs.length,
      counts: alignment.counts,
      onlyInRun1: alignment.onlyInRun1,
      onlyInRun2: alignment.onlyInRun2,
      determinate: alignment.determinate,
      oneRight: alignment.oneRight,
      twoRight: alignment.twoRight,
    },
    groups: [...alignment.groups],
    byGroup: new Map(),
  }
}

/**
 * How many records the current filter holds across the whole basis, or `null`
 * when the list on screen already is the whole basis and there is nothing to
 * qualify.
 */
function cellTotal(basis: Basis, cell: CellFilter, group: string | null): number | null {
  if (basis.kind !== 'benchmark') return null
  const agreement = group === null ? basis.agreement : basis.byGroup.get(group)
  if (agreement === undefined) return null
  if (cell === 'all') return agreement.aligned
  if (cell === 'disagree') return agreement.counts['run1-only'] + agreement.counts['run2-only']
  return agreement.counts[cell]
}

/* ====================================================================== view */

export interface RunCompareProps {
  model: RmR1Model
  /** `?record=` — selects the pair containing it, in either run. */
  recordId?: string
  /** Optional hand-off to the judgement browser. The button hides when absent. */
  onOpenRecord?: (id: string) => void
}

const ROW_HEIGHT = 28

export const RunCompare: FC<RunCompareProps> = ({ model, recordId, onOpenRecord }) => {
  const { t, pick } = useSay()
  // Two lists, two questions. `files` is what arrived, and is what the "nothing
  // to compare" screen enumerates; `offered` is how many runs that adds up to,
  // which is the only thing the picker may speak of.
  const files = useMemo(() => splitRuns(model), [model])
  const offered = useMemo(() => offeredRuns(model), [model])
  const comparable = useMemo(() => comparableBenchmarks(offered), [offered])

  const [pickedOne, setPickedOne] = useState<string>()
  const [pickedTwo, setPickedTwo] = useState<string>()
  const [cell, setCell] = useState<CellFilter>('disagree')
  const [group, setGroup] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string>()

  // Only runs whose benchmark has a counterpart are offered, so no choice in
  // the picker can reach a screen with nothing to compare.
  const pickable = offered.filter((run) => comparable.includes(run.benchmark))
  const runOne = pickable.find((run) => run.key === pickedOne) ?? pickable[0]
  const candidates = runOne
    ? pickable.filter((run) => run.benchmark === runOne.benchmark && run.key !== runOne.key)
    : []
  const runTwo = candidates.find((run) => run.key === pickedTwo) ?? candidates[0]

  const alignment = useMemo(
    () => (runOne && runTwo ? alignRuns(runOne, runTwo) : null),
    [runOne, runTwo],
  )

  // The complete tables are the source of every figure that carries the
  // benchmark's name; the alignment above stays what the record list is.
  const basis = useMemo(
    () => (runOne && runTwo && alignment ? basisOf(model, runOne, runTwo, alignment) : null),
    [model, runOne, runTwo, alignment],
  )

  const filtered = useMemo(
    () => (alignment ? alignment.pairs.filter((pair) => matchesFilter(pair, cell, group)) : []),
    [alignment, cell, group],
  )

  const linkedIndex = useMemo(
    () =>
      recordId === undefined
        ? -1
        : filtered.findIndex((pair) => pair.one.id === recordId || pair.two.id === recordId),
    [filtered, recordId],
  )
  const linkMissed =
    recordId !== undefined &&
    alignment !== null &&
    !alignment.pairs.some((pair) => pair.one.id === recordId || pair.two.id === recordId)

  const selected =
    filtered.find((pair) => pair.key === selectedKey) ??
    (linkedIndex >= 0 ? filtered[linkedIndex] : undefined) ??
    filtered[0]

  if (!runOne || !runTwo || !alignment || !basis) {
    return <NotEnoughRuns files={files} />
  }

  const inFilter = cellTotal(basis, cell, group)
  // Files of a benchmark that has only one run loaded. Listed by file because
  // that is what the reader dropped; counted as runs is what left them out.
  const unpaired = files.filter((file) => !comparable.includes(file.benchmark))

  return (
    <section className="rc">
      <header className="rc-head">
        <RunPicker
          label={RUN_ONE}
          runs={pickable}
          value={runOne.key}
          onChange={(key) => {
            setPickedOne(key)
            setPickedTwo(undefined)
            setSelectedKey(undefined)
          }}
        />
        <RunPicker
          label={RUN_TWO}
          runs={candidates}
          value={runTwo.key}
          onChange={(key) => {
            setPickedTwo(key)
            setSelectedKey(undefined)
          }}
        />
        <span className="badge info">{BENCHMARK_LABEL[runOne.benchmark]}</span>
        <span className="spacer" />
        <Headline basis={basis} benchmark={runOne.benchmark} listed={alignment.pairs.length} />
        {unpaired.length > 0 && (
          <span className="small faint rc-unpaired">
            {t({
              en: 'Not offered above, no second run of that benchmark loaded:',
              zh: '下面这些没有出现在上方的选择框里，因为同一基准只载入了一个运行：',
            })}{' '}
            {unpaired.map((run) => `${run.fileName} (${BENCHMARK_LABEL[run.benchmark]})`).join(', ')}
          </span>
        )}
      </header>

      {alignment.pairs.length === 0 ? (
        <NoOverlap runOne={runOne} runTwo={runTwo} />
      ) : (
        <>
          <PositionNote alignment={alignment} />
          <AlignmentNote
            alignment={alignment}
            basis={basis}
            runOne={runOne}
            runTwo={runTwo}
          />

          <div className="rc-summary">
            <AgreementMatrix
              basis={basis}
              benchmark={runOne.benchmark}
              active={cell}
              onPick={(next) => {
                setCell(next)
                setSelectedKey(undefined)
              }}
            />
            <GroupDeltas
              basis={basis}
              benchmark={runOne.benchmark}
              active={group}
              onPick={(next) => {
                setGroup(next)
                setSelectedKey(undefined)
              }}
            />
          </div>

          <div className="rc-split">
            <div className="panel rc-list">
              <div className="panel-header">
                <span>
                  {pick(
                    <>{counted(filtered.length, RECORD)}</>,
                    <>{formatCount(filtered.length)} 条记录</>,
                  )}
                </span>
                <span className="rc-filter">{filterLabel(t, cell, group)}</span>
                {(cell !== 'disagree' || group !== null) && (
                  <button
                    type="button"
                    className="btn ghost rc-clear"
                    onClick={() => {
                      setCell('disagree')
                      setGroup(null)
                    }}
                  >
                    {t({ en: 'reset', zh: '重置' })}
                  </button>
                )}
                <span className="spacer" />
                {linkMissed && (
                  <span className="badge warn">
                    {pick(
                      <>no record “{clip(recordId ?? '', 40)}” here</>,
                      <>这里没有「{clip(recordId ?? '', 40)}」这条记录</>,
                    )}
                  </span>
                )}
              </div>
              <ListScope
                basis={basis}
                benchmark={runOne.benchmark}
                listed={filtered.length}
                inFilter={inFilter}
              />
              <VirtualList
                items={filtered}
                estimateSize={ROW_HEIGHT}
                scrollToIndex={linkedIndex >= 0 ? linkedIndex : undefined}
                getKey={(pair) => pair.key}
                label={t({ en: 'Records with full text', zh: '带有完整文本的记录' })}
                empty={
                  <span className="muted">
                    {inFilter !== null && inFilter > 0
                      ? pick(
                          <>
                            Of the {counted(inFilter, RECORD)} in this filter, none are among the{' '}
                            {formatCount(alignment.pairs.length)} this package carries full text for.
                          </>,
                          <>
                            符合当前筛选的 {formatCount(inFilter)} 条记录，都不在这份数据包带有完整文本的{' '}
                            {formatCount(alignment.pairs.length)} 条里。
                          </>,
                        )
                      : t({ en: 'No records in this filter.', zh: '当前筛选下没有记录。' })}
                  </span>
                }
                renderRow={(pair, index) => (
                  <button
                    type="button"
                    className="list-row rc-row"
                    aria-current={pair.key === selected?.key || undefined}
                    onClick={() => setSelectedKey(pair.key)}
                  >
                    <span className="list-index">{index + 1}</span>
                    <Mark judgement={pair.one} />
                    <Mark judgement={pair.two} />
                    <span className="badge rc-group">{pair.group}</span>
                    {pair.styleIndex !== undefined && (
                      <span className="rc-style faint">{styleWord(t, pair.styleIndex)}</span>
                    )}
                    <span className="truncate rc-question">{clip(questionOf(pair.one), 240)}</span>
                    {pair.mirrored && (
                      <span className="badge warn">{t({ en: 'mirrored', zh: '位置互换' })}</span>
                    )}
                  </button>
                )}
              />
            </div>

            <div className="panel rc-detail">
              <div className="panel-header">
                <span>{t({ en: 'Side by side', zh: '并排对照' })}</span>
                {selected?.mirrored && (
                  <span className="badge warn">{t({ en: 'slots mirrored', zh: '两边位置互换' })}</span>
                )}
              </div>
              <div className="panel-body rc-detail-body">
                {selected ? (
                  <PairDetail
                    pair={selected}
                    runOne={runOne}
                    runTwo={runTwo}
                    onOpenRecord={onOpenRecord}
                  />
                ) : (
                  <p className="muted">{t({ en: 'Nothing selected.', zh: '尚未选中记录。' })}</p>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  )
}

export default RunCompare

/* ------------------------------------------------------------------- pieces */

/**
 * The one line in the header, and the first place the denominator is stated.
 * "Unweighted" because it is the mean over the records counted here; the
 * headline RewardBench number weights its four sections.
 */
function Headline({
  basis,
  benchmark,
  listed,
}: {
  basis: Basis
  benchmark: Benchmark
  listed: number
}) {
  const { pick } = useSay()
  const { agreement } = basis
  const total = formatCount(agreement.aligned)
  const one = formatPercent(agreement.oneRight, agreement.determinate)
  const two = formatPercent(agreement.twoRight, agreement.determinate)
  if (agreement.aligned === 0) return null

  if (basis.kind === 'benchmark') {
    return (
      <span className="small muted">
        {pick(
          <>
            All {counted(agreement.aligned, RECORD)} of {BENCHMARK_LABEL[benchmark]}, from the
            complete outcome table each run packed · unweighted accuracy over all {total}: Run 1{' '}
            {one} · Run 2 {two}
            {listed > 0 && <> · full text for {formatCount(listed)} of them, listed below</>}
          </>,
          <>
            {BENCHMARK_LABEL[benchmark]} 全部 {total} 条记录，来自两个运行各自打包的完整结果表 · 在这{' '}
            {total} 条上的未加权准确率：运行 1 {one} · 运行 2 {two}
            {listed > 0 && <> · 其中 {formatCount(listed)} 条带有完整文本，列在下方</>}
          </>,
        )}
      </span>
    )
  }
  return (
    <span className="small muted">
      {pick(
        <>
          {counted(agreement.aligned, RECORD)} aligned from the two files loaded · unweighted
          accuracy over those {total}: Run 1 {one} · Run 2 {two}. Neither file carries a complete
          outcome table, so these are the loaded records&apos; rates and not{' '}
          {BENCHMARK_LABEL[benchmark]}&apos;s.
        </>,
        <>
          从载入的两个文件中对齐了 {total} 条记录 · 在这 {total} 条上的未加权准确率：运行 1 {one} · 运行 2{' '}
          {two}。两个文件都没有带完整结果表，所以这是已载入记录上的比率，不是整个 {BENCHMARK_LABEL[benchmark]}{' '}
          上的。
        </>,
      )}
    </span>
  )
}

/**
 * The record list is the sample even when the panels above it are not, so it
 * says so in its own words, next to itself, rather than relying on a line in the
 * header a reader has already scrolled past.
 */
function ListScope({
  basis,
  benchmark,
  listed,
  inFilter,
}: {
  basis: Basis
  benchmark: Benchmark
  listed: number
  inFilter: number | null
}) {
  const { pick } = useSay()
  if (basis.kind !== 'benchmark') return null
  const total = formatCount(basis.agreement.aligned)
  return (
    <p className="rc-caption rc-scope">
      {inFilter === null
        ? pick(
            <>
              Listed here are only the records this package carries full text for; the matrix and the
              movement table above are over all {counted(basis.agreement.aligned, RECORD)} of{' '}
              {BENCHMARK_LABEL[benchmark]}.
            </>,
            <>
              下面列出的只是这份数据包带有完整文本的那些记录；上方的矩阵与分组表覆盖{' '}
              {BENCHMARK_LABEL[benchmark]} 全部 {total} 条记录。
            </>,
          )
        : pick(
            <>
              Listed here {listed === 1 ? 'is' : 'are'} the {counted(listed, RECORD)} this package
              carries full text for. Across {BENCHMARK_LABEL[benchmark]}, {counted(inFilter, RECORD)}{' '}
              {inFilter === 1 ? 'falls' : 'fall'} in this filter — the matrix and the movement table
              above are over all {total}.
            </>,
            <>
              下面列出的是这份数据包带有完整文本的 {formatCount(listed)} 条记录。在整个{' '}
              {BENCHMARK_LABEL[benchmark]} 上，符合当前筛选的共有 {formatCount(inFilter)} 条 ——
              上方的矩阵与分组表覆盖全部 {total} 条。
            </>,
          )}
    </p>
  )
}

function filterLabel(t: (str: Str) => string, cell: CellFilter, group: string | null): string {
  const cellPart =
    cell === 'all'
      ? t({ en: 'all records', zh: '全部记录' })
      : cell === 'disagree'
        ? t({ en: 'disagreements', zh: '判定分歧' })
        : t(CELL_LABEL[cell])
  return group === null ? cellPart : `${cellPart} · ${group}`
}

/**
 * What is loaded, listed by file rather than by run.
 *
 * This screen is reached exactly when the model layer reports fewer than two
 * runs of any one benchmark, so it must not describe what it lists as runs —
 * three `total_dataset_N` files are one run, and that is why the reader is here.
 * Files are what was dropped and what the counterpart advice below is about.
 */
function NotEnoughRuns({ files }: { files: readonly Run[] }) {
  const { t, pick } = useSay()
  return (
    <div className="rc-empty stack">
      <p className="lead">
        {t({
          en: 'Run Compare needs two runs of the same benchmark — two checkpoints, not two files of one. It aligns them record by record and shows where the two judges disagreed, and why.',
          zh: '对比需要同一个基准的两个运行，也就是两个检查点，而不是同一个运行的两个文件。它把两边逐条记录对齐，标出两个评判模型判定不一致的记录，并指出分歧在哪里。',
        })}
      </p>
      {files.length === 0 ? (
        <p className="muted">{t({ en: 'No judgements loaded.', zh: '没有载入任何判例。' })}</p>
      ) : (
        <>
          <p className="muted">{t({ en: 'Loaded, by file:', zh: '已载入的文件：' })}</p>
          <ul className="rc-loaded">
            {files.map((file) => (
              <li key={file.key}>
                {pick(
                  <>
                    <code>{file.fileName}</code> — {formatCount(file.judgements.length)}{' '}
                    {BENCHMARK_LABEL[file.benchmark]} judgement
                    {file.judgements.length === 1 ? '' : 's'}
                  </>,
                  <>
                    <code>{file.fileName}</code> —— {formatCount(file.judgements.length)} 条{' '}
                    {BENCHMARK_LABEL[file.benchmark]} 判例
                  </>,
                )}
              </li>
            ))}
          </ul>
          <div className="notice">
            <span>
              {pick(
                <>
                  Drop the same file from a second model. The RM-R1 release evaluates two checkpoints
                  under <code>eval/result/</code> with the same layout beneath each —{' '}
                  <code>RM-R1-Qwen2.5-Instruct-32B/</code> and{' '}
                  <code>RM-R1-DeepSeek-Distilled-Qwen-32B/</code> — so the counterpart of what you have
                  is the same path under the other directory:{' '}
                  <code>
                    {[...new Set(files.map((file) => COUNTERPART_PATH[file.benchmark]))].join(' · ')}
                  </code>
                </>,
                <>
                  再把另一个模型的同一个文件拖进来。RM-R1 的发布结果在 <code>eval/result/</code>{' '}
                  下评测了两个检查点，两边目录结构相同 —— <code>RM-R1-Qwen2.5-Instruct-32B/</code> 与{' '}
                  <code>RM-R1-DeepSeek-Distilled-Qwen-32B/</code> ——
                  所以你手上这份文件的对应文件，就是另一个目录下的同一路径：{' '}
                  <code>
                    {[...new Set(files.map((file) => COUNTERPART_PATH[file.benchmark]))].join(' · ')}
                  </code>
                </>,
              )}
            </span>
          </div>
          <p className="small faint">
            {pick(
              <>
                Both checkpoints' RewardBench logs are called <code>logs.json</code>; drop them together
                anyway — the adapter suffixes a repeated file name, so the two runs keep separate record
                ids.
              </>,
              <>
                两个检查点的 RewardBench 日志都叫 <code>logs.json</code>；一起拖进来即可 ——
                适配器会给重名的文件加上后缀，两个运行的记录 id 不会混在一起。
              </>,
            )}
          </p>
        </>
      )}
    </div>
  )
}

function RunPicker({
  label,
  runs,
  value,
  onChange,
}: {
  label: Str
  runs: readonly Run[]
  value: string
  onChange: (key: string) => void
}) {
  const { t } = useSay()
  return (
    <label className="rc-picker">
      <span className="rc-picker-label">{t(label)}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {runs.map((run) => (
          <option key={run.key} value={run.key}>
            {run.fileName} · {BENCHMARK_LABEL[run.benchmark]} ({formatCount(run.judgements.length)})
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * The one paragraph a reviewer who knows the harness will look for. Both
 * branches state a measured count; neither claims a rate for runs not in hand.
 *
 * The counts are over the records this view has full text for, and say so: the
 * shuffle flag lives in the log, not in the outcome table, so this is the one
 * panel a complete table cannot widen.
 */
function PositionNote({ alignment }: { alignment: Alignment }) {
  const { pick } = useSay()
  const { mirrored, pairs, verdictComparable, rawWouldMisread } = alignment
  return (
    <div className={`notice rc-note ${mirrored > 0 ? 'warn' : ''}`}>
      <span>
        {pick(
          <>
            Verdicts are compared after normalising position: the harness assigns the A/B slots with an
            unseeded <code>np.random.rand() &gt; 0.5</code>, so <code>chosenShownAs</code>, not the
            letter in <code>&lt;answer&gt;</code>, is what makes two runs comparable.{' '}
            {mirrored > 0 ? (
              <>
                {formatCount(mirrored)} of the {counted(pairs.length, RECORD)} this view has full text
                for {mirrored === 1 ? 'was' : 'were'} shown with the slots swapped; on{' '}
                {formatCount(rawWouldMisread)} of the {formatCount(verdictComparable)} of those where
                both verdicts parsed, comparing the raw <code>[[A]]</code>/<code>[[B]]</code> letters
                returns the opposite answer.
              </>
            ) : (
              <>
                These two runs happen to share their shuffle — the slots match on all{' '}
                {counted(pairs.length, RECORD)} this view has full text for, so raw{' '}
                <code>[[A]]</code>/<code>[[B]]</code> would have agreed here too (
                {counted(rawWouldMisread, RECORD)} affected). Nothing in the harness guarantees that
                for the next pair of runs, which is why the comparison is normalised rather than
                trusted.
              </>
            )}
          </>,
          <>
            判定是在位置归一化之后才比较的：评测脚本用没有固定随机种子的{' '}
            <code>np.random.rand() &gt; 0.5</code> 决定 A/B 两个位置，因此让两个运行可比的是{' '}
            <code>chosenShownAs</code>，而不是 <code>&lt;answer&gt;</code> 里的那个字母。
            {mirrored > 0 ? (
              <>
                本视图能读到完整文本的 {formatCount(pairs.length)} 条记录中，有 {formatCount(mirrored)}{' '}
                条在两个运行里位置相反；其中两边判定都解析成功的有 {formatCount(verdictComparable)}{' '}
                条，这些里面有 {formatCount(rawWouldMisread)} 条如果直接比较原始的{' '}
                <code>[[A]]</code>/<code>[[B]]</code> 字母，会得到相反的结论。
              </>
            ) : (
              <>
                这两个运行恰好打乱成了同一种顺序 —— 本视图能读到完整文本的 {formatCount(pairs.length)}{' '}
                条记录位置全都一致，所以在这里直接比较原始的 <code>[[A]]</code>/<code>[[B]]</code>{' '}
                也会得到同样的结论（受影响记录 {formatCount(rawWouldMisread)}{' '}
                条）。评测脚本并不保证下一对运行也是如此，所以这里先归一化再比较，而不是默认它成立。
              </>
            )}
          </>,
        )}
      </span>
    </div>
  )
}

/**
 * Two runs of one family that share no record. RM-Bench makes this reachable:
 * its three style files hold the same prompts and the same `chosen`, but rotate
 * `rejected` by one style each, so the same row in `total_dataset_1` and
 * `total_dataset_2` is a different comparison. Aligning on the pair refuses to
 * put them side by side rather than pairing them by row number and calling the
 * difference a regression.
 */
function overlapAdvice(runOne: Run, runTwo: Run): Str {
  return runOne.benchmark === 'rm-bench' && runTwo.benchmark === 'rm-bench'
    ? {
        en:
          'RM-Bench splits its three response styles across total_dataset_1/2/3, and each file pairs ' +
          'the chosen answer against a different rejected style, so two different style files overlap ' +
          'only where two rejected responses happen to be identical. Compare the same style file ' +
          'across two models.',
        zh:
          'RM-Bench 把三种回答风格分放在 total_dataset_1/2/3 里，每个文件都拿不同风格的次选回答去和优选回答配对，' +
          '所以两个不同的风格文件只有在两条次选回答恰好相同时才有交集。请用两个模型的同一个风格文件来比较。',
      }
    : {
        en: 'These two files appear to cover different data.',
        zh: '这两个文件看起来覆盖的是不同的数据。',
      }
}

function NoOverlap({ runOne, runTwo }: { runOne: Run; runTwo: Run }) {
  const { t, pick } = useSay()
  return (
    <div className="notice bad rc-note">
      <span>
        {pick(
          <>
            No record in <code>{runOne.fileName}</code> matches one in <code>{runTwo.fileName}</code>.
            Runs align on the question and the two responses, so two runs of one benchmark over the same
            data align completely.
          </>,
          <>
            <code>{runOne.fileName}</code> 中没有任何一条记录能与 <code>{runTwo.fileName}</code>{' '}
            中的记录对上。对齐是按问题和两条回答做的，所以同一批数据上的两个运行会完全对齐。
          </>,
        )}
        {pick(' ', '')}
        {t(overlapAdvice(runOne, runTwo))}
      </span>
    </div>
  )
}

function AlignmentNote({
  alignment,
  basis,
  runOne,
  runTwo,
}: {
  alignment: Alignment
  basis: Basis
  runOne: Run
  runTwo: Run
}) {
  const { t, pick } = useSay()
  const unmatched = alignment.onlyInRun1 + alignment.onlyInRun2
  const duplicates = runOne.duplicateKeys + runTwo.duplicateKeys
  // Half the larger run left unpaired is not a data quirk, it is the wrong pair
  // of files; say which files would have been the right ones.
  const mostlyUnmatched =
    alignment.pairs.length * 2 <
    Math.max(runOne.judgements.length, runTwo.judgements.length)
  if (unmatched === 0 && duplicates === 0 && alignment.verdictConflicts === 0) return null

  // Sentences are collected and joined rather than concatenated with a literal
  // space: Chinese ends a sentence with 。and a space after it is a typo.
  const parts: ReactNode[] = []
  if (unmatched > 0) {
    parts.push(
      basis.kind === 'benchmark'
        ? pick(
            <>
              {counted(alignment.onlyInRun1, RECORD)} in Run 1&apos;s text and{' '}
              {formatCount(alignment.onlyInRun2)} in Run 2&apos;s have no counterpart on the other side;
              they cannot be read side by side and are not listed below. The matrix and the movement
              table come from the two complete outcome tables and are unaffected.
            </>,
            <>
              运行 1 的文本里有 {formatCount(alignment.onlyInRun1)} 条、运行 2 的文本里有{' '}
              {formatCount(alignment.onlyInRun2)}{' '}
              条记录在另一边没有对应记录；它们无法并排阅读，也不会出现在下面的列表里。矩阵与分组表来自两张完整结果表，不受影响。
            </>,
          )
        : pick(
            <>
              {counted(alignment.onlyInRun1, RECORD)} in Run 1 and {formatCount(alignment.onlyInRun2)} in Run 2
              have no counterpart on the other side; they are excluded from every number here.
            </>,
            <>
              运行 1 有 {formatCount(alignment.onlyInRun1)} 条、运行 2 有 {formatCount(alignment.onlyInRun2)}{' '}
              条记录在另一边没有对应记录；这里的每个数字都不含它们。
            </>,
          ),
    )
    if (mostlyUnmatched) parts.push(t(overlapAdvice(runOne, runTwo)))
  }
  if (duplicates > 0) {
    parts.push(
      pick(
        <>
          {counted(duplicates, RECORD)} {duplicates === 1 ? 'repeats' : 'repeat'} a pair that already
          appeared earlier in the same run; only the first of each is compared.
        </>,
        <>有 {formatCount(duplicates)} 条记录与同一运行中更早出现的某一对完全相同；每组只比较第一条。</>,
      ),
    )
  }
  if (alignment.verdictConflicts > 0) {
    parts.push(
      pick(
        <>
          On {counted(alignment.verdictConflicts, JUDGEMENT)} the verdict parsed out of the
          judge&apos;s text contradicts the harness&apos;s own <code>results</code>; the matrix
          follows <code>results</code>.
        </>,
        <>
          有 {formatCount(alignment.verdictConflicts)} 条判例，从评判文本里解析出的判定与评测脚本自己记的{' '}
          <code>results</code> 不一致；矩阵以 <code>results</code> 为准。
        </>,
      ),
    )
  }

  return (
    <div className="notice warn rc-note">
      <span>
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 && pick(' ', '')}
            {part}
          </Fragment>
        ))}
      </span>
    </div>
  )
}

/**
 * The denominator, printed inside the panel that uses it. A reader who scrolled
 * past the header still learns what these four numbers are over, and whose runs
 * they belong to.
 */
function MatrixCaption({ basis, benchmark }: { basis: Basis; benchmark: Benchmark }) {
  const { pick } = useSay()
  const total = formatCount(basis.agreement.aligned)
  const { onlyInRun1, onlyInRun2 } = basis.agreement
  if (basis.kind !== 'benchmark') {
    return (
      <p className="rc-caption">
        {pick(
          <>
            Over the {counted(basis.agreement.aligned, RECORD)} the two loaded files share. Neither
            carries a complete outcome table, so this is those records&apos; agreement and not{' '}
            {BENCHMARK_LABEL[benchmark]}&apos;s.
          </>,
          <>
            覆盖两个已载入文件共有的 {total} 条记录。两边都没有带完整结果表，所以这是这些记录上的一致性，不是整个{' '}
            {BENCHMARK_LABEL[benchmark]} 上的。
          </>,
        )}
      </p>
    )
  }
  return (
    <p className="rc-caption">
      {pick(
        <>
          Over all {counted(basis.agreement.aligned, RECORD)} of {BENCHMARK_LABEL[benchmark]}, from
          the complete outcome tables packed by <code>{basis.runs[0]}</code> and{' '}
          <code>{basis.runs[1]}</code> — not from the records listed below.
        </>,
        <>
          覆盖 {BENCHMARK_LABEL[benchmark]} 全部 {total} 条记录，来自 <code>{basis.runs[0]}</code> 与{' '}
          <code>{basis.runs[1]}</code> 打包的完整结果表 —— 不是下面列出的那些记录。
        </>,
      )}
      {onlyInRun1 + onlyInRun2 > 0 &&
        pick(
          <>
            {' '}
            {counted(onlyInRun1, ROW)} appear only in Run 1&apos;s table and{' '}
            {formatCount(onlyInRun2)} only in Run 2&apos;s; they are outside every count here.
          </>,
          <>
            另有 {formatCount(onlyInRun1)} 行只出现在运行 1 的表里、{formatCount(onlyInRun2)}{' '}
            行只出现在运行 2 的表里；这里的每个数字都不含它们。
          </>,
        )}
    </p>
  )
}

function AgreementMatrix({
  basis,
  benchmark,
  active,
  onPick,
}: {
  basis: Basis
  benchmark: Benchmark
  active: CellFilter
  onPick: (cell: CellFilter) => void
}) {
  const { t, pick } = useSay()
  const cells: Cell[] = ['both-right', 'run1-only', 'run2-only', 'both-wrong']
  const counts = basis.agreement.counts
  const total = basis.agreement.aligned
  return (
    <div className="panel rc-matrix">
      <div className="panel-header">
        <span>{t({ en: 'Agreement', zh: '判定一致性' })}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn ghost rc-clear"
          aria-pressed={active === 'disagree'}
          onClick={() => onPick('disagree')}
        >
          {t({ en: 'disagreements', zh: '判定分歧' })}
        </button>
      </div>
      <MatrixCaption basis={basis} benchmark={benchmark} />
      <div className="rc-grid">
        <span />
        <span className="rc-axis">{t({ en: 'Run 2 right', zh: '运行 2 判对' })}</span>
        <span className="rc-axis">{t({ en: 'Run 2 wrong', zh: '运行 2 判错' })}</span>
        <span className="rc-axis rc-axis-row">{t({ en: 'Run 1 right', zh: '运行 1 判对' })}</span>
        {cells.slice(0, 2).map((cell) => (
          <MatrixCell
            key={cell}
            cell={cell}
            value={counts[cell]}
            total={total}
            active={active === cell}
            onPick={onPick}
          />
        ))}
        <span className="rc-axis rc-axis-row">{t({ en: 'Run 1 wrong', zh: '运行 1 判错' })}</span>
        {cells.slice(2).map((cell) => (
          <MatrixCell
            key={cell}
            cell={cell}
            value={counts[cell]}
            total={total}
            active={active === cell}
            onPick={onPick}
          />
        ))}
      </div>
      {counts.indeterminate > 0 && (
        <button
          type="button"
          className="rc-indeterminate"
          aria-pressed={active === 'indeterminate'}
          onClick={() => onPick('indeterminate')}
        >
          {pick(
            <>{formatCount(counts.indeterminate)} with no result recorded on one side</>,
            <>有 {formatCount(counts.indeterminate)} 条在某一边没有记录结果</>,
          )}
        </button>
      )}
    </div>
  )
}

function MatrixCell({
  cell,
  value,
  total,
  active,
  onPick,
}: {
  cell: Cell
  value: number
  total: number
  active: boolean
  onPick: (cell: CellFilter) => void
}) {
  const { t } = useSay()
  const tone =
    cell === 'both-right' ? 'ok' : cell === 'both-wrong' ? 'bad' : 'move'
  return (
    <button
      type="button"
      className={`rc-cell tone-${tone}`}
      aria-pressed={active}
      onClick={() => onPick(cell)}
    >
      <span className="rc-cell-n">{formatCount(value)}</span>
      <span className="rc-cell-pct">{formatPercent(value, total)}</span>
      <span className="rc-cell-label">{t(CELL_LABEL[cell])}</span>
    </button>
  )
}

function GroupDeltas({
  basis,
  benchmark,
  active,
  onPick,
}: {
  basis: Basis
  benchmark: Benchmark
  active: string | null
  onPick: (group: string | null) => void
}) {
  const { t, pick } = useSay()
  const groups: readonly GroupDelta[] = basis.groups
  const total = formatCount(basis.agreement.aligned)
  const widest = groups.reduce((max, one) => Math.max(max, Math.abs(one.delta)), 1)
  return (
    <div className="panel rc-deltas">
      <div className="panel-header">
        <span>{t({ en: 'Movement by group', zh: '按分组看变化' })}</span>
        <span className="spacer" />
        <span className="rc-axis">
          {t({ en: 'Run 2 − Run 1, points', zh: '运行 2 − 运行 1，百分点' })}
        </span>
      </div>
      <p className="rc-caption">
        {basis.kind === 'benchmark'
          ? pick(
              <>
                Over all {counted(basis.agreement.aligned, RECORD)} of {BENCHMARK_LABEL[benchmark]},
                from the same two complete outcome tables; n is how many of them fall in that group.
              </>,
              <>
                覆盖 {BENCHMARK_LABEL[benchmark]} 全部 {total}{' '}
                条记录，来自同样的两张完整结果表；n 是该分组在其中占多少条。
              </>,
            )
          : pick(
              <>
                Over the {counted(basis.agreement.aligned, RECORD)} the two loaded files share, not
                over {BENCHMARK_LABEL[benchmark]}; n is how many of them fall in that group.
              </>,
              <>
                只覆盖两个已载入文件共有的 {total} 条记录，不覆盖整个 {BENCHMARK_LABEL[benchmark]}；n
                是该分组在其中占多少条。
              </>,
            )}
      </p>
      <div className="panel-body">
        <table className="rc-delta-table">
          <thead>
            <tr>
              <th>{t({ en: 'group', zh: '分组' })}</th>
              <th className="rc-num">n</th>
              <th className="rc-num">{t(RUN_ONE)}</th>
              <th className="rc-num">{t(RUN_TWO)}</th>
              <th>Δ</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((one) => (
              <tr key={one.group} className={one.group === active ? 'is-active' : undefined}>
                <td>
                  <button
                    type="button"
                    className="rc-link"
                    aria-pressed={one.group === active}
                    onClick={() => onPick(one.group === active ? null : one.group)}
                  >
                    {one.group}
                  </button>
                </td>
                <td className="rc-num faint">{formatCount(one.aligned)}</td>
                <td className="rc-num">{formatPercent(one.oneRight, one.aligned)}</td>
                <td className="rc-num">{formatPercent(one.twoRight, one.aligned)}</td>
                <td>
                  <span className="rc-bar">
                    <span
                      className={`rc-bar-fill ${one.delta >= 0 ? 'up' : 'down'}`}
                      style={{ width: `${(50 * Math.abs(one.delta)) / widest}%` }}
                    />
                  </span>
                  <span className={`rc-delta ${one.delta >= 0 ? 'up' : 'down'}`}>
                    {formatPoints(one.delta)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** right / wrong / no result, for the two dots on a row. */
function outcomeWord(t: (str: Str) => string, correct: boolean | null): string {
  if (correct === null) return t({ en: 'no result', zh: '没有记录结果' })
  return correct ? t({ en: 'right', zh: '判对' }) : t({ en: 'wrong', zh: '判错' })
}

function Mark({ judgement }: { judgement: Judgement }) {
  const { t } = useSay()
  const label = outcomeWord(t, judgement.correct)
  const tone = judgement.correct === null ? 'unknown' : judgement.correct ? 'ok' : 'bad'
  return <span className={`rc-mark ${tone}`} title={label} aria-label={label} />
}

function PairDetail({
  pair,
  runOne,
  runTwo,
  onOpenRecord,
}: {
  pair: Pair
  runOne: Run
  runTwo: Run
  onOpenRecord?: (id: string) => void
}) {
  const { t } = useSay()
  return (
    <div className="rc-pair stack">
      <div className="rc-question-full">
        <div className="rc-sub">
          {pair.group}
          {pair.styleIndex !== undefined && ` · ${styleWord(t, pair.styleIndex)}`}
        </div>
        <p>{clip(questionOf(pair.one), 1200)}</p>
      </div>

      <details className="rc-responses">
        <summary>
          {t({ en: 'The pair both judges scored', zh: '两个运行评判的是同一对回答' })}
        </summary>
        <div className="rc-responses-grid">
          <Response
            label={t({ en: "chosen (dataset's better answer)", zh: '优选回答（数据集判为更好的一条）' })}
            messages={pair.one.chosen}
          />
          <Response label={t(REJECTED)} messages={pair.one.rejected} />
        </div>
      </details>

      <div className="rc-cors">
        <CorColumn title={RUN_ONE} run={runOne} judgement={pair.one} onOpenRecord={onOpenRecord} />
        <CorColumn title={RUN_TWO} run={runTwo} judgement={pair.two} onOpenRecord={onOpenRecord} />
      </div>
    </div>
  )
}

function Response({ label, messages }: { label: string; messages: readonly Message[] }) {
  const assistant = messages.filter((message) => message.role !== 'user')
  const shown = assistant.length > 0 ? assistant : messages
  return (
    <div className="rc-response">
      <div className="rc-sub">{label}</div>
      <pre className="rc-text">{shown.map((message) => message.content).join('\n\n')}</pre>
    </div>
  )
}

function CorColumn({
  title,
  run,
  judgement,
  onOpenRecord,
}: {
  title: Str
  run: Run
  judgement: Judgement
  onOpenRecord?: (id: string) => void
}) {
  const { t, pick } = useSay()
  const side = pickedSide(judgement)
  const cor: CorDocument = judgement.cor
  const sideWord =
    side === null ? t({ en: 'unparsed', zh: '未解析出' }) : t(side === 'chosen' ? CHOSEN : REJECTED)
  return (
    <div className="rc-cor">
      <div className="rc-cor-head">
        <strong>{t(title)}</strong>
        <span className="truncate faint rc-cor-file">{run.fileName}</span>
        <span className="spacer" />
        {onOpenRecord && (
          <button type="button" className="rc-link" onClick={() => onOpenRecord(judgement.id)}>
            {t({ en: 'open record', zh: '打开记录' })}
          </button>
        )}
      </div>
      <div className="cluster rc-badges">
        <span className={`badge ${judgement.correct === null ? '' : judgement.correct ? 'ok' : 'bad'}`}>
          {outcomeWord(t, judgement.correct)}
        </span>
        <span className="badge">
          {pick(<>picked {sideWord}</>, <>判给：{sideWord}</>)}
          {cor.verdict && ` · [[${cor.verdict}]]`}
        </span>
        {/* The half-sentence that keeps the letters honest on this screen. */}
        <span className="badge">
          {pick(
            <>chosen was slot {judgement.chosenShownAs}</>,
            <>优选回答在 {judgement.chosenShownAs} 位</>,
          )}
        </span>
        <span className="badge info">{cor.route}</span>
        {cor.ambiguous && (
          <span className="badge warn">
            {t({ en: 'both [[A]] and [[B]]', zh: '同时出现 [[A]] 和 [[B]]' })}
          </span>
        )}
        {cor.degraded && (
          <span className="badge warn">{t({ en: 'tags degraded', zh: '标签残缺' })}</span>
        )}
      </div>

      {cor.criteria.length > 0 && (
        <ol className="rc-criteria">
          {cor.criteria.map((one, index) => (
            <li key={index}>{one}</li>
          ))}
        </ol>
      )}

      {cor.justification && (
        <details>
          <summary>{t({ en: 'justification', zh: '判定理由' })}</summary>
          <pre className="rc-text">{cor.justification}</pre>
        </details>
      )}
      {cor.solution && (
        <details>
          <summary>{t({ en: 'reference solution', zh: '参考解答' })}</summary>
          <pre className="rc-text">{cor.solution}</pre>
        </details>
      )}
      {cor.evidence.length > 0 && (
        <details>
          <summary>
            {pick(
              <>
                {cor.evidence.length} marked span{cor.evidence.length === 1 ? '' : 's'}
              </>,
              <>{cor.evidence.length} 段引证片段</>,
            )}
          </summary>
          <ul className="rc-evidence">
            {cor.evidence.map((span, index) => (
              <li key={index}>
                <span className="badge">
                  {span.kind} {span.side} ·{' '}
                  {t(span.side === judgement.chosenShownAs ? CHOSEN : REJECTED)}
                </span>
                <span className="rc-span">{clip(span.text, 400)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="rc-sub">
        {cor.evaluation
          ? t({ en: 'evaluation', zh: '评估内容' })
          : t({ en: 'raw judge output', zh: '评判模型原始输出' })}
      </div>
      <pre className="rc-text rc-eval">{cor.evaluation ?? cor.raw}</pre>
    </div>
  )
}
