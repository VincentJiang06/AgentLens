/**
 * V1 — the judgement browser. This is what a `?record=` link opens, so it has to
 * answer "what did the judge actually say, and was it right" without a tour.
 *
 * Three things here are not obvious:
 *
 *   - the judge's prose says A and B; the reader is looking at chosen and
 *     rejected. `chosenShownAs` is the only bridge between the two, and it is
 *     stated in the header rather than silently applied, because half the
 *     dataset is shuffled and a reader who does not know that will read every
 *     other record backwards;
 *   - `<quote_A>`/`<summary_B>` spans are tied to their side by colour AND by a
 *     letter chip, never by colour alone, and the hover link is pure CSS `:has()`
 *     so that pointing at a span in a 5 KB evaluation costs no React render;
 *   - a degraded parse shows `cor.raw`, labelled. Blank would be a lie about the
 *     data; silently hiding the failure would be a lie about the parser;
 *   - the selection lives in the URL, not only in this component. Clicking a row
 *     replaces `?record=`, so the shell's "Copy link" hands over the judgement
 *     on screen rather than the one the page happened to open with. Only a
 *     `?record=` that came from outside scrolls the list;
 *   - a row is two lines, and the first of them is the question. What tells one
 *     judgement apart from the next while scanning 2,985 of them is what was
 *     asked, not its subset and not a right/wrong dot — those say which bucket a
 *     row is in, never which row it is. So the question gets the row's primary
 *     line and the bucket words move to a muted second one. Both lines are
 *     clamped to one line: a long question that reflowed would make every row a
 *     different height, which is what makes a long list unscannable and makes
 *     `ROW_HEIGHT` — and therefore the scrollbar — lie.
 *
 * The responses contain Markdown and there is no Markdown renderer in this
 * project. Fenced code is set apart and everything else keeps its whitespace —
 * that is the whole claim, and the pane says so.
 */

import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { selectRecord } from '../../shell/router'
import { VirtualList } from '../../shell/VirtualList'
import { corEvalSegments } from './cor'
import type { Benchmark, CorDocument, CorEvidence, Judgement, Message, RmR1Model } from './contract'
import { outcomesOfFile } from './model'
import './judgment.css'

/**
 * Matches `--jb-row-h` in judgment.css: 5 + 18 + 2 + 15 + 5 padding/lines/gap
 * plus the 1px rule under the row. Rows are measured once they render, but on
 * 2,985 of them the estimate is what the scrollbar is made of until the reader
 * has scrolled past every one — so it tracks the stylesheet exactly.
 */
const ROW_HEIGHT = 46

const BENCHMARK_LABELS: Record<Benchmark, string> = {
  rewardbench: 'RewardBench',
  'rm-bench': 'RM-Bench',
  'rmb-pairwise': 'RMB pairwise',
  'rmb-bon': 'RMB best-of-n',
}

/**
 * RM-Bench pairs each prompt in three response styles; the index is the style.
 * The log carries only the index — these words are AgentLens's, and they are the
 * same words the score dashboard's matrix axes use, so a reader moving between
 * the two panels meets one name per style in whichever language they are in.
 */
const STYLE_LABELS: Str[] = [
  { en: 'concise', zh: '简洁' },
  { en: 'detailed', zh: '详细' },
  { en: 'detailed + markdown', zh: '详细 + markdown' },
]

/**
 * The two sides. `chosen` and `rejected` are the dataset's field names, and the
 * Chinese reader still has to be able to find those fields in their own copy of
 * the log — so the words are translated where they are prose, and the field name
 * itself is printed once beside each response pane, where the tie is made.
 */
const CHOSEN: Str = { en: 'chosen', zh: '优选回答' }
const REJECTED: Str = { en: 'rejected', zh: '次选回答' }

type OutcomeFilter = 'all' | 'correct' | 'incorrect' | 'unrecorded'
type RouteFilter = 'all' | 'chat' | 'reasoning' | 'unknown'

/**
 * Where a judgement came from, as far as anything loaded can say.
 *
 * A percentage over a list that mixes two checkpoints belongs to neither of
 * them, and one that mixes RewardBench with RM-Bench belongs to no benchmark —
 * so this list has to be able to say which run and which benchmark it is
 * counting before it counts. A package names the run in the outcome table it
 * ships beside the sample; a dropped log names only itself, and then the file is
 * all the attribution there is and is labelled as a file rather than a run.
 */
interface Source {
  /** What the picker and the scope test compare on. */
  key: string
  /** The declared run id, or null when nothing loaded names one. */
  run: string | null
  /** The `<file>` part of the judgement ids that came from it. */
  file: string
}

/** `<file>:<index>` and `<file>:<index>:<style>` back to the file. */
function fileLabelOf(one: Judgement): string {
  const parts = one.id.split(':')
  const trailing = one.styleIndex === undefined ? 1 : 2
  return parts.length > trailing ? parts.slice(0, parts.length - trailing).join(':') : one.id
}

function sourceLabel(source: Source): string {
  return source.run ?? source.file
}

