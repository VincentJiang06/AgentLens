/**
 * V2 — the cost/success plane, one point per learner.
 *
 * This is the figure that goes in an email, which decides almost everything
 * about it. It carries its own caption — what the axes are, how many steps and
 * epochs each point is over, and what the package says its data is — because a
 * screenshot travels without the page around it. It is drawn at a size that
 * survives being pasted into a mail client: eight labelled dots, no legend to
 * cross-reference, and a table underneath with the exact numbers.
 *
 * Two honesty rules shaped the drawing.
 *
 * The success axis is the full 0..1 of a rate. A truncated y would make the
 * gaps between learners look larger than they are, and this figure exists to
 * make a claim about those gaps.
 *
 * The oracle is not a point. The package gives it a utility and no cost and no
 * success, so there is no (x, y) to put it at, and inventing one would be a
 * fabricated data point in the one figure most likely to be reproduced
 * elsewhere. Where `utility = success − cost_para × cost` holds — checked here,
 * not assumed — a utility is a *line* in this plane, so the oracle is drawn as
 * the line of every (cost, success) pair that would have matched it. That is
 * what a ceiling looks like on these axes.
 *
 * No charting library: this is one circle per learner and a handful of straight
 * lines.
 */

import { useId, useMemo, useState } from 'react'
import type { CSSProperties, FC } from 'react'
import { useT } from '../../shell/lang'
import type { Str } from '../../shell/lang'
import type { PromptWiseModel, Run } from './contract'
import './charts.css'

/* ------------------------------------------------------------ series style */

/** Same assignment rule as the curves: by position in `model.runs`, never by name. */
const SERIES_COLOURS = 8

function colourOf(index: number): string {
  return `var(--pw-series-${(index % SERIES_COLOURS) + 1})`
}

/* ------------------------------------------------------------------ layout */

const PLOT = { width: 680, height: 430, left: 58, right: 24, top: 34, bottom: 46 }
const INNER_W = PLOT.width - PLOT.left - PLOT.right
const INNER_H = PLOT.height - PLOT.top - PLOT.bottom

/** Point radii, in viewBox units. The floor is what keeps a worst learner visible. */
const R_MIN = 4.5
const R_MAX = 14

const LABEL_SIZE = 11
const LABEL_GAP = 13

/**
 * Two words this view sets in both languages unchanged: `learner` is the
 * contract's field name and the word the runner, the paper and this project's
 * own Chinese notes all use, and OPR is the paper's acronym. They are still
 * `Str`s, so the decision is in the type rather than in a reviewer's memory.
 */
const TERM = {
  learner: { en: 'learner', zh: 'learner' } satisfies Str,
  opr: { en: 'OPR', zh: 'OPR' } satisfies Str,
}

/* ------------------------------------------------------------------ scales */

interface Domain {
  lo: number
  hi: number
  ticks: number[]
  decimals: number
}

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

/** From zero to a round number past the largest value — cost has a meaningful zero. */
function costDomain(max: number, target = 5): Domain {
  const top = Number.isFinite(max) && max > 0 ? max : 1
  const step = niceStep(top, target)
  const end = Math.ceil(top / step) * step
  const count = Math.max(1, Math.round(end / step))
  const decimals = decimalsFor(step)
  const ticks: number[] = []
  for (let i = 0; i <= count; i += 1) ticks.push(Number((i * step).toFixed(decimals + 2)))
  return { lo: 0, hi: end, ticks, decimals }
}

/** A rate gets its whole range. Nothing here is allowed to exaggerate a gap. */
const SUCCESS_DOMAIN: Domain = { lo: 0, hi: 1, ticks: [0, 0.2, 0.4, 0.6, 0.8, 1], decimals: 1 }

function scaleX(value: number, domain: Domain): number {
  const span = domain.hi - domain.lo || 1
  return PLOT.left + ((value - domain.lo) / span) * INNER_W
}

function scaleY(value: number, domain: Domain): number {
  const span = domain.hi - domain.lo || 1
  return PLOT.top + INNER_H - ((value - domain.lo) / span) * INNER_H
}

/* --------------------------------------------------------- utility as a line */

