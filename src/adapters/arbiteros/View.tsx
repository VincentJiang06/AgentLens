/**
 * The ArbiterOS adapter's one view: a tab strip over the three real views, and
 * the four things none of them owns.
 *
 *   - Which tab is showing. Cases by default. A `?record=` that names an
 *     instruction (`<caseId>:<stepIndex>`) lands on the propagation graph
 *     instead, because that link points at one instruction inside one case and
 *     the graph is the only view that can show it; a link that names a case
 *     lands on the list, where the case is a row.
 *   - Whether the link arrived anywhere. `TaintGraph` opens on instruction 1
 *     when the index is out of range and `CaseBrowser` simply holds no
 *     selection, both correctly — neither knows what the link said. This file
 *     does, so it is where a miss is reported, in the same words `RecordBrowser`
 *     and the preview adapter use. A dead outreach link that looks fine is worse
 *     than one that says it missed.
 *   - `model.notes`. Nothing else renders them, and they are where the model
 *     says what the numbers cannot: that `flagged` and `intercepted` are a pair,
 *     what the replay cost, how many inherited labels the recorded lineage
 *     cannot explain. The first notes are on screen unopened, on every tab, and
 *     the block opens itself on Policies, where the numbers they qualify are.
 *   - The hand-off between the list and the graph, which goes through the URL
 *     like every other selection in this app, so the link the reader copies is
 *     always what is on screen. One adapter, one place that writes `?record=`:
 *     the two views below take a value and a callback and never touch the router.
 *
 * Each tab's view owns its own scrolling, so this file gives them a bounded box
 * and stays out of it.
 */