/**
 * Lowercased `cor.raw`, computed at most once per judgement. A full pass over
 * the released 32B log is ~15 MB of chain-of-rubrics text and measures ~6 ms, so
 * this is not what makes the search usable — it just keeps that cost on the
 * first keystroke instead of every one. Weak keys, so nothing outlives the model.
 */
const haystacks = new WeakMap<Judgement, string>()
function corHaystack(one: Judgement): string {
  let text = haystacks.get(one)
  if (text === undefined) {
    text = one.cor.raw.toLowerCase()
    haystacks.set(one, text)
  }
  return text
}

export const JudgmentBrowser: FC<{ model: RmR1Model; recordId?: string }> = ({
  model,
  recordId,
}) => {
  const t = useT()
  const [benchmark, setBenchmark] = useState<Benchmark | 'all'>('all')
  const [sourceKey, setSourceKey] = useState('all')
  const [group, setGroup] = useState('all')
  const [outcome, setOutcome] = useState<OutcomeFilter>('all')
  const [route, setRoute] = useState<RouteFilter>('all')
  const [search, setSearch] = useState('')

  // Typing stays responsive while the 2,985-row scan runs on the stale value.
  const deferredSearch = useDeferredValue(search)

  // `?record=` resolves against the whole model, not the filtered view: a link
  // that lands on a record the current filter hides must still open it.
  const linked = useMemo(
    () => findByRecordId(model.judgements, recordId),
    [model.judgements, recordId],
  )
  const linkMissed = recordId !== undefined && recordId !== '' && linked === null

  // The deep link is the initial selection, not an effect that corrects one.
  // Selecting after mount would paint the wrong judgement first and swap it a
  // frame later, which is exactly the frame a mailed link is judged on.
  const [selectedId, setSelectedId] = useState<string | null>(linked?.id ?? null)
  const [lastRecordId, setLastRecordId] = useState(recordId)
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId)
    setSelectedId(linked?.id ?? null)
  }

  // Ids this view put in the URL itself. A `?record=` that arrives from outside
  // is somebody's link and must scroll the list to its record; one written by
  // the click below is the row already under the reader's cursor, and scrolling
  // to it would yank the list out from under them.
  const selfSelected = useRef<string | null>(null)

  const benchmarks = useMemo(() => {
    if (model.benchmarks.length > 0) return model.benchmarks
    return [...new Set(model.judgements.map((one) => one.benchmark))]
  }, [model.benchmarks, model.judgements])

  const groups = useMemo(() => {
    const seen = new Set<string>()
    for (const one of model.judgements) {
      if (benchmark === 'all' || one.benchmark === benchmark) seen.add(one.group)
    }
    return [...seen].sort()
  }, [model.judgements, benchmark])

  // Resolved once per model rather than per row: `outcomesOfFile` walks the
  // outcome sets, and the list asks this question of every judgement it counts.
  const origin = useMemo(() => {
    const byId = new Map<string, string>()
    const sources = new Map<string, Source>()
    for (const one of model.judgements) {
      const file = fileLabelOf(one)
      const set = outcomesOfFile(model, file)
      const run = set !== undefined && set.run !== '' ? set.run : null
      const key = run ?? `file:${file}`
      byId.set(one.id, key)
      if (!sources.has(key)) sources.set(key, { key, run, file })
    }
    return { byId, sources: [...sources.values()] }
  }, [model])

  const filtered = useMemo(() => {
    const needle = deferredSearch.trim().toLowerCase()
    return model.judgements.filter(
      (one) =>
        (benchmark === 'all' || one.benchmark === benchmark) &&
        (sourceKey === 'all' || origin.byId.get(one.id) === sourceKey) &&
        (group === 'all' || one.group === group) &&
        matchesOutcome(outcome, one.correct) &&
        (route === 'all' || one.cor.route === route) &&
        (needle === '' || corHaystack(one).includes(needle)),
    )
  }, [model.judgements, origin, benchmark, sourceKey, group, outcome, route, deferredSearch])

  const tally = useMemo(() => {
    let correct = 0
    let recorded = 0
    for (const one of filtered) {
      if (one.correct === null) continue
      recorded += 1
      if (one.correct) correct += 1
    }
    return { correct, recorded }
  }, [filtered])

  // What the accuracy below would be an accuracy *of*. One run and one benchmark
  // or nothing: 40 records of one checkpoint plus 40 of another give a figure
  // that is neither's, and RewardBench records plus RM-Bench records give one
  // that is no benchmark's.
  const scope = useMemo(() => {
    const keys = new Set<string>()
    const benchmarks = new Set<Benchmark>()
    for (const one of filtered) {
      keys.add(origin.byId.get(one.id) ?? '')
      benchmarks.add(one.benchmark)
    }
    const only = keys.size === 1 ? origin.sources.find((one) => one.key === [...keys][0]) : undefined
    return { sources: keys.size, benchmarks: [...benchmarks], source: only }
  }, [filtered, origin])

  const attributed =
    tally.recorded > 0 && scope.sources === 1 && scope.benchmarks.length === 1 && scope.source !== undefined

  const selected =
    model.judgements.find((one) => one.id === selectedId) ?? filtered[0] ?? model.judgements[0]
  const selectedIndex = selected ? filtered.findIndex((one) => one.id === selected.id) : -1
  const hiddenByFilter = selected != null && selectedIndex < 0

  // Only a deep link from outside drives scrolling.
  const scrollTo =
    linked && linked.id !== selfSelected.current
      ? filtered.findIndex((one) => one.id === linked.id)
      : -1

  return (
    <section className="jb">
      <div className="jb-left stack">
        <div className="jb-filters cluster">
          <label className="jb-field">
            <span className="sr-only">{t({ en: 'Benchmark', zh: '基准' })}</span>
            <select
              value={benchmark}
              onChange={(event) => {
                setBenchmark(event.target.value as Benchmark | 'all')
                setGroup('all')
              }}
            >
              <option value="all">{t({ en: 'All benchmarks', zh: '全部基准' })}</option>
              {benchmarks.map((one) => (
                <option key={one} value={one}>
                  {BENCHMARK_LABELS[one]}
                </option>
              ))}
            </select>
          </label>

          {/* Only when there is a choice to make. With one run loaded the list
              is already that run's, and a picker with one option is furniture
              that says nothing. */}
          {origin.sources.length > 1 && (
            <label className="jb-field">
              <span className="sr-only">{t({ en: 'Run or file', zh: '运行或文件' })}</span>
              <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)}>
                <option value="all">
                  {t({
                    en: `All ${origin.sources.length} sources`,
                    zh: `全部 ${origin.sources.length} 个来源`,
                  })}
                </option>
                {origin.sources.map((one) => (
                  <option key={one.key} value={one.key}>
                    {sourceLabel(one)}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="jb-field">
            <span className="sr-only">{t({ en: 'Subset or domain', zh: '子集或领域' })}</span>
            <select value={group} onChange={(event) => setGroup(event.target.value)}>
              <option value="all">
                {t({ en: `All groups (${groups.length})`, zh: `全部分组（${groups.length}）` })}
              </option>
              {groups.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          </label>

          <label className="jb-field">
            <span className="sr-only">{t({ en: 'Outcome', zh: '是否判对' })}</span>
            <select
              value={outcome}
              onChange={(event) => setOutcome(event.target.value as OutcomeFilter)}
            >
              <option value="all">{t({ en: 'Correct + incorrect', zh: '正确 + 错误' })}</option>
              <option value="correct">{t({ en: 'Correct only', zh: '仅正确' })}</option>
              <option value="incorrect">{t({ en: 'Incorrect only', zh: '仅错误' })}</option>
              <option value="unrecorded">{t({ en: 'Outcome not recorded', zh: '结果未记录' })}</option>
            </select>
          </label>

          <label className="jb-field">
            <span className="sr-only">{t({ en: 'Rubric route', zh: '评分细则路线' })}</span>
            <select value={route} onChange={(event) => setRoute(event.target.value as RouteFilter)}>
              <option value="all">{t({ en: 'Both routes', zh: '两条路线' })}</option>
              <option value="chat">{t({ en: 'Chat route', zh: 'chat 路线' })}</option>
              <option value="reasoning">{t({ en: 'Reasoning route', zh: 'reasoning 路线' })}</option>
              <option value="unknown">{t({ en: 'Route not stated', zh: '未标出路线' })}</option>
            </select>
          </label>

          <label className="jb-field jb-search">
            <span className="sr-only">
              {t({ en: 'Search the chain-of-rubrics text', zh: '搜索 Chain-of-Rubrics 全文' })}
            </span>
            <input
              type="search"
              value={search}
              placeholder={t({ en: "Search the judge's text…", zh: '搜索评审模型写下的内容…' })}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        {/* Whole phrases, not words glued to numbers: "N of M" and "N/M correct
            (P%)" have no word order in common with their Chinese, and the
            brackets around a percentage are full-width in one language only.

            The accuracy is shown only when the list it is over belongs to one
            run and one benchmark. Otherwise the sentence that would have to
            accompany it — "this belongs to neither checkpoint" — is shown
            instead of the number, and the picker above is how a reader gets the
            number back. */}
        <div className="jb-counts">
          <span>
            {t({
              en: `${filtered.length.toLocaleString()} of ${model.judgements.length.toLocaleString()}`,
              zh: `共 ${model.judgements.length.toLocaleString()} 条，显示 ${filtered.length.toLocaleString()} 条`,
            })}
          </span>
          {attributed && (
            <span>
              {t({
                en: `· ${tally.correct.toLocaleString()}/${tally.recorded.toLocaleString()} correct (${percent(tally.correct, tally.recorded)}%)`,
                zh: `· ${tally.correct.toLocaleString()}/${tally.recorded.toLocaleString()} 正确（${percent(tally.correct, tally.recorded)}%）`,
              })}
            </span>
          )}
          {filtered.length - tally.recorded > 0 && (
            <span>
              {t({
                en: `· ${(filtered.length - tally.recorded).toLocaleString()} not recorded`,
                zh: `· ${(filtered.length - tally.recorded).toLocaleString()} 条未记录结果`,
              })}
            </span>
          )}
        </div>

        {tally.recorded > 0 && (
          <p className="jb-scope faint">
            {attributed && scope.source
              ? t({
                  en:
                    `Over the ${tally.recorded.toLocaleString()} ${BENCHMARK_LABELS[scope.benchmarks[0]]} judgements ` +
                    `loaded here from ${sourceLabel(scope.source)} — this list's own accuracy, not ` +
                    `${BENCHMARK_LABELS[scope.benchmarks[0]]}'s score for it.`,
                  zh:
                    `这是此处载入的 ${tally.recorded.toLocaleString()} 条 ${BENCHMARK_LABELS[scope.benchmarks[0]]} ` +
                    `判例自身的准确率，来自 ${sourceLabel(scope.source)}；不是 ` +
                    `${BENCHMARK_LABELS[scope.benchmarks[0]]} 给它的分数。`,
                })
              : t(mixedScope(filtered.length, scope.sources, scope.benchmarks.length))}
          </p>
        )}

        {linkMissed && (
          <p className="notice warn">
            {t({ en: `no record “${recordId}” here`, zh: `这里没有“${recordId}”这条记录` })}
          </p>
        )}

        {/* The rail's two colours are named here and again in every row's
            `sr-only` word, so the outcome is never carried by hue alone. The
            second entry says how to read the row's muted line, which is the
            only part of a row whose order is not self-evident. */}
        <p className="jb-legend faint">
          <span>
            <span className="jb-rail ok" aria-hidden="true" /> {t({ en: 'correct', zh: '正确' })}
          </span>
          <span>
            <span className="jb-rail bad" aria-hidden="true" /> {t({ en: 'incorrect', zh: '错误' })}
          </span>
          {/* The two swatches above are the colour key and stay at every width.
              This one only says how to read a row, which the rows themselves
              make obvious after the first glance — so it is the part that goes
              when the pane is too narrow to spend three lines on a legend. */}
          <span className="jb-legend-hint">
            {t({
              en: 'each row: the question, then where it is from and what the judge answered',
              zh: '每行两行：上面是问题，下面是它的出处和评审模型的判定',
            })}
          </span>
        </p>

        <div className="jb-list">
          <VirtualList
            items={filtered}
            estimateSize={ROW_HEIGHT}
            scrollToIndex={scrollTo >= 0 ? scrollTo : undefined}
            getKey={(one) => one.id}
            label={t({ en: 'RM-R1 judgements', zh: 'RM-R1 判例' })}
            empty={
              <span className="muted">
                {t({ en: 'No judgement matches these filters.', zh: '没有判例符合当前筛选。' })}
              </span>
            }
            renderRow={(one) => (
              <button
                type="button"
                className="list-row jb-row"
                aria-current={one.id === selected?.id || undefined}
                onClick={() => {
                  // The URL is the selection, so "Copy link" copies the
                  // judgement on screen rather than the one the page opened
                  // with. It replaces rather than pushes: Back leaves the demo
                  // instead of stepping through every row that was clicked.
                  selfSelected.current = one.id
                  setSelectedId(one.id)
                  selectRecord(one.id)
                }}
              >
                {/* A rail rather than a dot: it spans both lines, so the
                    correct/incorrect scan still runs down the column edge
                    without competing with the question for the row's width. */}
                <span className={`jb-rail ${outcomeClass(one.correct)}`} aria-hidden="true" />
                <span className="sr-only">{t(outcomeWord(one.correct))},</span>
                <span className="jb-row-lines">
                  <span className="jb-row-q truncate">{snippetOf(one)}</span>
                  <span className="jb-row-meta truncate">{metaOf(one, t)}</span>
                </span>
              </button>
            )}
          />
        </div>
      </div>

      {selected ? (
        <Detail judgement={selected} hiddenByFilter={hiddenByFilter} />
      ) : (
        <div className="jb-main panel">
          <div className="panel-body jb-blank muted">
            {t({
              en: 'No judgements in this data. The raw record browser will show what was loaded.',
              zh: '这批数据里没有判例。原始记录浏览器会显示实际载入的内容。',
            })}
          </div>
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------- detail */

const Detail: FC<{ judgement: Judgement; hiddenByFilter: boolean }> = ({
  judgement,
  hiddenByFilter,
}) => {
  const t = useT()
  const { cor } = judgement
  const rejectedShownAs = judgement.chosenShownAs === 'A' ? 'B' : 'A'
  const picked = cor.verdict === judgement.chosenShownAs ? CHOSEN : REJECTED

  // RewardBench logs carry no prompt, but both conversations open on the same
  // user turn — that turn IS the prompt, so it is shown once instead of twice.
  const sharedPrompt = judgement.prompt ?? sharedOpening(judgement.chosen, judgement.rejected)
  const promptSource = judgement.prompt
    ? { en: 'from the log', zh: '来自日志' }
    : { en: 'the shared user turn', zh: '两侧共用的用户轮次' }
  const chosenBody = judgement.prompt ? judgement.chosen : withoutOpening(judgement.chosen)
  const rejectedBody = judgement.prompt ? judgement.rejected : withoutOpening(judgement.rejected)

  return (
    <div className="jb-main panel">
      <header className="jb-head">
        <div className="cluster">
          <span className={`badge ${outcomeClass(judgement.correct)}`}>
            {t(outcomeWord(judgement.correct))}
          </span>
          <span className="jb-verdict">
            {cor.verdict === null ? (
              <>
                {t({ en: 'The output carries no ', zh: '这份输出没有 ' })}
                <code>&lt;answer&gt;</code>
                {t({ en: ' verdict.', zh: ' 判定。' })}
              </>
            ) : (
              <>
                {t({ en: 'Judge answered', zh: '评审模型选的是' })}{' '}
                <b className="mono">[[{cor.verdict}]]</b>
                {t({ en: ' — the ', zh: '——也就是' })}
                <b>{t(picked)}</b>
                {t({ en: ' response.', zh: '那一侧。' })}
              </>
            )}
          </span>
          {cor.ambiguous && (
            <span
              className="badge warn"
              title={t({
                en: "RM-R1's reward function scores a double verdict as a failure.",
                zh: 'RM-R1 自己的奖励函数把双重判定记为失败。',
              })}
            >
              {t({ en: '[[A]] and [[B]] both present', zh: '[[A]] 与 [[B]] 同时出现' })}
            </span>
          )}
          {/* Names what happened to the tags, not what is wrong with anybody's
              log: the judge's own output is sometimes written without them. */}
          {cor.degraded && (
            <span className="badge bad">{t({ en: 'CoR unparsed', zh: '未解析出 CoR 结构' })}</span>
          )}
        </div>

        <p className="jb-slots">
          {t({
            en: 'Positions were shuffled per record: the chosen answer was shown to the judge as',
            zh: '每条记录的 A/B 位都单独打乱过：数据集标注的优选回答，在评审模型眼里是',
          })}{' '}
          <b className="mono">{judgement.chosenShownAs}</b>
          {t({ en: ', the rejected one as ', zh: ' 位，次选回答是 ' })}
          <b className="mono">{rejectedShownAs}</b>
          {t({ en: '.', zh: ' 位。' })}
        </p>

        <div className="jb-meta faint">
          <span>{BENCHMARK_LABELS[judgement.benchmark]}</span>
          <span>· {judgement.group}</span>
          <span>
            · {judgement.cor.route} {t({ en: 'route', zh: '路线' })}
          </span>
          {judgement.styleIndex !== undefined && (
            <span>
              {t({
                en: `· style ${judgement.styleIndex}: `,
                zh: `· 风格 ${judgement.styleIndex}：`,
              })}
              {t(STYLE_LABELS[judgement.styleIndex] ?? { en: '?', zh: '?' })}
            </span>
          )}
          <span className="mono">· {judgement.id}</span>
          {hiddenByFilter && (
            <span className="badge warn">
              {t({ en: 'outside the current filter', zh: '不在当前筛选范围内' })}
            </span>
          )}
        </div>
      </header>

      <div className="panel-body jb-body">
        {sharedPrompt && (
          <section className="jb-block">
            <h4 className="jb-block-title">
              {t({ en: 'Prompt', zh: '提问' })} <span className="faint">· {t(promptSource)}</span>
            </h4>
            <Rich text={sharedPrompt} className="jb-prompt" />
          </section>
        )}

        <section className="jb-block">
          <h4 className="jb-block-title">
            {t({ en: 'Responses', zh: '两份回答' })}{' '}
            <span className="faint">
              ·{' '}
              {t({
                en: 'shown as written; only fenced code is set apart',
                zh: '原样呈现；只把围栏代码块单独排版',
              })}
            </span>
          </h4>
          {/* Chosen is always on the left, whichever slot it occupied. The letter
              chips carry the judge's ordering; swapping the columns per record
              would move the reader's own frame of reference every time they page
              to the next judgement. */}
          <div className="jb-panes">
            <Pane slot={judgement.chosenShownAs} field="chosen" messages={chosenBody} />
            <Pane slot={rejectedShownAs} field="rejected" messages={rejectedBody} />
          </div>
        </section>

        {cor.degraded ? (
          <section className="jb-block">
            <h4 className="jb-block-title">
              {t({ en: 'Chain of rubrics', zh: 'Chain of Rubrics' })}{' '}
              <span className="faint">
                ·{' '}
                {t({
                  en: 'tags missing or unbalanced, shown raw',
                  zh: '标签缺失或不成对，原文照录',
                })}
              </span>
            </h4>
            <pre className="jb-raw">{cor.raw}</pre>
          </section>
        ) : (
          <>
            {cor.criteria.length > 0 && (
              <section className="jb-block">
                <h4 className="jb-block-title">
                  {t({ en: 'Rubric', zh: '评分细则' })}{' '}
                  <span className="faint">
                    ·{' '}
                    {t({
                      en: `${cor.criteria.length} criteria`,
                      zh: `${cor.criteria.length} 条`,
                    })}
                  </span>
                </h4>
                <ol className="jb-criteria">
                  {cor.criteria.map((line, index) => (
                    <Criterion key={index} line={line} />
                  ))}
                </ol>
                {cor.justification && (
                  <details className="jb-details">
                    <summary>{t({ en: 'Why these criteria', zh: '为什么是这几条' })}</summary>
                    <Rich text={cor.justification} className="jb-justify" />
                  </details>
                )}
              </section>
            )}

            {cor.solution && (
              <section className="jb-block">
                <h4 className="jb-block-title">
                  {t({ en: 'Reference solution', zh: '参考解答' })}{' '}
                  <span className="faint">
                    ·{' '}
                    {t({
                      en: 'the judge worked this out before reading either answer',
                      zh: '评审模型在读两份回答之前，先自己做了一遍',
                    })}
                  </span>
                </h4>
                <Rich text={cor.solution} className="jb-solution" />
              </section>
            )}

            {cor.evaluation ? (
              <section className="jb-block">
                <h4 className="jb-block-title">
                  {t({ en: 'Evaluation', zh: '评述' })}{' '}
                  <span className="faint">
                    ·{' '}
                    {t({
                      en: 'quoted and summarised spans are tied to their side',
                      zh: '每段引证片段都标出它指向哪一侧',
                    })}
                  </span>
                </h4>
                <Evaluation cor={cor} />
              </section>
            ) : (
              <p className="notice">
                {t({ en: 'This output has no ', zh: '这份输出没有 ' })}
                <code>&lt;eval&gt;</code>
                {t({ en: ' section.', zh: ' 段。' })}
              </p>
            )}

            <details className="jb-details">
              <summary>
                {t({
                  en: `Raw model output (${cor.raw.length.toLocaleString()} characters)`,
                  zh: `模型原始输出（${cor.raw.length.toLocaleString()} 字符）`,
                })}
              </summary>
              <pre className="jb-raw">{cor.raw}</pre>
            </details>
          </>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- parts */

/**
 * One side's conversation. `data-slot` is what the hover tie in CSS keys on.
 *
 * This header is the one place the translated name of a side is tied back to the
 * field it came from, so a reader working in Chinese can still go and find
 * `chosen` in their own log.
 */
const Pane: FC<{ slot: 'A' | 'B'; field: 'chosen' | 'rejected'; messages: Message[] }> = ({
  slot,
  field,
  messages,
}) => {
  const t = useT()
  return (
  <article className="jb-resp" data-slot={slot}>
    <header className="jb-resp-head">
      <span className="jb-chip" data-slot={slot}>
        {slot}
      </span>
      <b>{t(field === 'chosen' ? CHOSEN : REJECTED)}</b>
      <span className="faint">
        · {t({ en: "the dataset's label", zh: `数据集里的 ${field}` })}
      </span>
    </header>
    <div className="jb-resp-body">
      {messages.length === 0 ? (
        <p className="muted">
          {t({
            en: 'This side carried no message beyond the prompt.',
            zh: '除了提问，这一侧没有别的内容。',
          })}
        </p>
      ) : (
        messages.map((message, index) => (
          <div key={index} className="jb-msg">
            {messages.length > 1 && <span className="jb-msg-role faint">{message.role}</span>}
            <Rich text={message.content} />
          </div>
        ))
      )}
    </div>
  </article>
  )
}

/**
 * A rubric line. ~90% of them carry a `(40%)` weight and the rest carry none, so
 * the bar is drawn only when the judge actually wrote a number.
 */
const Criterion: FC<{ line: string }> = ({ line }) => {
  const weight = /\(\s*(\d{1,3})\s*%\s*\)/.exec(line)
  const percent = weight ? Number(weight[1]) : null
  const text = line.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '')
  return (
    <li className="jb-criterion">
      <span className="jb-weight">
        {percent === null ? <span className="faint">—</span> : `${percent}%`}
        {percent !== null && (
          <span className="jb-weight-bar" style={{ width: `${Math.min(percent, 100)}%` }} />
        )}
      </span>
      <span className="jb-criterion-text">{text}</span>
    </li>
  )
}

/**
 * The evaluation prose with each attributed span marked.
 *
 * `cor.evaluation` has the tags stripped, so the segmentation comes from
 * `corEvalSegments`, which re-scans `raw` with the same lenient scanner the
 * parse used. Anything in `cor.evidence` the segmenter did not place is listed
 * afterwards rather than dropped: 14 of the 2,985 released records nest a
 * `<quote_B>` inside a `<summary_B>`, and the inner one has no place of its own
 * in the prose. Counted, not de-duplicated — the same sentence can be quoted
 * twice, and a Set would report the second copy as missing.
 */
const Evaluation: FC<{ cor: CorDocument }> = ({ cor }) => {
  const t = useT()
  const segments = useMemo(() => corEvalSegments(cor), [cor])
  const unplaced = useMemo(() => {
    const placed = new Map<string, number>()
    for (const segment of segments) {
      if (segment.kind !== 'evidence') continue
      placed.set(segment.evidence.text, (placed.get(segment.evidence.text) ?? 0) + 1)
    }
    return cor.evidence.filter((one) => {
      const left = placed.get(one.text) ?? 0
      if (left === 0) return true
      placed.set(one.text, left - 1)
      return false
    })
  }, [segments, cor.evidence])

  // Only if the segmenter found nothing at all — the prose is still owed to the
  // reader even when its spans could not be located in it.
  if (segments.length === 0) return <div className="jb-eval">{cor.evaluation}</div>

  return (
    <>
      <div className="jb-eval">
        {segments.map((segment, index) =>
          segment.kind === 'evidence' ? (
            <Span key={index} evidence={segment.evidence} />
          ) : (
            <span key={index}>{segment.text}</span>
          ),
        )}
      </div>
      {unplaced.length > 0 && (
        <div className="jb-unplaced">
          <p className="faint">
            {t({
              en:
                `${unplaced.length} attributed span${unplaced.length === 1 ? '' : 's'} with no place of` +
                `${unplaced.length === 1 ? ' its' : ' their'} own in the prose above — nested inside ` +
                'another span, or written outside ',
              zh: `另有 ${unplaced.length} 段引证片段在上面的正文里找不到落点——它们嵌在别的片段内部，或者写在了 `,
            })}
            <code>&lt;eval&gt;</code>
            {t({ en: ':', zh: ' 之外：' })}
          </p>
          {unplaced.map((one, index) => (
            <Span key={index} evidence={one} />
          ))}
        </div>
      )}
    </>
  )
}

/** Colour AND letter: the side is never carried by hue alone. */
const Span: FC<{ evidence: CorEvidence }> = ({ evidence }) => (
  <mark className="jb-span" data-side={evidence.side} data-kind={evidence.kind}>
    <span className="jb-chip" data-slot={evidence.side}>
      {evidence.side}
    </span>
    <span className="jb-span-kind faint">{evidence.kind}</span>
    {evidence.text}
  </mark>
)

/**
 * Whitespace-preserving text with fenced code lifted out. This is not a Markdown
 * renderer and does not pretend to be one: headings, lists and emphasis stay as
 * the model wrote them.
 */
const Rich: FC<{ text: string; className?: string }> = ({ text, className }) => {
  const blocks = useMemo(() => splitFences(text), [text])
  return (
    <div className={['jb-rich', className].filter(Boolean).join(' ')}>
      {blocks.map((block, index) =>
        block.code ? (
          <pre key={index} className="jb-code">
            <code>{block.text}</code>
          </pre>
        ) : (
          <p key={index} className="jb-para">
            {block.text}
          </p>
        ),
      )}
    </div>
  )
}

/* ------------------------------------------------------------------- pure-ish */

/** An unterminated fence runs to the end of the message, which is what the model meant. */
const FENCE = /```[^\n]*\n?([\s\S]*?)(?:```|$)/g

function splitFences(text: string): { code: boolean; text: string }[] {
  const blocks: { code: boolean; text: string }[] = []
  let cursor = 0
  for (const match of text.matchAll(FENCE)) {
    const at = match.index
    if (at > cursor) blocks.push({ code: false, text: text.slice(cursor, at) })
    blocks.push({ code: true, text: match[1] })
    cursor = at + match[0].length
  }
  if (cursor < text.length) blocks.push({ code: false, text: text.slice(cursor) })
  return blocks.filter((block) => block.text.trim() !== '')
}

/**
 * Why no percentage is shown, naming only what is actually mixed.
 *
 * Two checkpoints in one list and three benchmarks in one list are two different
 * objections, and a sentence that recites both when only one applies reads as
 * boilerplate — which is how a reader learns to stop reading the caveat.
 */
function mixedScope(shown: number, sources: number, benchmarks: number): Str {
  const n = shown.toLocaleString()
  if (sources > 1 && benchmarks > 1) {
    return {
      en: `These ${n} judgements come from ${sources} sources and ${benchmarks} benchmarks, so an accuracy over them would be no run's and no benchmark's. Pick one of each above to see one.`,
      zh: `这 ${n} 条判例来自 ${sources} 个来源、${benchmarks} 个基准，在它们之上算出的准确率既不属于任何一次运行，也不属于任何一个基准。在上面各选一个，就能看到它。`,
    }
  }
  if (sources > 1) {
    return {
      en: `These ${n} judgements come from ${sources} sources, so an accuracy over them would belong to none of them. Pick one source above to see its own.`,
      zh: `这 ${n} 条判例来自 ${sources} 个来源，在它们之上算出的准确率不属于其中任何一个。在上面选定一个来源，就能看到它自己的。`,
    }
  }
  return {
    en: `These ${n} judgements span ${benchmarks} benchmarks, so an accuracy over them would be no benchmark's. Pick one benchmark above to see its own.`,
    zh: `这 ${n} 条判例跨了 ${benchmarks} 个基准，在它们之上算出的准确率不属于其中任何一个。在上面选定一个基准，就能看到它自己的。`,
  }
}

function percent(part: number, whole: number): string {
  return ((part / whole) * 100).toFixed(1)
}

function matchesOutcome(filter: OutcomeFilter, correct: boolean | null): boolean {
  if (filter === 'all') return true
  if (filter === 'unrecorded') return correct === null
  return correct === (filter === 'correct')
}

function outcomeClass(correct: boolean | null): string {
  return correct === null ? '' : correct ? 'ok' : 'bad'
}

function outcomeWord(correct: boolean | null): Str {
  return correct === null
    ? { en: 'outcome not recorded', zh: '结果未记录' }
    : correct
      ? { en: 'correct', zh: '正确' }
      : { en: 'incorrect', zh: '错误' }
}

/**
 * Three forms, because all three get typed by hand into an email: the minted
 * `<file>:<index>` id; an RM-Bench `<file>:<index>`, which names three
 * judgements and lands on style 0; and a bare index, but only when one file is
 * loaded and it therefore names exactly one record.
 *
 * These are the same three `model.judgementIndexFor` resolves, refusal for
 * refusal — a link that works in one of them and not the other would be worse
 * than a link that never worked. Two callers, one rule; if this drifts from
 * that function, the shell and this view disagree about what a link means.
 */
function findByRecordId(judgements: Judgement[], recordId: string | undefined): Judgement | null {
  if (recordId === undefined || recordId === '') return null

  const exact = judgements.find((one) => one.id === recordId)
  if (exact) return exact

  // Guarded on the shape: without it a bare `logs.json` would "find"
  // `logs.json:0`, and a truncated link that quietly opens record 0 is worse
  // than one that misses.
  const parts = recordId.split(':')
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    const style0 = judgements.find((one) => one.id === `${recordId}:0`)
    if (style0) return style0
  }

  // A bare index with two files loaded names two different records; guessing
  // between them is the one outcome worse than reporting the miss.
  if (!/^\d+$/.test(recordId)) return null
  const files = new Set(judgements.map((one) => one.id.slice(0, one.id.indexOf(':'))))
  if (files.size !== 1) return null
  const only = [...files][0]
  return (
    judgements.find((one) => one.id === `${only}:${recordId}` || one.id === `${only}:${recordId}:0`) ??
    null
  )
}

/** The opening user turn when both sides share it verbatim; otherwise nothing. */
function sharedOpening(chosen: Message[], rejected: Message[]): string | undefined {
  const first = chosen[0]
  if (!first || first.role !== 'user') return undefined
  if (rejected[0]?.content !== first.content) return undefined
  return first.content
}

function withoutOpening(messages: Message[]): Message[] {
  return messages[0]?.role === 'user' ? messages.slice(1) : messages
}

function snippetOf(one: Judgement): string {
  const source =
    one.prompt ??
    one.chosen.find((message) => message.role === 'user')?.content ??
    one.cor.criteria[0] ??
    one.cor.raw
  return source.replace(/\s+/g, ' ').slice(0, 160)
}

/**
 * The row's second line, ordered by what may be lost off its right edge.
 *
 * Both lines are clamped to one line — a wrapped second line would break the
 * uniform 46px row the virtual list estimates the scrollbar from — so at a
 * narrow width the tail ellipsises rather than reflowing. The widest line
 * RM-Bench can produce is 316px in English against a 308px box at 375px (the
 * Chinese fits at 308), so something is going to go, and the order decides what.
 *
 * The order is therefore: the log's own tokens first, AgentLens's gloss last.
 * The subset leads because it is what the group filter above is set to. The
 * style index follows it, because on RM-Bench three rows share a question and
 * the index is the only thing that tells them apart. The route comes next, and
 * the verdict last: `[[B]]` is the letter the judge wrote and survives, and what
 * ellipsises is the word this file adds to it — "rejected" / 「次选回答」 — which
 * the detail pane restates in full one click away. Nothing a log wrote is ever
 * the thing that gets cut.
 *
 * The verdict is written as the letter AND the side it turned out to be because
 * the mapping is shuffled per record: `[[A]]` alone would be unreadable, and
 * `chosen` alone would hide the position the reader is about to see.
 *
 * Benchmark is deliberately absent: it is one of the filters, it is in the
 * detail header, and on every package so far it is implied by the subset.
 */
function metaOf(one: Judgement, t: (str: Str) => string): string {
  const parts: string[] = [one.group]
  if (one.styleIndex !== undefined) {
    parts.push(t({ en: `style ${one.styleIndex}`, zh: `风格 ${one.styleIndex}` }))
  }
  // "route" is spelled out because RM-Bench's domains are `chat`, `math`,
  // `code`, `safety-*` and its routes are `chat` and `reasoning`: without the
  // word, half those rows read "chat · chat" and look like a rendering fault.
  if (one.cor.route !== 'unknown') {
    parts.push(t({ en: `${one.cor.route} route`, zh: `${one.cor.route} 路线` }))
  }
  parts.push(
    one.cor.verdict === null
      ? t({ en: 'no verdict', zh: '无判定' })
      : `[[${one.cor.verdict}]] → ${t(one.cor.verdict === one.chosenShownAs ? CHOSEN : REJECTED)}`,
  )
  return parts.join(' · ')
}
