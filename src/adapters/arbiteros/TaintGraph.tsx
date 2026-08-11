/**
 * V1 — the taint graph. One case's instructions, drawn left to right, with the
 * two security labels on every node and the ancestor that set them one click
 * away. This is the view ArbiterOS forked the whole of Langfuse to get.
 *
 * Six things here are not obvious.
 *
 *   - **Two channels, three redundant carriers each.** Border is
 *     trustworthiness, fill is confidentiality — and neither is carried by hue
 *     alone: the border also changes dash pattern (LOW solid-thick, UNKNOWN
 *     dashed, HIGH solid-thin), the fill also changes texture (LOW plain,
 *     UNKNOWN dotted, HIGH hatched), and both values are written on the node in
 *     words. The words are the kernel's own (`LOW`/`UNKNOWN`/`HIGH`) and are
 *     never translated. The legend shows the same elements the nodes are drawn
 *     from, so what is named is literally what is on screen.
 *
 *   - **The node shows the propagated label, and says so when it was
 *     inherited.** `trust ◆UNKNOWN→▼LOW` reads "its own label was UNKNOWN, what
 *     it ended up with is LOW". The encoding follows the right-hand side,
 *     because the propagated value is the one the policy chain acts on. A node
 *     whose two values agree writes one value and no arrow.
 *
 *   - **The arrows and the propagation are not the same relation, and drawing
 *     only one of them would misdescribe the kernel.** `parentId` is the
 *     instruction an instruction derives from, and it is what this layout is
 *     built on. Labels, though, propagate along `reference_tool_id` — the array
 *     inside a tool call's own arguments naming the earlier calls it used
 *     (`代码导读.md` §3.4). In the shipped package the two mostly coincide (114
 *     of 202 resolved references are also the parent link), but not always. So
 *     both are drawn: solid arrows for `parentId`, dashed arcs for a reference
 *     that is not already the parent link, and the blame search below walks the
 *     references, not the arrows.
 *
 *   - **"Trust takes the minimum" is turned into a click.** Select a node whose
 *     own label and inherited label differ and the panel names the ancestor
 *     carrying the value that won the min (or the max, for confidentiality) and
 *     lights the path to it. When no ancestor in this trace carries it — 4 of
 *     the 22 trust drops in the shipped package are like this — the panel says
 *     exactly that instead of pointing at an innocent step. A graph that always
 *     produces a culprit is a graph that sometimes invents one.
 *
 *   - **A verdict is three facts, not one.** `wouldBlock` is the kernel's
 *     `inactivate_error_type` — a policy judged the response should be stopped
 *     and wrote down the refusal it would have returned; `modified` is whether
 *     the response was actually substituted; `policies` is only which names were
 *     recorded, which is the weakest of the three and is not a detection. They
 *     come apart because `enabled` in `policy_registry.json` selects observe-only
 *     or enforce. So the verdict block states all three separately, quotes the
 *     withheld refusal in full, and never turns "the response was not rewritten"
 *     into "nothing was detected" — nor a recorded name into a detection. When
 *     the caller hands over the package's own `how_to_read_the_counts`, it is
 *     rendered verbatim right there.
 *
 *   - **The graph is hand-rolled and the layout is deliberately simple**: layer
 *     = depth along `parentId`, so every arrow points right; rows = a tidy-tree
 *     pass (each leaf takes the next row, each parent centres on its children),
 *     so siblings stack. There is no graph library in this project — dagre went
 *     in M0 — and at 500 steps over 105 cases (median 4, one case of 41) none is
 *     needed. Cycles and dangling parents cannot happen in the shipped package
 *     and are handled anyway: the offending link is cut for layout purposes and
 *     the node says so.
 */

import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FC, KeyboardEvent } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import { wouldBlockOf } from './CaseBrowser'
import type { Step, Taint, Trace } from './contract'
import './graph.css'

/* ------------------------------------------------------------------ levels */

/**
 * `LOW < UNKNOWN < HIGH`, the kernel's own order (`types.py:LEVEL_ORDER`).
 * A value outside it is rendered as it arrived and encoded as `unstated`: the
 * package may grow a level this file has not met, and inventing a rank for it
 * would put it in the wrong place on the very axis it is being read on.
 */
const LEVEL_ORDER: Record<string, number> = { LOW: 0, UNKNOWN: 1, HIGH: 2 }

/** Shape, not hue: the glyph is what survives a monochrome print. */
const LEVEL_GLYPH: Record<string, string> = { LOW: '▼', UNKNOWN: '◆', HIGH: '▲' }

function levelKey(value: string | undefined): string {
  return value !== undefined && value in LEVEL_ORDER ? value.toLowerCase() : 'unstated'
}

/** `▼LOW`. The word is the data's; the glyph is this file's redundancy. */
function levelText(value: string | undefined): string {
  if (value === undefined) return '—'
  return `${LEVEL_GLYPH[value] ?? '·'}${value}`
}

/** What a node writes for one channel: `trust ▼LOW`, or `trust ◆UNKNOWN→▼LOW`. */
function channelText(field: string, own: string | undefined, propagated: string | undefined): string {
  if (propagated === undefined || propagated === own) return `${field} ${levelText(own)}`
  return `${field} ${levelText(own)}→${levelText(propagated)}`
}

/* ------------------------------------------------------------------- graph */

interface ToolCall {
  toolName: string | null
  toolCallId: string | null
  /** `arguments.reference_tool_id` — the ids this call says it used. */
  refs: string[]
}

const NO_TOOL_CALL: ToolCall = { toolName: null, toolCallId: null, refs: [] }

/**
 * A step's content is prose for a message and serialised JSON for a tool call.
 * Nothing here is translated, reformatted or repaired: a content string that
 * will not parse simply yields no tool call, and the node falls back to the
 * kernel's own `instruction_type`.
 */
function readToolCall(content: string): ToolCall {
  if (!content.startsWith('{')) return NO_TOOL_CALL
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return NO_TOOL_CALL
  }
  if (typeof parsed !== 'object' || parsed === null) return NO_TOOL_CALL
  const record = parsed as Record<string, unknown>
  const rawArgs = record.arguments
  const args =
    typeof rawArgs === 'object' && rawArgs !== null ? (rawArgs as Record<string, unknown>) : {}
  const rawRefs = args.reference_tool_id
  return {
    toolName: typeof record.tool_name === 'string' ? record.tool_name : null,
    toolCallId: typeof record.tool_call_id === 'string' ? record.tool_call_id : null,
    refs: Array.isArray(rawRefs) ? rawRefs.filter((one): one is string => typeof one === 'string') : [],
  }
}

interface GraphNode {
  index: number
  step: Step
  tool: ToolCall
  /** Index of the `parentId` step, after any cycle-breaking below. */
  parent: number | null
  /** Set when the declared parent could not be used, and why. */
  brokenParent: 'missing' | 'cycle' | null
  /** Resolved `reference_tool_id` targets, earlier in the trace. */
  refs: number[]
  layer: number
  row: number
  x: number
  y: number
}

interface Edge {
  from: number
  to: number
  kind: 'parent' | 'reference'
}

interface Graph {
  nodes: GraphNode[]
  edges: Edge[]
  width: number
  height: number
  /** Parents naming a step that is not in this trace. Zero in the shipped package. */
  dangling: number
  /** Parent links cut because following them would loop. Zero in the shipped package. */
  cycles: number
}

