/**
 * V1 — the four learning curves.
 *
 * Utility, cost, success and OPR against t, one small multiple each, every
 * learner a line, and the oracle's mean utility as a horizontal reference on
 * the utility panel. The oracle is a ceiling: it is the best any router could
 * have done on this stream, so it is drawn as a rule and never as a ninth line
 * in the legend.
 *
 * Three rules run through the file.
 *
 * A line is *drawn* from a reduced set of points and *read* from all of them.
 * A thousand steps into a 400-unit-wide plot is more than two points per
 * drawing column, so consecutive steps are bucketed and each bucket keeps its
 * lowest and its highest value — the envelope survives at drawing resolution,
 * and the note under the grid says how many points went in and how many came
 * out. The hover readout indexes the full arrays, so a number a reader quotes
 * is never the decimation's.
 *
 * Every figure carries its denominator: a curve is a cumulative mean over
 * steps 1..t averaged over `config.epochs` epochs, and that sentence is under
 * every panel rather than in the paragraph nobody scrolls to.
 *
 * And the data is invented. `provenance.data` is rendered above the charts,
 * where a reader meets it before the first line, not after.
 *
 * No charting library: eight polylines and four axes do not need one, and a
 * canvas would put every number here out of a screen reader's reach — the
 * readout table below the grid is the same data in a form that can be read.
 */

import { useId, useMemo, useState } from 'react'
import type { CSSProperties, FC, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import type { PromptWiseModel, Run } from './contract'
import './charts.css'

/* ------------------------------------------------------------ series style */

/**
 * Colour and dash are assigned by position in `model.runs`, never by learner
 * name — the names are the runner's data and this file knows none of them. 8
 * colours against 5 dash patterns repeat only after 40 lines, and the dash is
 * what keeps two learners apart on a projector, in greyscale, and for a reader
 * who cannot separate the blue from the purple.
 */
const SERIES_COLOURS = 8
const DASHES = ['', '7 3', '2 3', '11 3 2 3', '1 4']

function colourOf(index: number): string {
  return `var(--pw-series-${(index % SERIES_COLOURS) + 1})`
}

function dashOf(index: number): string {
  return DASHES[index % DASHES.length]
}

/* ------------------------------------------------------------------ layout */

/** viewBox units. The rendered box takes this aspect exactly — see `.pw-plot`. */
const PLOT = { width: 470, height: 250, left: 54, right: 16, top: 10, bottom: 34 }
const INNER_W = PLOT.width - PLOT.left - PLOT.right
const INNER_H = PLOT.height - PLOT.top - PLOT.bottom

/* ------------------------------------------------------------------ scales */

interface Domain {
  lo: number
  hi: number
  ticks: number[]
  /** Decimals the ticks need to print exactly, so an axis never shows 0.30000000004. */
  decimals: number
}

/** 1 / 2 / 2.5 / 5 / 10 × a power of ten — the smallest step giving at most `target` intervals. */
function niceStep(span: number, target: number): number {
  if (!(span > 0)) return 1
  const raw = span / Math.max(1, target)
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const factor of [1, 2, 2.5, 5]) {
    if (raw <= factor * magnitude) return factor * magnitude
  }
  return 10 * magnitude
}

function decimalsFor(step: number): number {
  for (let d = 0; d <= 6; d += 1) {
    const scaled = step * Math.pow(10, d)
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return d
  }
  return 6
}

function niceDomain(min: number, max: number, target = 5): Domain {
  let lo = Number.isFinite(min) ? min : 0
  let hi = Number.isFinite(max) ? max : 1
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi === lo) {
    const pad = Math.abs(hi) > 0 ? Math.abs(hi) * 0.1 : 1
    lo -= pad
    hi += pad
  }
  const step = niceStep(hi - lo, target)
  const start = Math.floor(lo / step) * step
  const end = Math.ceil(hi / step) * step
  const count = Math.max(1, Math.round((end - start) / step))
  const decimals = decimalsFor(step)
  const ticks: number[] = []
  for (let i = 0; i <= count; i += 1) ticks.push(Number((start + i * step).toFixed(decimals + 2)))
  return { lo: start, hi: end, ticks, decimals }
}