import { useMemo, useState } from 'react'
import type { FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { selectRecord } from '../../shell/router'
import { CaseBrowser, interceptedBy } from './CaseBrowser'
import { hasRefusal } from './model'
import { PolicyPanel } from './PolicyPanel'
import { TaintGraph } from './TaintGraph'
import type { ArbiterosModel, Trace } from './contract'
import { isTaintedTrace, locate, parseRecordId, stepRecordId, traceRecordId } from './model'
import './view.css'

type TabId = 'cases' | 'graph' | 'policies'

interface Tab {
  id: TabId
  label: Str
  /** What is behind the tab, in cases or instructions. Never a claim, just counts. */
  hint: Str
}

/** How many notes are shown before the reader asks for the rest. */
const NOTES_SHOWN_COLLAPSED = 2

export const View: FC<{ model: ArbiterosModel; recordId?: string }> = ({ model, recordId }) => {
  const t = useT()

  // What the link points at: the case, and the instruction inside it when the
  // link named one. `stepIndex` is -1 for "named none" and for "named one this
  // case does not have" alike, so `named` below is what tells those apart.
  const found = useMemo(() => locate(model, recordId), [model, recordId])
  const named = useMemo(
    () => (recordId === undefined || recordId === '' ? undefined : parseRecordId(recordId)),
    [recordId],
  )
  const namesStep = named?.stepIndex !== undefined
  const hasCase = found.traceIndex >= 0

  // The graph needs a case. A link that names one decides it; otherwise the view
  // opens on the first case that has an inherited label to show, and says so
  // with the denominator — see `pickedForGraph`.
  const fallbackTrace = useMemo(() => pickForGraph(model.traces), [model.traces])
  const graphTrace = found.trace ?? fallbackTrace
  const graphIsFallback = found.trace === undefined && graphTrace !== undefined

  // A link that names an instruction is a link to the graph, provided the case
  // it names is here. Everything else opens the list, which is where both the
  // 105 rows and the report of a link that missed are.
  const initial: TabId = namesStep && hasCase ? 'graph' : 'cases'
  const [tab, setTab] = useState<TabId>(initial)

  // The reader's tab choice survives everything except a new `?record=`, which
  // is somebody else's link arriving and has to be obeyed. Adjusted during
  // render rather than in an effect: an effect paints the old tab for one frame
  // first, and that frame is the whole first impression of a mailed link.
  const [lastRecordId, setLastRecordId] = useState(recordId)
  if (recordId !== lastRecordId) {
    setLastRecordId(recordId)
    if (namesStep && hasCase) setTab('graph')
    else if (recordId !== undefined && recordId !== '' && !namesStep) setTab('cases')
  }

  const cases = model.counts.cases.toLocaleString()
  const steps = model.counts.steps.toLocaleString()
  const intercepted = model.counts.intercepted.toLocaleString()
  const withTaint = model.counts.withTaint.toLocaleString()

  // The detection figure, counted off the records rather than read from
  // `counts.refused`, because it is counted differently on purpose: a case whose
  // response was actually rewritten is stated once, in `intercepted`. The two
  // halves of the hint therefore add up instead of overlapping, which a hint has
  // to do — it is the one place a number is quoted with no room to explain it.
  // `hasRefusal`, not `wouldBlock`: the larger field is mostly a string the
  // kernel writes itself, and a tab hint has no room to say so.
  const detected = useMemo(
    () =>
      model.traces
        .filter((trace) => !interceptedBy(trace) && hasRefusal(trace))
        .length.toLocaleString(),
    [model.traces],
  )

  const tabs: Tab[] = [
    {
      id: 'cases',
      label: { en: 'Cases', zh: '用例' },
      hint: { en: `${cases} cases · ${steps} instructions`, zh: `${cases} 个用例 · ${steps} 条指令` },
    },
    {
      id: 'graph',
      label: { en: 'Taint graph', zh: '污点传播图' },
      // The count of cases the graph has something inherited to show, over the
      // suite — never a bare number, and never a claim that the other 96 are
      // clean of anything else.
      hint: {
        en: `${withTaint} of ${cases} carry a propagated label`,
        zh: `${cases} 个中有 ${withTaint} 个带着传播来的标签`,
      },
    },
    {
      id: 'policies',
      label: { en: 'Policies', zh: '策略' },
      // The pair, in the one place a reader may never click through to. A hint
      // that said "1 rewritten" alone would be the misreading this whole adapter
      // is built to prevent — and one that said "66 matched" would be the other
      // one, since a recorded policy name is not a detection. So the pair is the
      // detection count and the interception count, and `flagged` is not here.
      hint: {
        en: `${detected} of ${cases} refused, not stopped · ${intercepted} stopped`,
        zh: `${cases} 个中 ${detected} 个写了拒绝但未拦截 · ${intercepted} 个已拦截`,
      },
    },
  ]

  return (
    <section className="abv">
      <div className="abv-tabs" role="tablist" aria-label={t({ en: 'ArbiterOS views', zh: 'ArbiterOS 视图' })}>
        {tabs.map((one) => (
          <button
            key={one.id}
            type="button"
            role="tab"
            id={`abv-tab-${one.id}`}
            aria-selected={tab === one.id}
            aria-controls={`abv-panel-${one.id}`}
            className={tab === one.id ? 'abv-tab is-active' : 'abv-tab'}
            onClick={() => setTab(one.id)}
          >
            <span>{t(one.label)}</span>
            <span className="abv-tab-hint">{t(one.hint)}</span>
          </button>
        ))}
      </div>

      <DeadLink model={model} recordId={recordId} found={found} namesStep={namesStep} />

      <Notes notes={model.notes} openByDefault={tab === 'policies'} />

      <div
        className="abv-panel"
        role="tabpanel"
        id={`abv-panel-${tab}`}
        aria-labelledby={`abv-tab-${tab}`}
      >
        {tab === 'cases' ? (
          <CaseBrowser
            model={model}
            // `null`, not `undefined`: this file owns the selection either way,
            // and `undefined` would hand it back to the list. Nothing selected
            // has to stay nothing selected, or a reader who opened the demo with
            // no link would find a row highlighted that they never chose.
            selectedId={found.trace ? found.trace.id : null}
            onSelect={(id) => selectRecord(traceRecordId(id))}
          />
        ) : tab === 'graph' ? (
          graphTrace ? (
            <div className="abv-graph">
              {graphIsFallback && <FallbackNote model={model} shown={graphTrace} />}
              <TaintGraph
                trace={graphTrace}
                stepIndex={found.stepIndex >= 0 ? found.stepIndex : undefined}
                onSelectStep={(index) => selectRecord(stepRecordId(graphTrace.id, index))}
                howToReadTheCounts={model.howToReadTheCounts}
              />
            </div>
          ) : (
            <p className="muted">
              {t({
                en: 'No cases in these files, so there is no propagation to draw.',
                zh: '这些文件里没有用例，也就没有可画的传播链。',
              })}
            </p>
          )
        ) : (
          <PolicyPanel model={model} />
        )}
      </div>
    </section>
  )
}

/**
 * The case the graph opens on when nothing was selected.
 *
 * The first case that carries a propagated LOW trust or HIGH confidentiality
 * label, because a graph opening on a case where nothing was inherited shows the
 * reader an empty demonstration of the one thing it exists to demonstrate. The
 * rule is stated on screen with its denominator (`FallbackNote`) so the choice
 * reads as a rule and not as a curated highlight; with no such case, the first
 * case, and the note says that instead.
 */
function pickForGraph(traces: readonly Trace[]): Trace | undefined {
  return traces.find(isTaintedTrace) ?? traces.at(0)
}

const FallbackNote: FC<{ model: ArbiterosModel; shown: Trace }> = ({ model, shown }) => {
  const t = useT()
  const total = model.counts.cases.toLocaleString()
  const tainted = model.counts.withTaint.toLocaleString()
  const chosen = isTaintedTrace(shown)
  return (
    <p className="abv-hint">
      {chosen
        ? t({
            en: `Nothing is selected, so this opens on the first of the ${tainted} cases, of ${total}, that carry a LOW trust or HIGH confidentiality label after propagation — the graph has nothing to show on a case where no label was inherited. Any of the ${total} can be opened from the Cases tab.`,
            zh: `当前没有选中任何用例，所以这里打开的是「传播之后带有 LOW 可信度或 HIGH 机密度标签」的 ${tainted} 个用例（共 ${total} 个）里的第一个——如果一个用例没有继承过任何标签，这张图就没有东西可画。这 ${total} 个用例都可以在「用例」标签页里打开。`,
          })
        : t({
            en: `Nothing is selected, so this opens on the first of the ${total} cases. None of them carries a LOW trust or HIGH confidentiality label after propagation.`,
            zh: `当前没有选中任何用例，所以这里打开的是这 ${total} 个用例里的第一个。它们当中没有任何一个在传播之后带有 LOW 可信度或 HIGH 机密度标签。`,
          })}
    </p>
  )
}

/**
 * What the `?record=` in the address bar asked for and did not get.
 *
 * Two different misses, said as two different sentences: the package has no such
 * case, or it has the case and not that instruction. The second is the one worth
 * separating — a reader who is told "no record here" while looking at the case
 * named in their own link learns nothing. Ids are quoted verbatim, in both
 * languages, because they came out of somebody's URL.
 */
const DeadLink: FC<{
  model: ArbiterosModel
  recordId?: string
  found: ReturnType<typeof locate>
  namesStep: boolean
}> = ({ model, recordId, found, namesStep }) => {
  const t = useT()
  if (recordId === undefined || recordId === '') return null
  // An empty package is not a broken link; the notice stack already says the
  // drop held no cases, and two reports of one fact read as two faults.
  if (model.traces.length === 0) return null

  if (found.traceIndex < 0) {
    return (
      <p className="notice warn">
        {t({
          en: `No case “${recordId}” in this package.`,
          zh: `这个数据包里没有用例「${recordId}」。`,
        })}
      </p>
    )
  }

  if (namesStep && found.stepIndex < 0 && found.trace) {
    const total = found.trace.steps.length.toLocaleString()
    return (
      <p className="notice warn">
        {t({
          en: `“${recordId}” names an instruction this case does not have — ${found.trace.id} has ${total}, numbered from 0. Showing the case from its first instruction.`,
          zh: `「${recordId}」指向的指令在这个用例里不存在——${found.trace.id} 一共 ${total} 条指令，编号从 0 开始。这里从它的第一条指令开始显示。`,
        })}
      </p>
    )
  }

  return null
}

/**
 * What the model knows that the numbers do not say.
 *
 * Not a disclosure triangle: the first notes are on screen before anyone clicks
 * anything, on every tab, and every note is rendered whole — a sentence is never
 * cut mid-way. The head says how many there are, so a reader can tell a
 * shortened list from a complete one. The block cannot grow past its cap,
 * because underneath it is a virtual list whose rows have to have somewhere to
 * be, and a caveat that leaves no room for the thing it qualifies has stopped
 * qualifying anything.
 */
const Notes: FC<{ notes: readonly Str[]; openByDefault: boolean }> = ({ notes, openByDefault }) => {
  const t = useT()
  const [asked, setAsked] = useState<boolean | null>(null)
  const open = asked ?? openByDefault

  if (notes.length === 0) return null

  const expandable = notes.length > NOTES_SHOWN_COLLAPSED
  const shown = open ? notes : notes.slice(0, NOTES_SHOWN_COLLAPSED)
  const count = notes.length.toLocaleString()

  return (
    <section className="abv-notes" aria-label={t({ en: 'About this data', zh: '关于这批数据' })}>
      <div className="abv-notes-head">
        <span className="abv-notes-title">
          {t({
            en: `About this data · ${count} note${notes.length === 1 ? '' : 's'}`,
            zh: `关于这批数据 · ${count} 条说明`,
          })}
        </span>
        <span className="spacer" />
        {expandable && (
          <button
            type="button"
            className="btn ghost abv-notes-toggle"
            aria-expanded={open}
            onClick={() => setAsked(!open)}
          >
            {open
              ? t({ en: 'Show fewer', zh: '收起' })
              : t({
                  en: `Show all ${count} notes`,
                  zh: `展开全部 ${count} 条说明`,
                })}
          </button>
        )}
      </div>
      <ul className="abv-note-list">
        {/* Keyed off the English side, as everywhere else a `Str` needs a key:
            the identity of a note must not change with the reader's language. */}
        {shown.map((note) => (
          <li key={note.en}>{t(note)}</li>
        ))}
      </ul>
    </section>
  )
}