/* Geometry, in SVG user units, which are CSS pixels here: the drawing is not
   scaled to fit. A graph that shrinks to fit its box turns 41 nodes into 41
   unreadable smudges, so the canvas keeps its size and the pane scrolls. */
const NODE_W = 176
const NODE_H = 58
const COL_PITCH = NODE_W + 58
const ROW_PITCH = NODE_H + 30
const PAD_X = 20
const PAD_TOP = 32
const PAD_BOTTOM = 40

function buildGraph(steps: readonly Step[]): Graph {
  const tools = steps.map((one) => readToolCall(one.content))
  const indexById = new Map<string, number>()
  steps.forEach((one, index) => {
    if (!indexById.has(one.id)) indexById.set(one.id, index)
  })

  // A reference names a `tool_call_id`, and a call and its result share one —
  // so an id can match two steps. The latest match *before* the referring step
  // is the one taken: that is the step that had already run, and it is the one
  // carrying the result the reference is about.
  const lastSeen = new Map<string, number>()
  const refs: number[][] = []
  steps.forEach((_, index) => {
    const resolved: number[] = []
    for (const id of tools[index].refs) {
      const at = lastSeen.get(id)
      if (at !== undefined && !resolved.includes(at)) resolved.push(at)
    }
    refs.push(resolved)
    const own = tools[index].toolCallId
    if (own !== null) lastSeen.set(own, index)
  })

  const parents: (number | null)[] = []
  const broken: ('missing' | 'cycle' | null)[] = []
  let dangling = 0
  steps.forEach((one) => {
    if (one.parentId === null || one.parentId === undefined) {
      parents.push(null)
      broken.push(null)
      return
    }
    const at = indexById.get(one.parentId)
    if (at === undefined) {
      dangling += 1
      parents.push(null)
      broken.push('missing')
      return
    }
    parents.push(at)
    broken.push(null)
  })

  // Depth with memoisation. Re-entering a node that is still being resolved
  // means its parent chain loops; that one link is cut so the layout stays a
  // forest, the node keeps its own place as a root, and it is marked rather
  // than silently straightened out.
  let cycles = 0
  const depth = new Array<number>(steps.length).fill(-1)
  const visiting = new Set<number>()
  const depthOf = (index: number): number => {
    if (depth[index] >= 0) return depth[index]
    const parent = parents[index]
    if (parent === null) {
      depth[index] = 0
      return 0
    }
    if (visiting.has(index)) {
      cycles += 1
      parents[index] = null
      broken[index] = 'cycle'
      depth[index] = 0
      return 0
    }
    visiting.add(index)
    const above = depthOf(parent)
    visiting.delete(index)
    // The recursion may have come back round the loop and cut *this* node's own
    // parent link, which already made it a root at depth 0. Overwriting that
    // with `above + 1` would leave it to the right of its own former parent and
    // draw the one edge in the graph that points backwards.
    if (depth[index] >= 0) return depth[index]
    depth[index] = above + 1
    return depth[index]
  }
  steps.forEach((_, index) => depthOf(index))

  const children: number[][] = steps.map(() => [])
  parents.forEach((parent, index) => {
    if (parent !== null) children[parent].push(index)
  })

  // Tidy tree: every leaf takes the next free row, every parent centres on its
  // own children. On the shipped package every case is a chain, so this puts
  // all of it on one row; it is what makes a branching trace readable.
  const rows = new Array<number>(steps.length).fill(0)
  let nextRow = 0
  const place = (index: number): void => {
    const kids = children[index]
    if (kids.length === 0) {
      rows[index] = nextRow
      nextRow += 1
      return
    }
    for (const kid of kids) place(kid)
    rows[index] = (rows[kids[0]] + rows[kids[kids.length - 1]]) / 2
  }
  parents.forEach((parent, index) => {
    if (parent === null) place(index)
  })

  const nodes: GraphNode[] = steps.map((step, index) => ({
    index,
    step,
    tool: tools[index],
    parent: parents[index],
    brokenParent: broken[index],
    refs: refs[index],
    layer: depth[index],
    row: rows[index],
    x: PAD_X + depth[index] * COL_PITCH,
    y: PAD_TOP + rows[index] * ROW_PITCH,
  }))

  const edges: Edge[] = []
  for (const node of nodes) {
    if (node.parent !== null) edges.push({ from: node.parent, to: node.index, kind: 'parent' })
    for (const ref of node.refs) {
      // A reference that is also the parent link is already drawn. Two lines
      // between the same pair would read as two relations.
      if (ref !== node.parent) edges.push({ from: ref, to: node.index, kind: 'reference' })
    }
  }

  const layers = nodes.reduce((most, one) => Math.max(most, one.layer), 0)
  const lastRow = nodes.reduce((most, one) => Math.max(most, one.row), 0)
  return {
    nodes,
    edges,
    width: PAD_X * 2 + layers * COL_PITCH + NODE_W,
    height: PAD_TOP + PAD_BOTTOM + lastRow * ROW_PITCH + NODE_H,
    dangling,
    cycles,
  }
}

/* ------------------------------------------------------------------- blame */

type Channel = 'trust' | 'conf'

/**
 * What the policy chain did with this case's response, strongest first: it was
 * substituted; a policy said it should have been and the kernel returned the
 * original anyway (observe-only — `verdict.wouldBlock`); a policy name was
 * recorded and nothing else; nothing at all. The third is not a detection and is
 * drawn as the neutral mark, so it cannot be read as one.
 */
type VerdictState = 'rewritten' | 'wouldblock' | 'flagged' | 'clean'

function ownOf(taint: Taint, channel: Channel): string | undefined {
  return channel === 'trust' ? taint.trust : taint.conf
}

function propagatedOf(taint: Taint, channel: Channel): string | undefined {
  return channel === 'trust' ? taint.propTrust : taint.propConf
}

type Blame =
  /** The package carries no propagated value for this channel. */
  | { kind: 'unstated' }
  /** Own and propagated agree — nothing was inherited, so nobody is to blame. */
  | { kind: 'own' }
  /** An ancestor carries the value that won; `path` runs from it to the node. */
  | { kind: 'found'; at: number; path: number[]; via: 'reference' | 'parent' }
  /** They differ and no ancestor in this trace carries it. Said, not guessed. */
  | { kind: 'unaccounted' }

/**
 * Which ancestor produced the label this step ended up with.
 *
 * The search walks `reference_tool_id` first, because that is the relation the
 * kernel aggregates over, and falls back to `parentId` only when the references
 * explain nothing — a case's tool calls may leave the array empty while the
 * conversation order still shows where the value came from. Breadth-first, so
 * the ancestor named is the nearest one that carries the value: with several
 * upstream LOWs, min is min, and the closest is the one a reader can check.
 */