/** Exactly the domain asked for, ticked — for an axis whose ends are meaningful. */
function fixedDomain(lo: number, hi: number, count: number, decimals: number): Domain {
  const ticks: number[] = []
  for (let i = 0; i <= count; i += 1) ticks.push(Number((lo + ((hi - lo) * i) / count).toFixed(decimals + 2)))
  return { lo, hi, ticks, decimals }
}

function scaleX(value: number, domain: Domain): number {
  const span = domain.hi - domain.lo || 1
  return PLOT.left + ((value - domain.lo) / span) * INNER_W
}

function scaleY(value: number, domain: Domain): number {
  const span = domain.hi - domain.lo || 1
  return PLOT.top + INNER_H - ((value - domain.lo) / span) * INNER_H
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/* -------------------------------------------------------------- decimation */

type Sample = [number, number] | null

/**
 * Buckets of consecutive steps, each contributing its lowest and its highest
 * value in the order they occurred, plus both ends of the series. Keeping every
 * k-th point instead would flatten a spike that fell between two kept points;
 * keeping each bucket's extremes cannot, which is the only reason it is honest
 * to draw fewer points than the package holds.
 */
function decimate(t: readonly number[], v: readonly number[], columns: number): Sample[] {
  const n = Math.min(t.length, v.length)
  const out: Sample[] = []
  if (n === 0) return out
  const point = (i: number): Sample => (Number.isFinite(t[i]) && Number.isFinite(v[i]) ? [t[i], v[i]] : null)

  if (n <= columns * 2) {
    for (let i = 0; i < n; i += 1) out.push(point(i))
    return out
  }

  for (let c = 0; c < columns; c += 1) {
    const start = Math.floor((c * n) / columns)
    const end = Math.max(start + 1, Math.floor(((c + 1) * n) / columns))
    let lowest = -1
    let highest = -1
    for (let i = start; i < end && i < n; i += 1) {
      if (!Number.isFinite(v[i]) || !Number.isFinite(t[i])) continue
      if (lowest < 0 || v[i] < v[lowest]) lowest = i
      if (highest < 0 || v[i] > v[highest]) highest = i
    }
    if (lowest < 0) {
      out.push(null)
      continue
    }
    const first = Math.min(lowest, highest)
    const second = Math.max(lowest, highest)
    out.push(point(first))
    if (second !== first) out.push(point(second))
  }

  // The two ends are what a reader checks against the readout, so they are
  // never a bucket's casualty.
  const head = out.find((one) => one !== null)
  if (head && head[0] !== t[0]) out.unshift(point(0))
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const tail = out[i]
    if (!tail) continue
    if (tail[0] !== t[n - 1]) out.push(point(n - 1))
    break
  }
  return out
}