/**
 * `utility = success − cost_para × cost`, measured on the finals themselves.
 *
 * Everything the figure says about utility depends on this: the iso-utility
 * guides, the oracle's line, and the sentence explaining the point sizes. It is
 * the runner's arithmetic, so it is checked against the runner's own numbers,
 * and when it does not hold the guides and the oracle line are not drawn at
 * all — a figure with no ceiling on it beats a figure with the wrong one.
 */
const IDENTITY_TOLERANCE = 5e-4

function utilityIdentityGap(runs: readonly Run[], costPara: number): number | null {
  if (!Number.isFinite(costPara)) return null
  let worst = -1
  for (const run of runs) {
    const final = run.final
    if (!final) continue
    const gap = Math.abs(final.success - costPara * final.cost - final.utility)
    if (!Number.isFinite(gap)) return null
    if (gap > worst) worst = gap
  }
  return worst < 0 ? null : worst
}

interface Segment {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** The segment of `success = utility + cost_para × cost` inside the plot, or null. */
function isoSegment(utility: number, costPara: number, x: Domain, y: Domain): Segment | null {
  let lo = x.lo
  let hi = x.hi
  if (costPara > 0) {
    lo = Math.max(lo, (y.lo - utility) / costPara)
    hi = Math.min(hi, (y.hi - utility) / costPara)
  } else if (costPara < 0) {
    lo = Math.max(lo, (y.hi - utility) / costPara)
    hi = Math.min(hi, (y.lo - utility) / costPara)
  } else if (utility < y.lo || utility > y.hi) {
    return null
  }
  if (!(hi > lo)) return null
  return {
    x1: scaleX(lo, x),
    y1: scaleY(utility + costPara * lo, y),
    x2: scaleX(hi, x),
    y2: scaleY(utility + costPara * hi, y),
  }
}

/* ------------------------------------------------------------- label layout */

/** Rough advance width. CJK is full-width; everything else is about 0.58 em. */
function textWidth(text: string, size: number): number {
  let units = 0
  for (const char of text) units += (char.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.58
  return units * size
}

/**
 * A label beside a point on the plot: to the right of it, or to the left when
 * the right would put it outside the frame. SVG text does not wrap and does not
 * clip to anything, so a label that overflows here overflows the whole figure.
 */
function beside(x: number, text: string, size: number): { x: number; anchor: 'start' | 'end' } {
  const width = textWidth(text, size)
  return x + 4 + width <= PLOT.left + INNER_W ? { x: x + 4, anchor: 'start' } : { x: x - 4, anchor: 'end' }
}

interface Point {
  index: number
  learner: string
  cost: number
  success: number
  utility: number
  opr: number
  cx: number
  cy: number
  r: number
}

interface Label {
  index: number
  x: number
  y: number
  anchor: 'start' | 'end'
  /** Set when decluttering moved the label off its point, so a leader is drawn. */
  leader: boolean
}

/**
 * Names beside the dots, pushed apart vertically when they collide.
 *
 * A legend would make the reader carry eight colours across the figure; a name
 * on the dot is what makes the screenshot readable on its own. Labels are laid
 * out per side so a push never crosses the plot.
 */
function placeLabels(points: readonly Point[]): Label[] {
  const right = PLOT.left + INNER_W
  const sides = new Map<'start' | 'end', { point: Point; width: number }[]>()
  for (const point of points) {
    const width = textWidth(point.learner, LABEL_SIZE)
    const anchor: 'start' | 'end' = point.cx + point.r + 6 + width <= right ? 'start' : 'end'
    const group = sides.get(anchor) ?? []
    group.push({ point, width })
    sides.set(anchor, group)
  }

  const out: Label[] = []
  for (const [anchor, group] of sides) {
    group.sort((a, b) => a.point.cy - b.point.cy)
    const ys: number[] = []
    let previous = -Infinity
    for (const { point } of group) {
      const y = Math.max(point.cy, previous + LABEL_GAP)
      ys.push(y)
      previous = y
    }
    // Pushing down can run off the bottom; pull the tail back up, which is safe
    // because the gap is preserved in both directions.
    const floor = PLOT.top + INNER_H - 2
    for (let i = ys.length - 1; i >= 0; i -= 1) {
      if (ys[i] > floor) ys[i] = floor
      if (i < ys.length - 1 && ys[i] > ys[i + 1] - LABEL_GAP) ys[i] = ys[i + 1] - LABEL_GAP
    }
    group.forEach(({ point }, i) => {
      const y = ys[i]
      out.push({
        index: point.index,
        x: anchor === 'start' ? point.cx + point.r + 5 : point.cx - point.r - 5,
        y: y + LABEL_SIZE * 0.34,
        anchor,
        leader: Math.abs(y - point.cy) > 3,
      })
    })
  }
  return out
}

/* ------------------------------------------------------------------ helpers */

function fixed(value: number | undefined, decimals: number): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(decimals) : '—'
}

/** The end of a curve — what a `final` figure is supposed to agree with. */
function lastOf(values: readonly number[] | undefined): number | undefined {
  return values && values.length > 0 ? values[values.length - 1] : undefined
}

/**
 * Learners whose `final` does not agree with the end of their own curve.
 *
 * The dots are `final`; the curves view draws the arrays. If the two disagree
 * the two views are showing different runs under one name, and that is worth a
 * sentence on both — silence would leave the reader to discover it by squinting
 * at two screens.
 */
function finalsDisagreeing(runs: readonly Run[]): string[] {
  const off: string[] = []
  for (const run of runs) {
    if (!run.final || !run.curves) continue
    const pairs: [number | undefined, number | undefined][] = [
      [run.final.utility, lastOf(run.curves.utility)],
      [run.final.cost, lastOf(run.curves.cost)],
      [run.final.success, lastOf(run.curves.success)],
      [run.final.opr, lastOf(run.curves.opr)],
    ]
    for (const [a, b] of pairs) {
      if (typeof a !== 'number' || typeof b !== 'number') continue
      if (Math.abs(a - b) > 5e-4) {
        off.push(run.learner)
        break
      }
    }
  }
  return off
}

/* -------------------------------------------------------------------- view */

export const Pareto: FC<{ model: PromptWiseModel }> = ({ model }) => {
  const t = useT()
  const uid = useId()
  const runs = useMemo(() => (model.runs ?? []).filter((run) => run.final !== undefined), [model.runs])
  const [highlit, setHighlit] = useState<number | null>(null)

  const costPara = model.config?.costPara
  const steps = model.config?.steps
  const epochs = model.config?.epochs

  const identityGap = useMemo(() => utilityIdentityGap(runs, costPara ?? Number.NaN), [runs, costPara])
  const utilityIsLinear = identityGap !== null && identityGap <= IDENTITY_TOLERANCE && typeof costPara === 'number'

  const xDomain = useMemo(
    () => costDomain(runs.reduce((max, run) => Math.max(max, run.final.cost), 0)),
    [runs],
  )

  const utilityRange = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const run of runs) {
      const value = run.final.utility
      if (!Number.isFinite(value)) continue
      lo = Math.min(lo, value)
      hi = Math.max(hi, value)
    }
    return Number.isFinite(lo) ? { lo, hi } : null
  }, [runs])

  const points = useMemo<Point[]>(() => {
    // Area, not radius, carries the value — a radius scale would show three
    // times the difference there is. The floor keeps the worst learner on the
    // figure: a negative utility must be a small dot, never an absent one.
    const base = utilityRange
    const span = base && base.hi > base.lo ? base.hi - base.lo : 0
    return runs.map((run, index) => {
      const norm = base && span > 0 ? (run.final.utility - base.lo) / span : 1
      return {
        index,
        learner: run.learner,
        cost: run.final.cost,
        success: run.final.success,
        utility: run.final.utility,
        opr: run.final.opr,
        cx: scaleX(run.final.cost, xDomain),
        cy: scaleY(run.final.success, SUCCESS_DOMAIN),
        r: Math.sqrt(R_MIN * R_MIN + (R_MAX * R_MAX - R_MIN * R_MIN) * Math.max(0, Math.min(1, norm))),
      }
    })
  }, [runs, xDomain, utilityRange])

  const labels = useMemo(() => placeLabels(points), [points])

  const oracleValues = useMemo(() => {
    const seen: number[] = []
    for (const run of runs) {
      if (!Number.isFinite(run.oracleUtility)) continue
      if (!seen.some((one) => Math.abs(one - run.oracleUtility) < 1e-9)) seen.push(run.oracleUtility)
    }
    return seen.sort((a, b) => a - b)
  }, [runs])

  /** Guides at round utilities, so a reader can read a point's utility off the plane. */
  const isoLines = useMemo(() => {
    if (!utilityIsLinear || typeof costPara !== 'number') return []
    const lo = SUCCESS_DOMAIN.lo - costPara * xDomain.hi
    const hi = SUCCESS_DOMAIN.hi - costPara * xDomain.lo
    const step = niceStep(Math.abs(hi - lo), 5)
    const decimals = decimalsFor(step)
    const first = Math.ceil(Math.min(lo, hi) / step) * step
    const out: { value: number; segment: Segment; decimals: number }[] = []
    for (let value = first; value <= Math.max(lo, hi) + 1e-9; value += step) {
      const rounded = Number(value.toFixed(decimals + 2))
      if (oracleValues.some((one) => Math.abs(one - rounded) < step / 8)) continue
      const segment = isoSegment(rounded, costPara, xDomain, SUCCESS_DOMAIN)
      if (segment) out.push({ value: rounded, segment, decimals })
    }
    return out
  }, [utilityIsLinear, costPara, xDomain, oracleValues])

  const oracleLines = useMemo(() => {
    if (!utilityIsLinear || typeof costPara !== 'number') return []
    const out: { value: number; segment: Segment }[] = []
    for (const value of oracleValues) {
      const segment = isoSegment(value, costPara, xDomain, SUCCESS_DOMAIN)
      if (segment) out.push({ value, segment })
    }
    return out
  }, [utilityIsLinear, costPara, xDomain, oracleValues])

  const disagreeing = useMemo(() => finalsDisagreeing(runs), [runs])

  if (runs.length === 0) {
    return (
      <div className="pw-view">
        <div className="pw-inner">
          <p className="pw-empty">
            {t({
              en: 'No run in this package carries a final utility, cost and success, so there is nothing to plot.',
              zh: '这个数据包里没有任何 run 带有最终的效用、成本与成功率，因此没有可画的点。',
            })}
          </p>
        </div>
      </div>
    )
  }

  // Only what the package states. A missing epoch count is a missing clause,
  // never a guessed one, and never a figure standing without its denominator.
  const en: string[] = []
  const zh: string[] = []
  if (typeof steps === 'number') {
    en.push(`over ${steps.toLocaleString()} steps`)
    zh.push(`跨 ${steps.toLocaleString()} 步`)
  }
  if (typeof epochs === 'number') {
    en.push(`averaged over ${epochs} epochs`)
    zh.push(`对 ${epochs} 轮取平均`)
  }
  if (typeof costPara === 'number') {
    en.push(`cost_para (λ) = ${costPara}`)
    zh.push(`cost_para（λ）= ${costPara}`)
  }
  if (typeof model.config?.seed === 'number') {
    en.push(`seed ${model.config.seed}`)
    zh.push(`随机种子 ${model.config.seed}`)
  }
  const scale: Str =
    en.length > 0
      ? { en: `Each point is one learner, ${en.join(', ')}.`, zh: `每个点是一个 learner，${zh.join('、')}。` }
      : {
          en: 'Each point is one learner. The package states no step or epoch count for them.',
          zh: '每个点是一个 learner。数据包没有声明它们的步数或轮数。',
        }

  const detail = highlit === null ? null : points.find((point) => point.index === highlit)

  // Inside the plot, so a crop of the drawing alone still carries the scale it
  // is over and the package's one-line description of itself. Dropped rather
  // than truncated when it will not fit beside the axis title: half a sentence
  // about where data came from is worse than none, and the caption above has it
  // in full either way.
  const scaleTag = [
    typeof steps === 'number' ? `${steps.toLocaleString()} ${t({ en: 'steps', zh: '步' })}` : '',
    typeof epochs === 'number' ? `${epochs} ${t({ en: 'epochs', zh: '轮' })}` : '',
  ]
    .filter(Boolean)
    .join(' × ')
  const what = model.provenance?.what
  const wide = what ? (scaleTag ? `${scaleTag} · ${what}` : what) : scaleTag
  const watermark = textWidth(wide, 10) <= INNER_W - 110 ? wide : scaleTag

  return (
    <div className="pw-view">
      <div className="pw-inner">
        <figure className="pw-figure pw-pareto-figure">
          {/* The caption is above the plot on purpose: a reader — and a crop —
              meets what the data is before meeting the picture of it. */}
          <figcaption className="pw-figcap" id={`${uid}-cap`}>
            <span className="pw-figcap-title">
              {t({ en: 'Final cost against final success, by learner', zh: '各 learner 的最终成本与最终成功率' })}
            </span>
            <span className="pw-figcap-line">
              {t({
                en: 'x: mean cost per prompt, in the units models[].cost uses. y: share of prompts solved — a rate, drawn over its whole 0 to 1 range so no gap is exaggerated. Up and to the left is better: cheaper, and right more often.',
                zh: 'x：每题平均成本，单位与 models[].cost 一致。y：解出的题目占比 —— 它是一个比率，按完整的 0 到 1 作图，所以不会放大任何差距。越靠左上越好：更便宜，且更常做对。',
              })}
            </span>
            <span className="pw-figcap-line">{t(scale)}</span>
            {utilityRange && (
              <span className="pw-figcap-line">
                {t({
                  en: `Point area is linear in final utility, from ${utilityRange.lo.toFixed(4)} (smallest dot) to ${utilityRange.hi.toFixed(4)} (largest), floored so a negative utility is still visible.`,
                  zh: `点的面积与最终效用成正比，从 ${utilityRange.lo.toFixed(4)}（最小的点）到 ${utilityRange.hi.toFixed(4)}（最大的点）；设有下限，所以负效用的点也看得见。`,
                })}
              </span>
            )}
            <ProvenanceLine data={model.provenance?.data} />
          </figcaption>

          <svg
            className="pw-plot"
            viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-labelledby={`${uid}-cap`}
          >
            {SUCCESS_DOMAIN.ticks.map((tick) => (
              <g key={`y${tick}`}>
                <line
                  className="pw-gridline"
                  x1={PLOT.left}
                  x2={PLOT.left + INNER_W}
                  y1={scaleY(tick, SUCCESS_DOMAIN)}
                  y2={scaleY(tick, SUCCESS_DOMAIN)}
                />
                <text
                  className="pw-tick-label"
                  x={PLOT.left - 6}
                  y={scaleY(tick, SUCCESS_DOMAIN)}
                  textAnchor="end"
                  dy="0.32em"
                >
                  {tick.toFixed(SUCCESS_DOMAIN.decimals)}
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
                <text
                  className="pw-tick-label"
                  x={scaleX(tick, xDomain)}
                  y={PLOT.top + INNER_H + 15}
                  textAnchor="middle"
                >
                  {tick.toFixed(xDomain.decimals)}
                </text>
              </g>
            ))}

            {/* Iso-utility guides. Every pair on one of these lines has the same
                utility, which is what makes the dot sizes checkable by eye. */}
            {isoLines.map(({ value, segment, decimals }) => {
              const text = `u ${value.toFixed(decimals)}`
              const width = textWidth(text, 9)
              return (
                <g key={`iso${value}`}>
                  <line className="pw-iso" x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
                  <text
                    className="pw-iso-label"
                    x={Math.min(Math.max(segment.x2 - width - 2, PLOT.left + 2), PLOT.left + INNER_W - width - 2)}
                    y={Math.max(segment.y2 - 3, PLOT.top + 9)}
                  >
                    {text}
                  </text>
                </g>
              )
            })}

            {oracleLines.map(({ value, segment }) => {
              const text = `${t({ en: 'oracle ceiling', zh: 'oracle 上界' })} u ${value.toFixed(4)}`
              const at = beside(segment.x2, text, 10)
              return (
                <g key={`oracle${value}`}>
                  <line className="pw-oracle-line" x1={segment.x1} y1={segment.y1} x2={segment.x2} y2={segment.y2} />
                  <text
                    className="pw-oracle-label"
                    x={at.x}
                    y={Math.min(Math.max(segment.y2 + 12, PLOT.top + 12), PLOT.top + INNER_H - 4)}
                    textAnchor={at.anchor}
                  >
                    {text}
                  </text>
                </g>
              )
            })}

            <line
              className="pw-axis-line"
              x1={PLOT.left}
              x2={PLOT.left + INNER_W}
              y1={PLOT.top + INNER_H}
              y2={PLOT.top + INNER_H}
            />
            <line className="pw-axis-line" x1={PLOT.left} x2={PLOT.left} y1={PLOT.top} y2={PLOT.top + INNER_H} />

            <text className="pw-axis-title" x={PLOT.left + INNER_W} y={PLOT.height - 6} textAnchor="end">
              {t({ en: 'final mean cost per prompt →', zh: '每题最终平均成本 →' })}
            </text>
            <text className="pw-axis-title" x={PLOT.left - 6} y={PLOT.top - 20} textAnchor="start">
              {t({ en: '↑ final success', zh: '↑ 最终成功率' })}
            </text>
            <text className="pw-better" x={PLOT.left + 2} y={PLOT.top - 6} textAnchor="start">
              {t({ en: '↖ better: cheaper, and right more often', zh: '↖ 越靠这个方向越好：更便宜、更常做对' })}
            </text>

            {labels.map((label) => {
              const point = points.find((one) => one.index === label.index)
              if (!point || !label.leader) return null
              return (
                <line
                  key={`leader${label.index}`}
                  className="pw-leader"
                  x1={label.anchor === 'start' ? point.cx + point.r : point.cx - point.r}
                  y1={point.cy}
                  x2={label.x}
                  y2={label.y - LABEL_SIZE * 0.34}
                />
              )
            })}

            {points.map((point) => (
              <circle
                key={point.index}
                className={point.index === highlit ? 'pw-point is-highlit' : 'pw-point'}
                cx={point.cx}
                cy={point.cy}
                r={point.r}
                style={{ fill: colourOf(point.index) } as CSSProperties}
                onPointerEnter={() => setHighlit(point.index)}
                onPointerLeave={() => setHighlit(null)}
              />
            ))}

            {labels.map((label) => {
              const point = points.find((one) => one.index === label.index)
              return (
                <text
                  key={`label${label.index}`}
                  className="pw-point-label"
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                >
                  {/* The learner's name, exactly as the runner wrote it. */}
                  {point?.learner}
                </text>
              )
            })}

            {watermark && (
              <text className="pw-watermark" x={PLOT.left + INNER_W} y={PLOT.top - 20} textAnchor="end">
                {watermark}
              </text>
            )}
          </svg>

          <p className="pw-detail" aria-live="polite">
            {detail ? (
              <>
                <span className="pw-detail-name">{detail.learner}</span>
                <span className="pw-detail-pair">
                  {t({ en: 'cost', zh: '成本' })} <b>{fixed(detail.cost, 3)}</b>
                </span>
                <span className="pw-detail-pair">
                  {t({ en: 'success', zh: '成功率' })} <b>{fixed(detail.success, 4)}</b>
                </span>
                <span className="pw-detail-pair">
                  {t({ en: 'utility', zh: '效用' })} <b>{fixed(detail.utility, 4)}</b>
                </span>
                <span className="pw-detail-pair">
                  {t(TERM.opr)} <b>{fixed(detail.opr, 4)}</b>
                </span>
              </>
            ) : (
              <span className="pw-detail-pair">
                {t({
                  en: 'Hover a point or a row for its four final figures; they are all in the table below.',
                  zh: '把指针移到某个点或某一行上可看它的四个最终指标；下表里也全都有。',
                })}
              </span>
            )}
          </p>
        </figure>

        {oracleValues.length > 0 && (
          <p className="pw-note">
            {utilityIsLinear
              ? t({
                  en: `The oracle is a line, not a dot: the package gives it a utility (${oracleValues.map((one) => one.toFixed(4)).join(', ')}) and no cost or success of its own, and on these axes one utility is every (cost, success) pair that reaches it. Anything on or above that dashed line matched the ceiling.`,
                  zh: `oracle 是一条线，不是一个点：数据包只给了它的效用（${oracleValues.map((one) => one.toFixed(4)).join('、')}），并没有给它自己的成本或成功率；而在这两个轴上，一个效用值对应的是所有能达到它的（成本，成功率）组合。落在虚线上或其上方，就等于追平了这个上界。`,
                })
              : t({
                  en: `The package gives the oracle a utility (${oracleValues.map((one) => one.toFixed(4)).join(', ')}) and no cost or success, so it has no place in this plane and is not drawn. It is on the utility panel of the curves view, where it belongs.`,
                  zh: `数据包只给了 oracle 的效用（${oracleValues.map((one) => one.toFixed(4)).join('、')}），没有成本也没有成功率，因此它在这个平面上没有位置，这里不画它。它出现在曲线视图的效用面板上 —— 那里才是它该在的地方。`,
                })}
          </p>
        )}

        {utilityIsLinear && identityGap !== null && (
          <p className="pw-note">
            {t({
              en: `The guides are lines of equal utility: utility = success − cost_para × cost holds on every learner's finals here, worst gap ${identityGap.toExponential(1)}, so a point's utility can be read off the plane rather than taken on trust.`,
              zh: `图中的引导线是等效用线：在这里每个 learner 的最终数字上，效用 = 成功率 − cost_para × 成本 都成立，最大偏差 ${identityGap.toExponential(1)}，所以一个点的效用可以直接从平面上读出来，不必凭信。`,
            })}
          </p>
        )}

        {disagreeing.length > 0 && (
          <p className="notice warn">
            {t({
              en: 'These learners’ final figures do not match the end of their own curves, so the dot and the curve are not the same number: ',
              zh: '以下 learner 的最终数字与它们自己曲线的末端对不上，也就是说点和曲线并不是同一个数：',
            })}
            <span className="mono">{disagreeing.join(', ')}</span>
          </p>
        )}

        <section className="pw-readout">
          <div className="pw-readout-head">
            <span className="pw-readout-t">{t({ en: 'The same points, as numbers', zh: '同样这些点，写成数字' })}</span>
            <span className="pw-readout-note">
              {t({
                en: 'sorted by cost, cheapest first — the order the figure reads left to right',
                zh: '按成本从低到高排序 —— 与图上从左到右的顺序一致',
              })}
            </span>
          </div>
          <div
            className="pw-wide"
            role="group"
            tabIndex={0}
            aria-label={t({ en: 'Final figures by learner', zh: '各 learner 的最终指标' })}
          >
            <table className="pw-table">
              <thead>
                <tr>
                  <th scope="col">{t(TERM.learner)}</th>
                  <th scope="col" className="num">
                    {t({ en: 'cost', zh: '成本' })}
                  </th>
                  <th scope="col" className="num">
                    {t({ en: 'success', zh: '成功率' })}
                  </th>
                  <th scope="col" className="num">
                    {t({ en: 'utility', zh: '效用' })}
                  </th>
                  <th scope="col" className="num">
                    {t(TERM.opr)}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...points]
                  .sort((a, b) => a.cost - b.cost)
                  .map((point) => (
                    <tr
                      key={point.index}
                      className={point.index === highlit ? 'is-highlit' : undefined}
                      onPointerEnter={() => setHighlit(point.index)}
                      onPointerLeave={() => setHighlit(null)}
                    >
                      <th scope="row">
                        <span className="pw-name">
                          <svg className="pw-chip" viewBox="0 0 12 12" aria-hidden="true">
                            <circle cx="6" cy="6" r="5" style={{ fill: colourOf(point.index) } as CSSProperties} />
                          </svg>
                          {point.learner}
                        </span>
                      </th>
                      <td className="num">{fixed(point.cost, 3)}</td>
                      <td className="num">{fixed(point.success, 4)}</td>
                      <td className="num">{fixed(point.utility, 4)}</td>
                      <td className="num">{fixed(point.opr, 4)}</td>
                    </tr>
                  ))}
                {oracleValues.map((value) => (
                  <tr className="pw-oracle-row" key={`oracle${value}`}>
                    <th scope="row">
                      <span className="pw-name">{t({ en: 'oracle ceiling', zh: 'oracle 上界' })}</span>
                    </th>
                    <td className="pw-blank" colSpan={2}>
                      {t({ en: 'not given by the package', zh: '数据包未提供' })}
                    </td>
                    <td className="num">{value.toFixed(4)}</td>
                    <td className="pw-blank">—</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- fragments */

/**
 * The package's own sentence about its data, inside the caption.
 *
 * Verbatim, and never elided: it is the sentence that stops this figure being
 * read as a reproduction of somebody's paper. When a package declines to say
 * anything, that silence is reported rather than papered over.
 */
const ProvenanceLine: FC<{ data?: string }> = ({ data }) => {
  const t = useT()
  return (
    <span className="pw-figcap-data">
      <strong>{t({ en: 'What this data is: ', zh: '这些数据是什么：' })}</strong>
      {data ?? (
        <em>
          {t({
            en: 'the package says nothing — read this figure as unattributed until it does.',
            zh: '数据包没有说明 —— 在它说明之前，请把这张图当作来源不明。',
          })}
        </em>
      )}
    </span>
  )
}