function blameFor(graph: Graph, index: number, channel: Channel): Blame {
  const taint = graph.nodes[index].step.taint
  const own = ownOf(taint, channel)
  const propagated = propagatedOf(taint, channel)
  if (propagated === undefined) return { kind: 'unstated' }
  if (propagated === own) return { kind: 'own' }

  for (const via of ['reference', 'parent'] as const) {
    const previous = new Map<number, number>()
    const queue = [index]
    const seen = new Set<number>([index])
    while (queue.length > 0) {
      const at = queue.shift() as number
      const upstream =
        via === 'reference'
          ? graph.nodes[at].refs
          : graph.nodes[at].parent === null
            ? []
            : [graph.nodes[at].parent as number]
      for (const up of upstream) {
        if (seen.has(up)) continue
        seen.add(up)
        previous.set(up, at)
        if (ownOf(graph.nodes[up].step.taint, channel) === propagated) {
          const path = [up]
          let cursor = up
          for (;;) {
            const next = previous.get(cursor)
            if (next === undefined) break
            path.push(next)
            cursor = next
          }
          return { kind: 'found', at: up, path, via }
        }
        queue.push(up)
      }
    }
  }
  return { kind: 'unaccounted' }
}

/* -------------------------------------------------------------------- view */

/**
 * A deep link that names an instruction this case does not have opens on the
 * first one rather than on nothing. The miss is the router's to report — it
 * knows what the link said; this view only knows how many steps it has.
 */
function inRange(index: number | undefined, count: number): number {
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= count) return 0
  return index
}

/**
 * Where a scrollport has to sit for a span to be on screen, moved as little as
 * possible: unchanged when the span is already inside it, otherwise the nearest
 * edge.
 *
 * A span too wide to fit keeps `must` — the one thing that has to be visible
 * whatever else is not — and spends the rest of the pane on the side the rest of
 * the span is on. An ancestor chain runs upstream, to the left, so this puts the
 * selected node at the right edge and as much of its chain as will fit beside
 * it; centring it would have thrown half the pane at empty canvas.
 */
function scrollToShow(
  current: number,
  viewport: number,
  span: [number, number],
  must: [number, number],
): number {
  const [start, end] = span
  if (end - start <= viewport) {
    if (start < current) return start
    if (end > current + viewport) return end - viewport
    return current
  }
  const before = must[0] - start
  const after = end - must[1]
  if (before > 0 && after <= 0) return must[1] - viewport
  if (after > 0 && before <= 0) return must[0]
  return must[0] - (viewport - (must[1] - must[0])) / 2
}

/** Rough advance width. CJK counts as one em, everything else as 0.58. */
function textWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) units += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.58
  return units * size
}

/** SVG text neither wraps nor clips, so a label that will not fit is cut here. */
function fit(text: string, width: number, size: number): string {
  if (textWidth(text, size) <= width) return text
  const chars = [...text]
  while (chars.length > 1 && textWidth(`${chars.join('')}…`, size) > width) chars.pop()
  return `${chars.join('')}…`
}

const NODE_LINE_W = NODE_W - 18
const CHANNEL_FIELDS: Record<Channel, string> = { trust: 'trust', conf: 'conf' }

/** The words for a channel, so the panel and the legend cannot drift apart. */
const CHANNEL_NAME: Record<Channel, Str> = {
  trust: { en: 'trustworthiness', zh: '可信度' },
  conf: { en: 'confidentiality', zh: '机密度' },
}

/** Which way the aggregate goes, in the kernel's terms. */
const CHANNEL_RULE: Record<Channel, Str> = {
  trust: {
    en: 'trust takes the minimum along the chain: one untrusted step upstream makes everything downstream untrusted',
    zh: '可信度沿引用链取最小值：上游只要有一步不可信，下游整条链就不可信',
  },
  conf: {
    en: 'confidentiality takes the maximum along the chain: one secret step upstream makes everything downstream secret',
    zh: '机密度沿引用链取最大值：上游只要碰过一处机密，下游整条链就是机密',
  },
}