function pathOf(samples: readonly Sample[], x: (v: number) => number, y: (v: number) => number): string {
  let d = ''
  let pen = false
  for (const sample of samples) {
    if (!sample) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${x(sample[0]).toFixed(2)} ${y(sample[1]).toFixed(2)}`
    pen = true
  }
  return d
}

/** Nearest index in an ascending array. The t axes here are step counters. */
function nearestIndex(values: readonly number[], target: number): number {
  if (values.length === 0) return -1
  let lo = 0
  let hi = values.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (values[mid] < target) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(values[lo - 1] - target) <= Math.abs(values[lo] - target)) return lo - 1
  return lo
}

/* ----------------------------------------------------------------- metrics */

type MetricKey = 'utility' | 'cost' | 'success' | 'opr'

interface Metric {
  key: MetricKey
  title: Str
  what: Str
  decimals: number
  /** A rate lives in [0,1]; cost and utility do not, so an empty panel is scaled differently. */
  rate: boolean
}

/**
 * The contract's field name, and the word the runner, the paper and this
 * project's own Chinese notes all use for these algorithms. It stays a `Str` so
 * that the decision not to translate it is in the type, not in a memory.
 */
const LEARNER: Str = { en: 'learner', zh: 'learner' }

/** Utility's precision, quoted in two places: the panel and the oracle's row. */
const UTILITY_DECIMALS = 4

const METRICS: Metric[] = [
  {
    key: 'utility',
    title: { en: 'Utility', zh: '效用' },
    what: { en: 'the quantity the router maximises', zh: '路由器要最大化的那个量' },
    decimals: UTILITY_DECIMALS,
    rate: false,
  },
  {
    key: 'cost',
    title: { en: 'Cost', zh: '成本' },
    what: {
      en: 'spent per prompt, in the units models[].cost uses',
      zh: '每题花费，单位与 models[].cost 一致',
    },
    decimals: 3,
    rate: false,
  },
  {
    key: 'success',
    title: { en: 'Success', zh: '成功率' },
    what: {
      en: 'share of prompts solved before the router gave up or ran out of rounds',
      zh: '在放弃或用尽轮次之前解出的题目占比',
    },
    decimals: 4,
    rate: true,
  },
  {
    key: 'opr',
    title: { en: 'OPR', zh: 'OPR' },
    what: {
      en: 'optimal-pick rate: how often the arm chosen was one an oracle would pick',
      zh: '最优臂命中率：所选的臂正好是 oracle 会选的那个的频率',
    },
    decimals: 4,
    rate: true,
  },
]

function seriesOf(run: Run, key: MetricKey): readonly number[] {
  return run.curves?.[key] ?? []
}

function fixed(value: number | undefined, decimals: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : '—'
}

/**
 * `utility = success − cost_para × cost`, checked rather than asserted.
 *
 * It is what the objective implies and what makes the utility panel readable
 * beside the other three, but it is the runner's arithmetic and not ours. So it
 * is measured on every point of every curve, and the sentence explaining the
 * panel is only shown when the measurement holds.
 */
const IDENTITY_TOLERANCE = 5e-4

function utilityIdentityGap(runs: readonly Run[], costPara: number): number | null {
  if (!Number.isFinite(costPara)) return null
  let worst = -1
  for (const run of runs) {
    const t = run.curves?.t ?? []
    const utility = run.curves?.utility ?? []
    const cost = run.curves?.cost ?? []
    const success = run.curves?.success ?? []
    const n = Math.min(t.length, utility.length, cost.length, success.length)
    for (let i = 0; i < n; i += 1) {
      const gap = Math.abs(success[i] - costPara * cost[i] - utility[i])
      if (!Number.isFinite(gap)) return null
      if (gap > worst) worst = gap
    }
  }
  return worst < 0 ? null : worst
}

/* ------------------------------------------------------------------- panel */

interface PanelLine {
  index: number
  d: string
}

interface PanelData {
  metric: Metric
  yDomain: Domain
  lines: PanelLine[]
  /** Points held, and points drawn, for the busiest line in this panel. */
  held: number
  drawn: number
}

const Panel: FC<{
  panel: PanelData
  xDomain: Domain
  /** A t the package actually holds, or null when nothing is being pointed at. */
  cursor: number | null
  cursorValues: { index: number; value: number | undefined }[]
  oracle: number[]
  labelledBy: string
  onCursor: (t: number | null) => void
}> = ({ panel, xDomain, cursor, cursorValues, oracle, labelledBy, onCursor }) => {
  const t = useT()
  const { metric, yDomain, lines } = panel

  const pointerT = (event: ReactPointerEvent<SVGSVGElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return null
    // The rendered box is the viewBox's aspect exactly, so one multiply inverts it.
    const units = (event.clientX - rect.left) * (PLOT.width / rect.width)
    const ratio = clamp((units - PLOT.left) / INNER_W, 0, 1)
    return xDomain.lo + ratio * (xDomain.hi - xDomain.lo)
  }

  return (
    <svg
      className="pw-plot"
      viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-labelledby={labelledBy}
      onPointerMove={(event) => onCursor(pointerT(event))}
      onPointerLeave={() => onCursor(null)}
    >
      {yDomain.ticks.map((tick) => (
        <g key={`y${tick}`}>
          <line
            className="pw-gridline"
            x1={PLOT.left}
            x2={PLOT.left + INNER_W}
            y1={scaleY(tick, yDomain)}
            y2={scaleY(tick, yDomain)}
          />
          <text className="pw-tick-label" x={PLOT.left - 6} y={scaleY(tick, yDomain)} textAnchor="end" dy="0.32em">
            {tick.toFixed(yDomain.decimals)}
          </text>
        </g>
      ))}

      {xDomain.ticks.map((tick) => (
        <g key={`x${tick}`}>
          <line
            className="pw-gridline"
            y1={PLOT.top}
            y2={PLOT.top + INNER_H}
            x1={scaleX(tick, xDomain)}
            x2={scaleX(tick, xDomain)}
          />
          <text className="pw-tick-label" x={scaleX(tick, xDomain)} y={PLOT.top + INNER_H + 14} textAnchor="middle">
            {tick.toFixed(xDomain.decimals)}
          </text>
        </g>
      ))}

      <line
        className="pw-axis-line"
        x1={PLOT.left}
        x2={PLOT.left + INNER_W}
        y1={PLOT.top + INNER_H}
        y2={PLOT.top + INNER_H}
      />
      <line className="pw-axis-line" x1={PLOT.left} x2={PLOT.left} y1={PLOT.top} y2={PLOT.top + INNER_H} />
      <text className="pw-axis-title" x={PLOT.left + INNER_W} y={PLOT.height - 4} textAnchor="end">
        {t({ en: 't — steps seen', zh: 't —— 已见步数' })}
      </text>

      {/* The oracle is a rule across the panel, labelled a ceiling, drawn under
          the learners so it never hides one of them. */}
      {oracle.map((value) => {
        const y = scaleY(value, yDomain)
        const above = y - 5 > PLOT.top + 10
        return (
          <g key={`oracle${value}`}>
            <line className="pw-oracle-line" x1={PLOT.left} x2={PLOT.left + INNER_W} y1={y} y2={y} />
            <text className="pw-oracle-label" x={PLOT.left + 4} y={above ? y - 5 : y + 12}>
              {`${t({ en: 'oracle ceiling', zh: 'oracle 上界' })} ${value.toFixed(metric.decimals)}`}
            </text>
          </g>
        )
      })}

      {lines.map((line) => (
        <path
          key={line.index}
          className="pw-line"
          d={line.d}
          style={{ stroke: colourOf(line.index) } as CSSProperties}
          strokeDasharray={dashOf(line.index) || undefined}
        />
      ))}

      {lines.length === 0 && (
        <text className="pw-plot-empty" x={PLOT.left + INNER_W / 2} y={PLOT.top + INNER_H / 2} textAnchor="middle">
          {t({ en: 'every line is hidden', zh: '所有线条都被隐藏了' })}
        </text>
      )}

      {cursor !== null && lines.length > 0 && (
        <g>
          <line
            className="pw-cursor-line"
            x1={scaleX(cursor, xDomain)}
            x2={scaleX(cursor, xDomain)}
            y1={PLOT.top}
            y2={PLOT.top + INNER_H}
          />
          {cursorValues.map(({ index, value }) =>
            typeof value === 'number' && Number.isFinite(value) ? (
              <circle
                key={index}
                className="pw-cursor-dot"
                cx={scaleX(cursor, xDomain)}
                cy={scaleY(value, yDomain)}
                r={3}
                style={{ fill: colourOf(index) } as CSSProperties}
              />
            ) : null,
          )}
        </g>
      )}
    </svg>
  )
}

/* -------------------------------------------------------------------- view */

export const Curves: FC<{ model: PromptWiseModel }> = ({ model }) => {
  const t = useT()
  const uid = useId()
  // Memoised because `?? []` would otherwise hand every memo below a new empty
  // array on each render, and each of them walks eight thousand points.
  const runs = useMemo(() => model.runs ?? [], [model.runs])

  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set())
  const [cursor, setCursor] = useState<number | null>(null)

  // A different package is a different set of learners, so a line hidden in the
  // last one must not blank an unrelated line in this one. Adjusted during
  // render rather than in an effect, which would paint the wrong state first.
  const [lastModel, setLastModel] = useState(model)
  if (model !== lastModel) {
    setLastModel(model)
    setHidden(new Set())
    setCursor(null)
  }

  const visible = useMemo(
    () => runs.map((run, index) => ({ run, index })).filter(({ index }) => !hidden.has(index)),
    [runs, hidden],
  )

  /** The longest t array present — what a cursor snaps to, and what x spans. */
  const tAxis = useMemo(() => {
    let longest: readonly number[] = []
    for (const run of runs) {
      const axis = run.curves?.t ?? []
      if (axis.length > longest.length) longest = axis
    }
    return longest
  }, [runs])

  const xDomain = useMemo(
    () => (tAxis.length === 0 ? fixedDomain(0, 1, 1, 0) : niceDomain(tAxis[0], tAxis[tAxis.length - 1], 4)),
    [tAxis],
  )

  const panels = useMemo<PanelData[]>(() => {
    const columns = Math.round(INNER_W)
    return METRICS.map((metric) => {
      let min = Infinity
      let max = -Infinity
      let held = 0
      let drawn = 0

      const prepared = visible.map(({ run, index }) => {
        const axis = run.curves?.t ?? []
        const values = seriesOf(run, metric.key)
        const n = Math.min(axis.length, values.length)
        for (let i = 0; i < n; i += 1) {
          const value = values[i]
          if (!Number.isFinite(value)) continue
          if (value < min) min = value
          if (value > max) max = value
        }
        const samples = decimate(axis, values, columns)
        held = Math.max(held, n)
        drawn = Math.max(drawn, samples.reduce((count, one) => (one ? count + 1 : count), 0))
        return { index, samples }
      })

      // A ceiling drawn off the top of the panel is a ceiling nobody can check
      // against the lines, so the oracle widens the utility domain.
      if (metric.key === 'utility') {
        for (const { run } of visible) {
          if (Number.isFinite(run.oracleUtility)) {
            min = Math.min(min, run.oracleUtility)
            max = Math.max(max, run.oracleUtility)
          }
        }
      }

      const yDomain =
        prepared.length === 0 ? (metric.rate ? fixedDomain(0, 1, 5, 1) : niceDomain(0, 1)) : niceDomain(min, max)

      const lines: PanelLine[] = prepared.map(({ index, samples }) => ({
        index,
        d: pathOf(
          samples,
          (value) => scaleX(value, xDomain),
          (value) => scaleY(value, yDomain),
        ),
      }))

      return { metric, yDomain, lines, held, drawn }
    })
  }, [visible, xDomain])

  /** Distinct across runs: one rule when the runs agree, one per value when they do not. */
  const oracleValues = useMemo(() => {
    const seen: number[] = []
    for (const run of runs) {
      const value = run.oracleUtility
      if (!Number.isFinite(value)) continue
      if (!seen.some((one) => Math.abs(one - value) < 1e-9)) seen.push(value)
    }
    return seen.sort((a, b) => a - b)
  }, [runs])

  /** Snapped to a step the package holds, so the readout is a row and not an interpolation. */
  const cursorT = useMemo(
    () => (cursor === null || tAxis.length === 0 ? null : tAxis[nearestIndex(tAxis, cursor)]),
    [cursor, tAxis],
  )

  const readAt = cursorT ?? (tAxis.length > 0 ? tAxis[tAxis.length - 1] : null)

  const rows = useMemo(() => {
    if (readAt === null) return []
    return visible.map(({ run, index }) => {
      const axis = run.curves?.t ?? []
      const at = nearestIndex(axis, readAt)
      const value = (key: MetricKey): number | undefined => {
        const series = seriesOf(run, key)
        return at >= 0 && at < series.length ? series[at] : undefined
      }
      return {
        index,
        learner: run.learner,
        utility: value('utility'),
        cost: value('cost'),
        success: value('success'),
        opr: value('opr'),
      }
    })
  }, [visible, readAt])

  const identityGap = useMemo(
    () => utilityIdentityGap(runs, model.config?.costPara ?? Number.NaN),
    [runs, model.config?.costPara],
  )

  const moveCursor = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (tAxis.length === 0) return
    const current = cursorT === null ? tAxis.length - 1 : nearestIndex(tAxis, cursorT)
    const stride = event.shiftKey ? 25 : 1
    let next = current
    if (event.key === 'ArrowLeft') next = current - stride
    else if (event.key === 'ArrowRight') next = current + stride
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tAxis.length - 1
    else if (event.key === 'Escape') {
      setCursor(null)
      return
    } else return
    event.preventDefault()
    setCursor(tAxis[clamp(next, 0, tAxis.length - 1)])
  }

  if (runs.length === 0) {
    return (
      <div className="pw-view">
        <div className="pw-inner">
          <Provenance data={model.provenance?.data} note={model.provenance?.note} />
          <p className="pw-empty">{t({ en: 'This package holds no runs.', zh: '这个数据包里没有任何 run。' })}</p>
        </div>
      </div>
    )
  }

  const epochs = model.config?.epochs
  const held = Math.max(...panels.map((panel) => panel.held))
  const drawn = Math.max(...panels.map((panel) => panel.drawn))
  const hiddenCount = runs.length - visible.length

  return (
    <div className="pw-view">
      <div className="pw-inner">
        <header className="pw-head">
          <h2>{t({ en: 'Learning curves', zh: '学习曲线' })}</h2>
          <p className="pw-lede">
            {t({
              en: 'Four cumulative means against t, every learner a line. The oracle sits on the utility panel as a horizontal rule — the best any router could have done on this stream, not a competitor in the race.',
              zh: '四条累计均值对 t 的曲线，每个 learner 一条线。oracle 以水平参考线画在效用面板上 —— 它是任何路由器在这条题流上的上界，不是同场竞技的对手。',
            })}
          </p>
          <ul className="pw-facts">
            <Fact label={{ en: 'learners', zh: 'learner 数' }} value={runs.length.toLocaleString()} />
            {typeof model.config?.steps === 'number' && (
              <Fact label={{ en: 'steps', zh: '步数' }} value={model.config.steps.toLocaleString()} />
            )}
            {typeof epochs === 'number' && (
              <Fact label={{ en: 'epochs averaged', zh: '取平均的轮数' }} value={epochs.toLocaleString()} />
            )}
            {typeof model.config?.costPara === 'number' && (
              <Fact label={{ en: 'cost_para (λ)', zh: 'cost_para（λ）' }} value={String(model.config.costPara)} />
            )}
            {typeof model.config?.rdBudget === 'number' && (
              <Fact label={{ en: 'rounds per prompt', zh: '每题轮次上限' }} value={String(model.config.rdBudget)} />
            )}
            {typeof model.config?.seed === 'number' && (
              <Fact label={{ en: 'seed', zh: '随机种子' }} value={String(model.config.seed)} />
            )}
          </ul>
        </header>

        <Provenance data={model.provenance?.data} note={model.provenance?.note} />

        <div
          className="pw-legend"
          role="group"
          aria-label={t({ en: 'Show or hide a learner', zh: '显示或隐藏某个 learner' })}
        >
          {runs.map((run, index) => {
            const shown = !hidden.has(index)
            return (
              <button
                key={index}
                type="button"
                className="pw-legend-item"
                aria-pressed={shown}
                onClick={() =>
                  setHidden((current) => {
                    const next = new Set(current)
                    if (shown) next.add(index)
                    else next.delete(index)
                    return next
                  })
                }
              >
                <svg className="pw-legend-swatch" viewBox="0 0 26 10" aria-hidden="true">
                  <line
                    className="pw-line"
                    x1="1"
                    x2="25"
                    y1="5"
                    y2="5"
                    style={{ stroke: shown ? colourOf(index) : 'var(--text-faint)' } as CSSProperties}
                    strokeDasharray={dashOf(index) || undefined}
                  />
                </svg>
                {/* The learner's name is the runner's own string, never translated. */}
                <span className="pw-legend-name">{run.learner}</span>
              </button>
            )
          })}
          {hiddenCount > 0 && (
            <button type="button" className="ghost" onClick={() => setHidden(new Set())}>
              {t({ en: 'Show all', zh: '全部显示' })}
            </button>
          )}
          <span className="pw-legend-hint">
            {t({
              en: 'Colour and dash both name the line, so the figure survives greyscale.',
              zh: '颜色和虚线样式共同标识一条线，因此转成灰度也读得出来。',
            })}
          </span>
        </div>

        {/* One tab stop for the whole grid: four panels that share one cursor are
            one control, and four stops would be four ways to move the same thing. */}
        <div
          className="pw-plot-frame"
          role="group"
          tabIndex={0}
          onKeyDown={moveCursor}
          aria-label={t({
            en: 'Four learning-curve panels. Arrow keys move the read-out cursor along t; Escape clears it.',
            zh: '四个学习曲线面板。方向键沿 t 移动读数游标，Esc 取消。',
          })}
        >
          <div className="pw-grid">
            {panels.map((panel) => {
              const captionId = `${uid}-${panel.metric.key}`
              return (
                <figure className="pw-figure" key={panel.metric.key}>
                  <figcaption className="pw-figcap" id={captionId}>
                    <span className="pw-figcap-title">{t(panel.metric.title)}</span>
                    <span className="pw-figcap-line">{t(panel.metric.what)}</span>
                    <span className="pw-figcap-line">
                      {t({
                        en: `cumulative mean over steps 1..t${typeof epochs === 'number' ? `, averaged over ${epochs} epochs` : ''}`,
                        zh: `前 t 步的累计均值${typeof epochs === 'number' ? `，并对 ${epochs} 轮取平均` : ''}`,
                      })}
                    </span>
                  </figcaption>
                  <Panel
                    panel={panel}
                    xDomain={xDomain}
                    cursor={cursorT}
                    cursorValues={rows.map((row) => ({ index: row.index, value: row[panel.metric.key] }))}
                    oracle={panel.metric.key === 'utility' ? oracleValues : []}
                    labelledBy={captionId}
                    onCursor={setCursor}
                  />
                </figure>
              )
            })}
          </div>
        </div>

        {drawn < held && (
          <p className="pw-note">
            {t({
              en: `Drawn from ${drawn.toLocaleString()} of the ${held.toLocaleString()} points each line holds: consecutive steps are bucketed by drawing column, and every bucket keeps its lowest and its highest value, so the envelope survives at drawing resolution and both ends are kept. The read-out below indexes all ${held.toLocaleString()}.`,
              zh: `每条线握有 ${held.toLocaleString()} 个点，图上画的是其中 ${drawn.toLocaleString()} 个：相邻步按绘图列分桶，每桶保留最低值与最高值，因此在绘图分辨率下曲线的包络不变，两端也一定保留。下方读数仍取自全部 ${held.toLocaleString()} 个点。`,
            })}
          </p>
        )}

        {identityGap !== null && identityGap <= IDENTITY_TOLERANCE && (
          <p className="pw-note">
            {t({
              en: `On these curves utility = success − cost_para × cost holds at every step, worst gap ${identityGap.toExponential(1)} — so the utility panel is the other two combined, and a learner climbs it only by getting more right or by paying less.`,
              zh: `在这些曲线上，效用 = 成功率 − cost_para × 成本 每一步都成立，最大偏差 ${identityGap.toExponential(1)} —— 所以效用面板就是另外两个面板的合成：learner 想往上走，只能靠做对更多题、或者花更少的钱。`,
            })}
          </p>
        )}

        <section className="pw-readout">
          <div className="pw-readout-head">
            <span className="pw-readout-t" aria-live="polite">
              {readAt === null ? '—' : `t = ${readAt.toLocaleString()}`}
            </span>
            <span className="pw-readout-note">
              {cursorT === null
                ? t({
                    en: 'the last step — hover a panel, or focus the grid and use ← → (Shift for 25, Home/End for the ends)',
                    zh: '当前是最后一步 —— 把指针移到面板上，或聚焦图组后按 ← →（按住 Shift 一次走 25，Home/End 到两端）',
                  })
                : t({
                    en: 'read from every point the package holds, not from the drawn line',
                    zh: '读数取自数据包的全部点，而不是画出来的那条线',
                  })}
            </span>
            {hiddenCount > 0 && (
              <span className="pw-readout-note">
                {t({
                  en: `${hiddenCount} hidden in the legend`,
                  zh: `图例中另有 ${hiddenCount} 个被隐藏`,
                })}
              </span>
            )}
          </div>
          <div
            className="pw-wide"
            role="group"
            tabIndex={0}
            aria-label={t({ en: 'Every learner at this t', zh: '该 t 处每个 learner 的值' })}
          >
            <table className="pw-table">
              <thead>
                <tr>
                  <th scope="col">{t(LEARNER)}</th>
                  {METRICS.map((metric) => (
                    <th scope="col" className="num" key={metric.key}>
                      {t(metric.title)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.index}>
                    <th scope="row">
                      <span className="pw-name">
                        <svg className="pw-chip" viewBox="0 0 18 8" aria-hidden="true">
                          <line
                            className="pw-line"
                            x1="1"
                            x2="17"
                            y1="4"
                            y2="4"
                            style={{ stroke: colourOf(row.index) } as CSSProperties}
                            strokeDasharray={dashOf(row.index) || undefined}
                          />
                        </svg>
                        {row.learner}
                      </span>
                    </th>
                    {METRICS.map((metric) => (
                      <td className="num" key={metric.key}>
                        {fixed(row[metric.key], metric.decimals)}
                      </td>
                    ))}
                  </tr>
                ))}
                {oracleValues.map((value) => (
                  <tr className="pw-oracle-row" key={`oracle${value}`}>
                    <th scope="row">
                      <span className="pw-name">{t({ en: 'oracle ceiling', zh: 'oracle 上界' })}</span>
                    </th>
                    <td className="num">{value.toFixed(UTILITY_DECIMALS)}</td>
                    <td className="pw-blank" colSpan={3}>
                      {t({
                        en: 'the package gives the oracle a utility and nothing else',
                        zh: '数据包只给了 oracle 的效用，没有别的指标',
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pw-note">
            {t({
              en: 'Every figure in this table is a cumulative mean over the steps up to t, not the value at t alone.',
              zh: '表里每个数都是到 t 为止的累计均值，不是第 t 步单独的值。',
            })}
          </p>
        </section>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- fragments */

const Fact: FC<{ label: Str; value: string }> = ({ label, value }) => {
  const t = useT()
  return (
    <li className="pw-fact">
      <span>{t(label)}</span>
      {/* The value is the package's own number; it is quoted, not restyled. */}
      <span className="pw-fact-value">{value}</span>
    </li>
  )
}

/**
 * What the numbers are over, above the charts and not below them.
 *
 * The text is the runner's, verbatim: it is the sentence that says these curves
 * are over invented data, and paraphrasing it here would be this view putting
 * words in the package's mouth.
 */
const Provenance: FC<{ data?: string; note?: string }> = ({ data, note }) => {
  const t = useT()
  return (
    <aside className="pw-prov">
      <span className="pw-prov-label">{t({ en: 'What this data is', zh: '这些数据是什么' })}</span>
      {data ? (
        <p className="pw-prov-text">{data}</p>
      ) : (
        <p className="pw-prov-text">
          {t({
            en: 'The package says nothing about what its data is — read these curves as unattributed until it does.',
            zh: '数据包没有说明它的数据是什么 —— 在它说明之前，请把这些曲线当作来源不明。',
          })}
        </p>
      )}
      {note && <p className="pw-prov-text">{note}</p>}
    </aside>
  )
}