export const TaintGraph: FC<{
  trace: Trace
  /**
   * The instruction to open on, as an index into `trace.steps` — what
   * `model.parseRecordId` recovers from a `?record=<caseId>:<stepIndex>` link.
   * Left out, the view opens on the first instruction.
   */
  stepIndex?: number
  /**
   * Called with the index of every instruction the reader selects, so the owner
   * of the URL can put it there. This view does not touch the router itself:
   * one adapter, one place that writes `?record=`.
   */
  onSelectStep?: (index: number) => void
  /**
   * The package's own sentence on why `flagged` and `intercepted` differ,
   * verbatim. Optional because a dropped file need not carry one; rendered
   * beside this case's verdict, which is where the misreading it guards against
   * actually happens.
   */
  howToReadTheCounts?: string
}> = ({ trace, stepIndex, onSelectStep, howToReadTheCounts }) => {
  const t = useT()
  const uid = useId()
  const graph = useMemo(() => buildGraph(trace.steps), [trace.steps])

  const [selected, setSelected] = useState(inRange(stepIndex, trace.steps.length))
  // A new case, or a new deep link into this one, starts where it says rather
  // than at whatever index the previous one left behind — an index that may not
  // even exist here. Adjusted during render: an effect would paint the wrong
  // instruction first, and that frame is the whole of a mailed link's first
  // impression.
  const [lastTrace, setLastTrace] = useState(trace.id)
  const [lastStepIndex, setLastStepIndex] = useState(stepIndex)
  if (trace.id !== lastTrace) {
    setLastTrace(trace.id)
    setLastStepIndex(stepIndex)
    setSelected(inRange(stepIndex, trace.steps.length))
  } else if (stepIndex !== lastStepIndex) {
    setLastStepIndex(stepIndex)
    setSelected(inRange(stepIndex, trace.steps.length))
  }

  const nodeEls = useRef(new Map<number, SVGGElement>())
  const at = graph.nodes[selected] as GraphNode | undefined

  const trustBlame = useMemo(
    () => (at ? blameFor(graph, selected, 'trust') : { kind: 'unstated' as const }),
    [graph, selected, at],
  )
  const confBlame = useMemo(
    () => (at ? blameFor(graph, selected, 'conf') : { kind: 'unstated' as const }),
    [graph, selected, at],
  )

  // The lit chain, as node indices and as edge keys, so a node and the edge
  // reaching it light together and nothing else has to be recomputed per edge.
  const lit = useMemo(() => {
    const nodes = new Map<number, Channel | 'both'>()
    const edges = new Map<string, Channel | 'both'>()
    const add = (blame: Blame, channel: Channel): void => {
      if (blame.kind !== 'found') return
      blame.path.forEach((index, position) => {
        const was = nodes.get(index)
        nodes.set(index, was === undefined || was === channel ? channel : 'both')
        if (position === 0) return
        const key = `${blame.path[position - 1]}->${index}`
        const seen = edges.get(key)
        edges.set(key, seen === undefined || seen === channel ? channel : 'both')
      })
    }
    add(trustBlame, 'trust')
    add(confBlame, 'conf')
    return { nodes, edges }
  }, [trustBlame, confBlame])

  /**
   * The drawing is wider than any pane it is shown in — 9,606px on the 41-step
   * case — so a selection that is not scrolled to is a selection nobody can see.
   * `?record=<case>:<step>` arrives as a prop, and a keyboard handler cannot
   * scroll for it: this runs off `selected`, so the link, the arrow keys, the
   * jump buttons and the panel all land the same way.
   *
   * What it puts on screen is the node AND the lit ancestor chain, because the
   * panel beside it says "it is lit in the graph, and so is the path to it" —
   * and a sentence the view does not honour is a defect, not a caption. When the
   * chain is wider than the pane the selected node is centred instead; nothing
   * moves at all when everything is already in view, so clicking a node never
   * yanks the pane out from under the click.
   */
  const canvasRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = canvasRef.current
    const node = graph.nodes[selected] as GraphNode | undefined
    if (box === null || node === undefined) return
    const xs = [node.x]
    const ys = [node.y]
    for (const index of lit.nodes.keys()) {
      const one = graph.nodes[index] as GraphNode | undefined
      if (one !== undefined) {
        xs.push(one.x)
        ys.push(one.y)
      }
    }
    // The same padding on the span and on the node, so "the rest of the span is
    // on this side" is a fact about nodes and not about the margin around them.
    const x = scrollToShow(
      box.scrollLeft,
      box.clientWidth,
      [Math.min(...xs) - PAD_X, Math.max(...xs) + NODE_W + PAD_X],
      [node.x - PAD_X, node.x + NODE_W + PAD_X],
    )
    const y = scrollToShow(
      box.scrollTop,
      box.clientHeight,
      [Math.min(...ys) - PAD_TOP, Math.max(...ys) + NODE_H + PAD_BOTTOM],
      [node.y - PAD_TOP, node.y + NODE_H + PAD_BOTTOM],
    )
    box.scrollLeft = Math.max(0, Math.min(x, box.scrollWidth - box.clientWidth))
    box.scrollTop = Math.max(0, Math.min(y, box.scrollHeight - box.clientHeight))
  }, [graph, lit, selected])

  const select = (index: number, focus: boolean): void => {
    if (index < 0 || index >= graph.nodes.length) return
    setSelected(index)
    // `lastStepIndex` deliberately tracks the *prop* and not this: comparing a
    // clicked index against an absent prop would reset the selection to the
    // first instruction on the very next render.
    onSelectStep?.(index)
    if (focus) nodeEls.current.get(index)?.focus()
  }

  /**
   * One node holds the tab stop and the arrows move it — the pattern a 41-node
   * graph needs, since 41 tab stops between the pane above and the panel beside
   * it is a keyboard trap in all but name. The directions match the drawing:
   * left is the instruction this one derives from, right is what derives from
   * it, up and down are the neighbours in the same column.
   */
  const onKeyDown = (event: KeyboardEvent<SVGGElement>, node: GraphNode): void => {
    const sameLayer = graph.nodes
      .filter((one) => one.layer === node.layer)
      .sort((a, b) => a.row - b.row)
    const here = sameLayer.findIndex((one) => one.index === node.index)
    const firstChild = graph.nodes.find((one) => one.parent === node.index)
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = node.parent ?? node.index - 1
    else if (event.key === 'ArrowRight') next = firstChild?.index ?? node.index + 1
    else if (event.key === 'ArrowUp') next = sameLayer[here - 1]?.index ?? node.index - 1
    else if (event.key === 'ArrowDown') next = sameLayer[here + 1]?.index ?? node.index + 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = graph.nodes.length - 1
    else if (event.key === 'Enter' || event.key === ' ') next = node.index
    else return
    event.preventDefault()
    select(next, true)
  }

  if (graph.nodes.length === 0) {
    return (
      <section className="tg">
        <p className="notice">
          {t({
            en: 'This case replayed with no instructions, so there is no propagation to draw.',
            zh: '这个用例回放后没有产生任何指令，因而没有可画的传播关系。',
          })}
        </p>
      </section>
    )
  }

  // The response the kernel judged is the last instruction of the replay: the
  // harness feeds `prior` in and appends `current`, which is the thing
  // `check_response_policy` is called on. Checked against the 105 case files
  // that ship with the kernel — the tail of every trace is that case's
  // `current`. The verdict is recorded for the case as a whole, so it is drawn
  // once, here, and never spread over steps it does not describe.
  const judged = graph.nodes[graph.nodes.length - 1]
  const rewritten = trace.verdict.modified
  const flagged = trace.verdict.policies.length > 0
  // The refusal a policy wrote down and the kernel did not return. It is the
  // detection, and it outranks `flagged` on the drawing: a recorded policy name
  // is the weakest of the three facts and wears the quietest mark.
  const refusal = wouldBlockOf(trace)
  const verdictState: VerdictState = rewritten
    ? 'rewritten'
    : refusal !== ''
      ? 'wouldblock'
      : flagged
        ? 'flagged'
        : 'clean'

  const inherited = graph.nodes.filter((one) => {
    const taint = one.step.taint
    return (
      (taint.propTrust !== undefined && taint.propTrust !== taint.trust) ||
      (taint.propConf !== undefined && taint.propConf !== taint.conf)
    )
  }).length

  const names = trace.verdict.policies.join(', ')
  const verdictMark =
    verdictState === 'rewritten'
      ? `${t({ en: 'response rewritten', zh: '响应被改写' })}${names === '' ? '' : ` · ${names}`}`
      : verdictState === 'wouldblock'
        ? `${t({ en: 'would be blocked · returned unchanged', zh: '本应拦截 · 原样返回' })}`
        : verdictState === 'flagged'
          ? `${t({ en: 'policy name recorded', zh: '记录到 policy 名称' })} · ${names}`
          : t({ en: 'no policy fired', zh: '没有 policy 命中' })
  // SVG text does not clip to anything, so the mark under the last node is
  // measured and the canvas widened when the pill is wider than the node it
  // hangs from. Otherwise a long policy name simply falls off the drawing.
  const markWidth = Math.ceil(textWidth(verdictMark, 10.5)) + 16
  const canvasWidth = Math.max(graph.width, judged.x + NODE_W / 2 + markWidth / 2 + PAD_X)

  return (
    <section className="tg">
      <div className="tg-graph-side">
        <header className="tg-cap">
          <h3 className="tg-cap-title">
            {/* The case id is the data's own and is never translated. */}
            <span className="mono">{trace.id}</span>
          </h3>
          <p className="tg-cap-line">
            {t({
              en: 'One node per instruction. A solid arrow is parentId — the instruction this one derives from. A dashed arc is reference_tool_id, the earlier call a tool call says it used, which is the chain labels actually propagate along.',
              zh: '每个节点是一条指令。实线箭头是 parentId，即这条指令从哪条派生而来；虚线弧是 reference_tool_id，即这次工具调用自己声明用到的更早的调用——标签正是沿这条链传播的。',
            })}
          </p>
          <p className="tg-cap-line">
            {t({
              en: 'Border is trustworthiness, fill is confidentiality, both as they stand after propagation. A node whose own label differs from what it inherited writes both, own first.',
              zh: '边框表示可信度，填充表示机密度，取的都是传播之后的值。若某节点自身的标签与继承到的不同，就把两者都写出来，自身在前。',
            })}
          </p>
          <p className="tg-cap-line faint">
            {t({
              en: `${graph.nodes.length} instruction${graph.nodes.length === 1 ? '' : 's'} in this case, ${inherited} of them carrying a label they did not set themselves.`,
              zh: `本用例共 ${graph.nodes.length} 条指令，其中 ${inherited} 条带着并非自己打上的标签。`,
            })}
          </p>
          {(graph.dangling > 0 || graph.cycles > 0) && (
            <p className="notice warn tg-cap-warn">
              {graph.dangling > 0 &&
                t({
                  en:
                    graph.dangling === 1
                      ? '1 step names a parentId that is not in this trace; it is drawn as a root and marked.'
                      : `${graph.dangling} steps name a parentId that is not in this trace; they are drawn as roots and marked.`,
                  zh: `有 ${graph.dangling} 条指令的 parentId 不在这条 trace 里；它们被当作根节点画出并已标出。`,
                })}
              {graph.cycles > 0 &&
                t({
                  en: ` ${graph.cycles} parent link${graph.cycles === 1 ? '' : 's'} would loop and ${graph.cycles === 1 ? 'was' : 'were'} cut for the layout, not for the data.`,
                  zh: ` 另有 ${graph.cycles} 条 parent 链会成环，为排版而断开，数据本身未改。`,
                })}
            </p>
          )}
          <p className="tg-cap-line faint">
            {t({
              en: 'Keyboard: ← the instruction this derives from · → what derives from it · ↑ ↓ neighbours in the same column · Home / End first and last.',
              zh: '键盘：← 上一级来源指令 · → 由它派生的指令 · ↑ ↓ 同一列的相邻节点 · Home / End 首尾。',
            })}
          </p>
        </header>

        <Legend uid={uid} />

        <div className="tg-canvas" ref={canvasRef}>
          <svg
            className="tg-svg"
            width={canvasWidth}
            height={graph.height}
            role="group"
            aria-label={t({
              en: `Label propagation across ${graph.nodes.length} instructions`,
              zh: `${graph.nodes.length} 条指令之间的标签传播`,
            })}
          >
            <defs>
              <marker
                id={`${uid}-arrow`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path className="tg-arrowhead" d="M0 0.5 L8 4 L0 7.5 Z" />
              </marker>
              <marker
                id={`${uid}-arrow-lit`}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path className="tg-arrowhead is-lit" d="M0 0.5 L8 4 L0 7.5 Z" />
              </marker>
              {/* Texture, so the fill channel survives a dark theme where every
                  soft tint is within a hair of the surface behind it, and
                  survives being read without colour at all. */}
              <pattern
                id={`${uid}-dots`}
                width="7"
                height="7"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <circle className="tg-dot" cx="1.4" cy="1.4" r="1" />
              </pattern>
              <pattern
                id={`${uid}-hatch`}
                width="6"
                height="6"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line className="tg-hatch" x1="0" y1="0" x2="0" y2="6" />
              </pattern>
            </defs>

            {graph.edges.map((edge) => {
              const key = `${edge.from}->${edge.to}`
              const role = lit.edges.get(key)
              return (
                <path
                  key={`${key}-${edge.kind}`}
                  className={`tg-edge tg-edge-${edge.kind}`}
                  data-lit={role}
                  d={edgePath(graph.nodes[edge.from], graph.nodes[edge.to], edge.kind)}
                  markerEnd={`url(#${uid}-${role === undefined ? 'arrow' : 'arrow-lit'})`}
                />
              )
            })}

            {graph.nodes.map((node) => (
              <NodeBox
                key={node.step.id}
                node={node}
                uid={uid}
                selected={node.index === selected}
                lit={lit.nodes.get(node.index)}
                blamed={
                  (trustBlame.kind === 'found' && trustBlame.at === node.index) ||
                  (confBlame.kind === 'found' && confBlame.at === node.index)
                }
                judged={node.index === judged.index}
                verdict={verdictState}
                register={(element) => {
                  if (element === null) nodeEls.current.delete(node.index)
                  else nodeEls.current.set(node.index, element)
                }}
                onSelect={() => select(node.index, true)}
                onKeyDown={(event) => onKeyDown(event, node)}
              />
            ))}

            {/* The verdict belongs to the case, and the case's response is its
                last instruction — so it is written once, under that node. */}
            <g className="tg-mark" data-verdict={verdictState}>
              <rect
                className="tg-mark-box"
                x={judged.x + NODE_W / 2 - markWidth / 2}
                y={judged.y + NODE_H + 10}
                width={markWidth}
                height={20}
                rx={10}
              />
              <text
                className="tg-mark-text"
                x={judged.x + NODE_W / 2}
                y={judged.y + NODE_H + 24}
                textAnchor="middle"
              >
                {verdictMark}
              </text>
            </g>
          </svg>
        </div>
      </div>

      {at && (
        <aside className="tg-panel panel">
          <header className="panel-header">
            {t({ en: 'Selected instruction', zh: '选中的指令' })}
            <span className="spacer" />
            <span className="mono faint">
              {t({
                en: `${selected + 1} of ${graph.nodes.length}`,
                zh: `第 ${selected + 1} 条，共 ${graph.nodes.length} 条`,
              })}
            </span>
          </header>
          <div className="panel-body tg-panel-body">
            <Facts node={at} />
            <Propagation
              graph={graph}
              node={at}
              channel="trust"
              blame={trustBlame}
              onJump={(index) => select(index, true)}
            />
            <Propagation
              graph={graph}
              node={at}
              channel="conf"
              blame={confBlame}
              onJump={(index) => select(index, true)}
            />
            <Verdict
              trace={trace}
              judged={judged}
              howToReadTheCounts={howToReadTheCounts}
              onJump={() => select(judged.index, true)}
            />
            <section className="tg-block">
              <h4 className="tg-block-title">
                {t({ en: 'Content', zh: '内容' })}{' '}
                <span className="faint">
                  ·{' '}
                  {t({
                    en: 'exactly as the kernel recorded it',
                    zh: '与内核记录的完全一致',
                  })}
                </span>
              </h4>
              <pre className="tg-content">{at.step.content}</pre>
            </section>
          </div>
        </aside>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------- parts */

/**
 * A parent edge leaves the right of one node and enters the left of the next; a
 * reference arc rides above them, because below is where the verdict mark and
 * the next row live. Both carry an arrowhead: the direction is the direction
 * the label travels.
 */
function edgePath(from: GraphNode, to: GraphNode, kind: 'parent' | 'reference'): string {
  if (kind === 'parent') {
    const x1 = from.x + NODE_W
    const y1 = from.y + NODE_H / 2
    const x2 = to.x
    const y2 = to.y + NODE_H / 2
    if (y1 === y2) return `M${x1} ${y1} L${x2} ${y2}`
    const mid = (x1 + x2) / 2
    return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`
  }
  const x1 = from.x + NODE_W / 2
  const y1 = from.y
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const rise = Math.min(26, 10 + Math.abs(x2 - x1) / 12)
  return `M${x1} ${y1} C${x1} ${y1 - rise} ${x2} ${y2 - rise} ${x2} ${y2}`
}

const NodeBox: FC<{
  node: GraphNode
  uid: string
  selected: boolean
  lit: Channel | 'both' | undefined
  blamed: boolean
  judged: boolean
  verdict: VerdictState
  register: (element: SVGGElement | null) => void
  onSelect: () => void
  onKeyDown: (event: KeyboardEvent<SVGGElement>) => void
}> = ({ node, uid, selected, lit, blamed, judged, verdict, register, onSelect, onKeyDown }) => {
  const t = useT()
  const taint = node.step.taint
  const trustKey = levelKey(taint.propTrust ?? taint.trust)
  const confKey = levelKey(taint.propConf ?? taint.conf)
  const head = `#${node.step.step ?? node.index + 1} ${node.tool.toolName ?? node.step.type ?? ''}`.trim()

  return (
    <g
      className="tg-node"
      data-trust={trustKey}
      data-conf={confKey}
      data-lit={lit}
      data-blamed={blamed || undefined}
      data-judged={judged || undefined}
      data-verdict={judged ? verdict : undefined}
      transform={`translate(${node.x},${node.y})`}
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-current={selected || undefined}
      aria-label={t(nodeLabel(node, judged, verdict))}
      ref={register}
      onClick={onSelect}
      onKeyDown={onKeyDown}
    >
      {/* The chain highlight is an aura *outside* the node, not a restyling of
          it: painted over the border it would blank out the trustworthiness of
          every node in the chain — which is exactly what the reader followed
          the chain to see. */}
      {lit !== undefined && (
        <rect className="tg-node-lit" x={-9} y={-9} width={NODE_W + 18} height={NODE_H + 18} rx={11} />
      )}
      <rect className="tg-node-fill" width={NODE_W} height={NODE_H} rx={5} />
      {confKey !== 'low' && (
        <rect
          className="tg-node-texture"
          width={NODE_W}
          height={NODE_H}
          rx={5}
          fill={`url(#${uid}-${confKey === 'high' ? 'hatch' : 'dots'})`}
        />
      )}
      <text className="tg-node-head" x={9} y={17}>
        {fit(head, NODE_LINE_W, 11)}
      </text>
      <text className="tg-node-line" x={9} y={34}>
        {fit(channelText(CHANNEL_FIELDS.trust, taint.trust, taint.propTrust), NODE_LINE_W, 10.5)}
      </text>
      <text className="tg-node-line" x={9} y={49}>
        {fit(channelText(CHANNEL_FIELDS.conf, taint.conf, taint.propConf), NODE_LINE_W, 10.5)}
      </text>
      <rect className="tg-node-box" width={NODE_W} height={NODE_H} rx={5} />
      {node.brokenParent !== null && (
        <text className="tg-node-broken" x={NODE_W - 7} y={17} textAnchor="end">
          {node.brokenParent === 'missing' ? '⚯' : '↺'}
        </text>
      )}
      {selected && <rect className="tg-node-ring" x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8} rx={8} />}
    </g>
  )
}

/** Everything a node draws, in words, for anyone not reading the drawing. */
function nodeLabel(node: GraphNode, judged: boolean, verdict: VerdictState): Str {
  const taint = node.step.taint
  const what = node.tool.toolName ?? node.step.type ?? ''
  const number = node.step.step ?? node.index + 1
  const say = (channel: Channel, field: string): Str => {
    const own = ownOf(taint, channel)
    const propagated = propagatedOf(taint, channel)
    if (propagated === undefined || propagated === own) {
      return { en: `${field} ${own ?? 'not stated'}`, zh: `${field} ${own ?? '未标注'}` }
    }
    return {
      en: `${field} ${own ?? 'not stated'} on its own, ${propagated} after propagation`,
      zh: `${field} 自身 ${own ?? '未标注'}，传播后 ${propagated}`,
    }
  }
  const trust = say('trust', CHANNEL_FIELDS.trust)
  const conf = say('conf', CHANNEL_FIELDS.conf)
  const tail = judged
    ? verdict === 'rewritten'
      ? { en: ', the response the kernel judged and rewrote', zh: '，这是内核判决并改写了的响应' }
      : verdict === 'wouldblock'
        ? {
            en: ', the response the kernel judged; a policy said it should be stopped and the original was returned unchanged',
            zh: '，这是内核判决的响应；有 policy 判定它应当被拦下，而内核仍原样返回了它',
          }
        : verdict === 'flagged'
          ? { en: ', the response the kernel judged; a policy name was recorded and it was left unchanged', zh: '，这是内核判决的响应；记录到 policy 名称，响应未被改写' }
          : { en: ', the response the kernel judged; no policy fired', zh: '，这是内核判决的响应；没有 policy 命中' }
    : { en: '', zh: '' }
  return {
    en: `step ${number}, ${what}, ${trust.en}, ${conf.en}${tail.en}`,
    zh: `第 ${number} 步，${what}，${trust.zh}，${conf.zh}${tail.zh}`,
  }
}

/** The kernel's own fields for the selected step, unaltered. */
const Facts: FC<{ node: GraphNode }> = ({ node }) => {
  const t = useT()
  const taint = node.step.taint
  return (
    <section className="tg-block">
      <h4 className="tg-block-title">
        {t({ en: 'What the kernel recorded', zh: '内核记录了什么' })}
      </h4>
      <dl className="kv tg-kv">
        <dt>{t({ en: 'step', zh: '步序' })}</dt>
        <dd>{node.step.step ?? node.index + 1}</dd>
        <dt>{t({ en: 'category', zh: '类别' })}</dt>
        <dd>{node.step.category ?? '—'}</dd>
        <dt>{t({ en: 'type', zh: '类型' })}</dt>
        <dd>{node.step.type ?? '—'}</dd>
        {node.tool.toolName !== null && (
          <>
            <dt>tool_name</dt>
            <dd>{node.tool.toolName}</dd>
          </>
        )}
        {node.tool.toolCallId !== null && (
          <>
            <dt>tool_call_id</dt>
            <dd>{node.tool.toolCallId}</dd>
          </>
        )}
        <dt>trust</dt>
        <dd>{levelText(taint.trust)}</dd>
        <dt>propTrust</dt>
        <dd>{levelText(taint.propTrust)}</dd>
        <dt>conf</dt>
        <dd>{levelText(taint.conf)}</dd>
        <dt>propConf</dt>
        <dd>{levelText(taint.propConf)}</dd>
        {taint.reversible !== undefined && (
          <>
            <dt>reversible</dt>
            <dd>{String(taint.reversible)}</dd>
          </>
        )}
        {taint.risk !== undefined && (
          <>
            <dt>risk</dt>
            <dd>{taint.risk}</dd>
          </>
        )}
        {taint.authority !== undefined && (
          <>
            <dt>authority</dt>
            <dd>{taint.authority}</dd>
          </>
        )}
        <dt>id</dt>
        <dd>{node.step.id}</dd>
      </dl>
      {node.brokenParent !== null && (
        <p className="notice warn">
          {node.brokenParent === 'missing'
            ? t({
                en: `Its parentId names ${node.step.parentId ?? ''}, which is not an instruction in this trace. It is drawn as a root.`,
                zh: `它的 parentId 指向 ${node.step.parentId ?? ''}，而这条 trace 里没有这条指令。此处按根节点绘制。`,
              })
            : t({
                en: 'Following its parentId loops back to this instruction. The link is cut for the layout only — the data is unchanged.',
                zh: '沿它的 parentId 上溯会绕回自身。这条链接仅为排版而断开，数据本身未改。',
              })}
        </p>
      )}
    </section>
  )
}

/**
 * One channel's sentence: what this step claimed, what it ended up with, and
 * who did it. The claim and the jump target are the same node, so a reader can
 * check the assertion rather than take it.
 */
const Propagation: FC<{
  graph: Graph
  node: GraphNode
  channel: Channel
  blame: Blame
  onJump: (index: number) => void
}> = ({ graph, node, channel, blame, onJump }) => {
  const t = useT()
  const field = CHANNEL_FIELDS[channel]
  const own = ownOf(node.step.taint, channel)
  const propagated = propagatedOf(node.step.taint, channel)

  return (
    <section className="tg-block" data-channel={channel}>
      <h4 className="tg-block-title">
        {t(CHANNEL_NAME[channel])} <span className="faint">· {field}</span>
      </h4>

      {blame.kind === 'unstated' && (
        <p className="tg-say">
          {t({
            en: `This package carries no propagated ${field} for this instruction, so nothing can be said about where it came from.`,
            zh: `本数据包没有给这条指令记录传播后的 ${field}，因此无从说明它的来源。`,
          })}
        </p>
      )}

      {blame.kind === 'own' && (
        <p className="tg-say">
          {t({
            en: `Its own ${field} is ${own ?? '—'} and that is what it ended up with: nothing upstream moved it.`,
            zh: `它自身的 ${field} 是 ${own ?? '—'}，传播后也还是这个值：上游没有改变它。`,
          })}
        </p>
      )}

      {blame.kind === 'found' && (
        <>
          <p className="tg-say">
            {t({
              en: `Its own ${field} is ${own ?? '—'}; what it ended up with is ${propagated ?? '—'}. ${CHANNEL_RULE[channel].en}.`,
              zh: `它自身的 ${field} 是 ${own ?? '—'}，传播后变成 ${propagated ?? '—'}。${CHANNEL_RULE[channel].zh}。`,
            })}
          </p>
          <p className="tg-say">
            {blame.via === 'reference'
              ? t({
                  en: `${propagated ?? '—'} comes from the instruction below, reached along reference_tool_id — ${blame.path.length - 1} step${blame.path.length - 1 === 1 ? '' : 's'} upstream. It is lit in the graph, and so is the path to it.`,
                  zh: `${propagated ?? '—'} 来自下面这条指令，沿 reference_tool_id 上溯 ${blame.path.length - 1} 步可达。图中已把它和沿途的路径一起点亮。`,
                })
              : t({
                  en: `No instruction this one references carries ${propagated ?? '—'}, but one it derives from does — reached along parentId, ${blame.path.length - 1} step${blame.path.length - 1 === 1 ? '' : 's'} upstream. It is lit in the graph.`,
                  zh: `它引用的指令里没有带 ${propagated ?? '—'} 的，但它派生自的指令里有——沿 parentId 上溯 ${blame.path.length - 1} 步可达。图中已点亮。`,
                })}
          </p>
          <button type="button" className="btn tg-jump" onClick={() => onJump(blame.at)}>
            <span className="mono">
              #{graph.nodes[blame.at].step.step ?? blame.at + 1}{' '}
              {graph.nodes[blame.at].tool.toolName ?? graph.nodes[blame.at].step.type ?? ''}
            </span>
            <span className="faint">
              · {field} {levelText(ownOf(graph.nodes[blame.at].step.taint, channel))}
            </span>
          </button>
        </>
      )}

      {blame.kind === 'unaccounted' && (
        <p className="notice warn tg-say">
          {t({
            en: `Its own ${field} is ${own ?? '—'} and it ended up with ${propagated ?? '—'}, but no instruction it references or derives from carries ${propagated ?? '—'}. This graph cannot name a source for it: the kernel computed that label from something this trace does not contain.`,
            zh: `它自身的 ${field} 是 ${own ?? '—'}，传播后是 ${propagated ?? '—'}；但它引用或派生自的指令里，没有一条带着 ${propagated ?? '—'}。本图无法指认来源：内核是依据这条 trace 之外的东西算出这个标签的。`,
          })}
        </p>
      )}
    </section>
  )
}

/**
 * The case's verdict, as two facts that must not be collapsed into one.
 *
 * `policies` is what fired; `modified` is whether the response was actually
 * rewritten. `check_response_policy` runs all fifteen registered policies and
 * `enabled` in `policy_registry.json` chooses observe-only or enforce, so a case
 * can trip a policy and still come back untouched. Writing only the second fact
 * would describe the configuration and call it the kernel.
 */
const Verdict: FC<{
  trace: Trace
  judged: GraphNode
  howToReadTheCounts?: string
  onJump: () => void
}> = ({ trace, judged, howToReadTheCounts, onJump }) => {
  const t = useT()
  const { verdict } = trace
  const sources = Object.entries(verdict.policySources)
  // `inactivate_error_type`: the refusal a policy wrote and the kernel did not
  // return. It is the detection, and this panel is the only place a reader can
  // read the words the kernel would have answered with.
  const refusal = wouldBlockOf(trace)

  return (
    <section className="tg-block">
      <h4 className="tg-block-title">
        {t({ en: 'What the policy chain concluded', zh: 'policy 链的结论' })}{' '}
        <span className="faint">
          ·{' '}
          {t({
            en: 'for this case, not for this step',
            zh: '针对整个用例，而非某一步',
          })}
        </span>
      </h4>

      <p className="tg-say">
        {verdict.policies.length === 0
          ? refusal !== ''
            ? t({
                en: 'The kernel recorded no policy name for this case. A policy still concluded that the response should be stopped — what it wrote down is below.',
                zh: '内核没有为这个用例记录任何 policy 名称。但确实有 policy 判定这条响应应当被拦下——它写下的内容在下面。',
              })
            : t({ en: 'No policy fired on this case.', zh: '这个用例没有 policy 命中。' })
          : t({
              en: `${verdict.policies.length} policy name${verdict.policies.length === 1 ? '' : 's'} recorded on this case:`,
              zh: `这个用例上记录到 ${verdict.policies.length} 个 policy 名称：`,
            })}
      </p>
      {verdict.policies.length > 0 && (
        <p className="cluster">
          {verdict.policies.map((one) => (
            <span key={one} className="badge warn mono">
              {one}
            </span>
          ))}
        </p>
      )}

      {/* The "and it does not mean nothing was detected" clause is owed only
          where something *was* detected. On a case where no policy fired at all
          there is nothing to distinguish it from, and printing the caveat
          anyway is how a reader learns to skip it on the cases that need it. */}
      <p className="tg-say">
        {verdict.modified
          ? t({
              en: 'The response was rewritten — this is an interception.',
              zh: '响应被改写了——这是一次真正的拦截。',
            })
          : refusal !== ''
            ? t({
                en: 'The response was not rewritten. This is the split the suite is measuring: a policy judged that it should be stopped, and the registry has that policy registered observe-only — so the kernel wrote the verdict down instead of acting on it and handed back the original response.',
                zh: '响应没有被改写。这正是这套用例要量的那个落差：有 policy 判定它应当被拦下，而注册表把这条 policy 登记为"仅观察"——于是内核把这个判决记了下来而没有执行，把原来的响应原样交了回去。',
              })
            : verdict.policies.length > 0
              ? t({
                  en: 'The response was not rewritten, and no policy judged that it should have been. A recorded policy name is not by itself a detection: a policy can report a match and hand back a response identical to the one it was given.',
                  zh: '响应没有被改写，也没有任何 policy 判定它该被拦下。只记录到 policy 名称并不等于检出：一条 policy 可以报告命中，同时把与原来完全相同的响应交回去。',
                })
              : t({
                  en: 'The response was not rewritten either.',
                  zh: '响应也没有被改写。',
                })}
      </p>

      {/* The response the verdict is about is the last instruction of the
          replay, and on a 41-step case that is ten screens to the right. The
          button is the only way a reader meets the node the verdict marks
          without scrolling the whole graph. */}
      <button type="button" className="btn tg-jump" onClick={onJump}>
        <span className="mono">
          #{judged.step.step ?? judged.index + 1}{' '}
          {judged.tool.toolName ?? judged.step.type ?? ''}
        </span>
        <span className="faint">
          ·{' '}
          {t({
            en: 'the response it judged, last in this case',
            zh: '它判决的那条响应，本用例的最后一条',
          })}
        </span>
      </button>

      {/* The package's own sentence, in the package's own words. */}
      {howToReadTheCounts !== undefined && howToReadTheCounts !== '' && (
        <p className="notice tg-how">
          <span className="faint">
            {t({ en: 'the package on its own counts', zh: '数据包对自己这两个计数的说明' })}
          </span>
          <span>{howToReadTheCounts}</span>
        </p>
      )}

      {/* What was written and withheld, quoted whole. Anything less than the
          text itself would leave the reader taking this adapter's word for the
          one fact the whole suite turns on — and the field does not always hold
          the same kind of thing, which is a reason to show it rather than to
          summarise it: on some cases it is the refusal the caller would have
          received, on others only the kernel's own stand-in line recording that
          a policy would have changed the response. The caption says both, so it
          is true of whichever one is on screen. */}
      {refusal !== '' && (
        <>
          <h5 className="tg-sub-title">
            {t({
              en: 'What the kernel wrote down instead of returning it',
              zh: '内核没有返回它，而是把它记了下来',
            })}{' '}
            <span className="faint">
              ·{' '}
              {t({
                en: 'the kernel’s inactivate_error_type, exactly as recorded — on some cases the refusal itself, on others only the kernel’s line saying a policy would have changed the response. Never translated.',
                zh: '内核的 inactivate_error_type，原样照录——有的用例里是那段拒绝文案本身，有的只有内核自己那句"policy 本会改写这条响应"。不作翻译。',
              })}
            </span>
          </h5>
          <pre className="tg-content">{refusal}</pre>
        </>
      )}

      {verdict.errorType !== null && verdict.errorType !== '' && (
        <>
          <h5 className="tg-sub-title">
            {t({ en: 'What the kernel put in its place', zh: '内核替换成了什么' })}{' '}
            <span className="faint">
              ·{' '}
              {t({
                en: 'the kernel writes this in Chinese; it is quoted, not translated',
                zh: '这段文案由内核用中文硬编码写出，此处原样引用',
              })}
            </span>
          </h5>
          <pre className="tg-content">{verdict.errorType}</pre>
        </>
      )}

      {sources.length > 0 && (
        <details className="tg-details">
          <summary>
            {t({
              en: `Where each policy matched (${sources.length})`,
              zh: `每个 policy 命中在代码的哪一处（${sources.length}）`,
            })}
          </summary>
          <ul className="tg-sources">
            {sources.map(([name, where]) => (
              <li key={name}>
                <span className="mono">{name}</span>
                <pre className="tg-content">{where}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/**
 * The key to both channels, drawn from the same elements the nodes are drawn
 * from — the swatches are `.tg-node` groups, so a change to a node's look is a
 * change to its legend entry and the two cannot drift apart.
 */
const Legend: FC<{ uid: string }> = ({ uid }) => {
  const t = useT()
  const levels: string[] = ['LOW', 'UNKNOWN', 'HIGH']
  return (
    <div className="tg-legend">
      <div className="tg-legend-row">
        <span className="tg-legend-name">
          {t({ en: 'border · trustworthiness', zh: '边框 · 可信度' })}
        </span>
        {levels.map((level) => (
          <span key={level} className="tg-legend-item">
            <Swatch uid={uid} trust={level} conf="LOW" />
            <span className="mono">{levelText(level)}</span>
          </span>
        ))}
      </div>
      <div className="tg-legend-row">
        <span className="tg-legend-name">
          {t({ en: 'fill · confidentiality', zh: '填充 · 机密度' })}
        </span>
        {levels.map((level) => (
          <span key={level} className="tg-legend-item">
            <Swatch uid={uid} trust="unstated" conf={level} />
            <span className="mono">{levelText(level)}</span>
          </span>
        ))}
      </div>
      <div className="tg-legend-row">
        <span className="tg-legend-name">{t({ en: 'on a node', zh: '节点上的写法' })}</span>
        <span className="tg-legend-item mono">trust ◆UNKNOWN→▼LOW</span>
        <span className="tg-legend-item">
          {t({
            en: 'its own label, then what it inherited',
            zh: '自身的标签，然后是继承到的',
          })}
        </span>
      </div>
      <div className="tg-legend-row">
        <span className="tg-legend-name">{t({ en: 'edges', zh: '连线' })}</span>
        <span className="tg-legend-item">
          <svg className="tg-legend-svg" viewBox="0 0 34 14" aria-hidden="true">
            <path className="tg-edge tg-edge-parent" d="M2 7 L30 7" />
          </svg>
          <span className="mono">parentId</span>
        </span>
        <span className="tg-legend-item">
          <svg className="tg-legend-svg" viewBox="0 0 34 14" aria-hidden="true">
            <path className="tg-edge tg-edge-reference" d="M2 11 C2 2 30 2 30 11" />
          </svg>
          <span className="mono">reference_tool_id</span>
        </span>
        <span className="tg-legend-item">
          <svg className="tg-legend-svg" viewBox="0 0 34 14" aria-hidden="true">
            <path className="tg-edge tg-edge-parent" data-lit="trust" d="M2 7 L30 7" />
          </svg>
          <span>
            {t({
              en: 'where the selected label came from',
              zh: '选中节点的标签从哪里来',
            })}
          </span>
        </span>
      </div>
      <div className="tg-legend-row">
        <span className="tg-legend-name">{t({ en: 'marks', zh: '标记' })}</span>
        <span className="tg-legend-item">
          <span className="tg-legend-chip" data-verdict="rewritten" />
          <span>{t({ en: 'response rewritten', zh: '响应被改写' })}</span>
        </span>
        <span className="tg-legend-item">
          <span className="tg-legend-chip" data-verdict="wouldblock" />
          <span>
            {t({
              en: 'a policy would have blocked it, response returned unchanged',
              zh: '有 policy 本会拦下它，响应仍原样返回',
            })}
          </span>
        </span>
        <span className="tg-legend-item">
          <span className="tg-legend-chip" data-verdict="flagged" />
          <span>
            {t({
              en: 'a policy name recorded, nothing stopped',
              zh: '记录到 policy 名称，没有拦截',
            })}
          </span>
        </span>
        <span className="tg-legend-item mono">⚯ / ↺</span>
        <span className="tg-legend-item">
          {t({
            en: 'parentId not in this trace / would loop',
            zh: 'parentId 不在本 trace 内 / 会成环',
          })}
        </span>
      </div>
    </div>
  )
}

const Swatch: FC<{ uid: string; trust: string; conf: string }> = ({ uid, trust, conf }) => {
  const confKey = levelKey(conf)
  return (
    <svg className="tg-swatch" viewBox="0 0 30 16" aria-hidden="true">
      <g className="tg-node" data-trust={levelKey(trust)} data-conf={confKey}>
        <rect className="tg-node-fill" x="1" y="1" width="28" height="14" rx="3" />
        {confKey !== 'low' && (
          <rect
            className="tg-node-texture"
            x="1"
            y="1"
            width="28"
            height="14"
            rx="3"
            fill={`url(#${uid}-${confKey === 'high' ? 'hatch' : 'dots'})`}
          />
        )}
        <rect className="tg-node-box" x="1" y="1" width="28" height="14" rx="3" />
      </g>
    </svg>
  )
}
