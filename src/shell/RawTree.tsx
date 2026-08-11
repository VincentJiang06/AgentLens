import { useMemo, useState } from 'react'
import { useT } from './lang'
import type { Str } from './lang'
import './shell.css'

/**
 * The fallback view: whatever no adapter claimed still gets rendered here.
 * Nothing in this file may throw, and nothing renders a subtree the reader has
 * not opened — both are what keep a 22 MB file from taking the page down.
 *
 * This tree redacts nothing, deliberately. Dropping a released score file here
 * prints the internal checkpoint name in `model`, and that is correct: it is the
 * reader's own file, read in their own tab, and hiding a field from the person
 * who supplied it would make the raw view a liar about the data it claims to
 * show. What AgentLens promises is narrower and lives elsewhere — the demo
 * packages it *ships* drop that field, and no such name appears on the published
 * site. `App.tsx`'s RawScopeNote states that boundary on screen.
 *
 * Nothing the file itself carries is translated: keys, values, and the `Array(3)`
 * / `Map(3)` notation that names a value's type all render as they are. The only
 * words this file writes are the controls and flags around them.
 */

/** A value's own notation, which reads the same in both languages. */
function notation(text: string): Str {
  return { en: text, zh: text }
}

/** Children beyond this are grouped into collapsed index buckets, DevTools-style. */
const BUCKET_SIZE = 100
const STRING_CLAMP = 200
/** Even an explicitly expanded string stops here; some records hold megabytes. */
const STRING_MAX = 100_000

const NO_ANCESTORS: readonly object[] = []

interface Entry {
  key: string
  value: unknown
  /** Set when reading the value failed, e.g. a getter threw. */
  problem?: Str
}

const UNREADABLE: Str = { en: 'unreadable', zh: '无法读取' }

/** Object-typed values that read better as a single line than as a subtree. */
function isLeafObject(value: object): boolean {
  return value instanceof Date || value instanceof RegExp || value instanceof Error
}

function isBranch(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !isLeafObject(value)
}

function childCount(value: object): number {
  if (Array.isArray(value)) return value.length
  if (value instanceof Map || value instanceof Set) return value.size
  try {
    return Object.keys(value).length
  } catch {
    return 0
  }
}

function summarize(value: object): Str {
  const n = childCount(value)
  if (Array.isArray(value)) return notation(`Array(${n})`)
  if (value instanceof Map) return notation(`Map(${n})`)
  if (value instanceof Set) return notation(`Set(${n})`)
  return { en: n === 1 ? '{ 1 key }' : `{ ${n} keys }`, zh: `{ ${n} 个键 }` }
}

function entriesOf(value: object): Entry[] {
  if (Array.isArray(value)) return value.map((v, i) => ({ key: String(i), value: v }))
  if (value instanceof Set) {
    return Array.from(value.values(), (v, i) => ({ key: String(i), value: v }))
  }
  if (value instanceof Map) {
    return Array.from(value.entries(), ([k, v], i) => ({
      key: typeof k === 'string' ? k : `[${i}] ${describeLeaf(k).text}`,
      value: v,
    }))
  }
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return []
  }
  return keys.map((key) => {
    try {
      return { key, value: (value as Record<string, unknown>)[key] }
    } catch {
      return { key, value: undefined, problem: UNREADABLE }
    }
  })
}

/**
 * `text` is the value as JavaScript prints it, so it is never translated. `word`
 * is set only when there is no value to print and the placeholder is ours.
 */
function describeLeaf(value: unknown): { text: string; cls: string; word?: Str } {
  if (value === null) return { text: 'null', cls: 'is-nil' }
  if (value === undefined) return { text: 'undefined', cls: 'is-nil' }
  switch (typeof value) {
    case 'number':
      return { text: String(value), cls: 'is-num' }
    case 'bigint':
      return { text: `${value}n`, cls: 'is-num' }
    case 'boolean':
      return { text: String(value), cls: 'is-bool' }
    case 'symbol':
      return { text: value.toString(), cls: 'is-other' }
    case 'function':
      return { text: `ƒ ${value.name || 'anonymous'}`, cls: 'is-other' }
  }
  try {
    if (value instanceof Date) {
      return {
        text: Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(),
        cls: 'is-other',
      }
    }
    if (value instanceof Error) return { text: `${value.name}: ${value.message}`, cls: 'is-other' }
    return { text: String(value), cls: 'is-other' }
  } catch {
    return {
      text: '(unreadable)',
      cls: 'is-other',
      word: { en: '(unreadable)', zh: '（无法读取）' },
    }
  }
}

/**
 * Buckets stay a fixed count wide however deep the data goes: 250k children
 * become 25 buckets of 10k, each re-bucketed into hundreds when opened.
 */
function bucketStride(count: number): number {
  let stride = BUCKET_SIZE
  while (count / stride > BUCKET_SIZE) stride *= BUCKET_SIZE
  return stride
}

function StringLeaf({ text }: { text: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const long = text.length > STRING_CLAMP
  const shown = expanded ? text.slice(0, STRING_MAX) : text.slice(0, STRING_CLAMP)

  return (
    <span className="tree-val is-string">
      &quot;{shown}
      {!expanded && long && '…'}&quot;
      {long && (
        <button
          type="button"
          className="tree-more"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? t({ en: 'collapse', zh: '收起' })
            : t({
                en: `show all ${text.length.toLocaleString()} chars`,
                zh: `展开全部 ${text.length.toLocaleString()} 字符`,
              })}
        </button>
      )}
      {expanded && text.length > STRING_MAX && (
        <span className="tree-flag">
          {t({
            en: `cut at ${STRING_MAX.toLocaleString()} chars`,
            zh: `已在 ${STRING_MAX.toLocaleString()} 字符处截断`,
          })}
        </span>
      )}
    </span>
  )
}

function ValueLeaf({ value }: { value: unknown }) {
  const t = useT()
  if (typeof value === 'string') return <StringLeaf text={value} />
  const { text, cls, word } = describeLeaf(value)
  return <span className={`tree-val ${cls}`}>{word ? t(word) : text}</span>
}

interface NodeProps {
  label: string
  value: unknown
  depth: number
  /** Nodes shallower than this start open. */
  expandTo: number
  ancestors: readonly object[]
  problem?: Str
}

function TreeNode({ label, value, depth, expandTo, ancestors, problem }: NodeProps) {
  const t = useT()
  const [open, setOpen] = useState(depth < expandTo)
  const branch = isBranch(value)

  if (!branch) {
    return (
      <li className="tree-node" role="treeitem">
        <span className="tree-line">
          <span className="tree-bullet" aria-hidden="true" />
          <span className="tree-key">{label}</span>
          <ValueLeaf value={value} />
          {problem && <span className="tree-flag">{t(problem)}</span>}
        </span>
      </li>
    )
  }

  // A model handed to us by an adapter can hold back-references; JSON cannot.
  const circular = ancestors.includes(value)
  const leafish = circular || childCount(value) === 0

  return (
    <li className="tree-node" role="treeitem" aria-expanded={leafish ? undefined : open}>
      <span className="tree-line">
        {leafish ? (
          <span className="tree-bullet" aria-hidden="true" />
        ) : (
          <button
            type="button"
            className="tree-toggle"
            aria-label={t({
              en: `${open ? 'Collapse' : 'Expand'} ${label}`,
              zh: `${open ? '收起' : '展开'} ${label}`,
            })}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? '▾' : '▸'}
          </button>
        )}
        <span className="tree-key">{label}</span>
        <span className="tree-summary">{t(summarize(value))}</span>
        {circular && <span className="tree-flag">{t({ en: 'circular', zh: '循环引用' })}</span>}
      </span>
      {open && !leafish && (
        <Children value={value} depth={depth} expandTo={expandTo} ancestors={ancestors} />
      )}
    </li>
  )
}

function Children({
  value,
  depth,
  expandTo,
  ancestors,
}: {
  value: object
  depth: number
  expandTo: number
  ancestors: readonly object[]
}) {
  const entries = useMemo(() => entriesOf(value), [value])
  const nextAncestors = useMemo(() => [...ancestors, value], [ancestors, value])
  return (
    <EntryList entries={entries} depth={depth} expandTo={expandTo} ancestors={nextAncestors} />
  )
}

interface EntryListProps {
  entries: Entry[]
  depth: number
  expandTo: number
  ancestors: readonly object[]
}

function EntryList({ entries, depth, expandTo, ancestors }: EntryListProps) {
  if (entries.length > BUCKET_SIZE) {
    const stride = bucketStride(entries.length)
    const starts: number[] = []
    for (let i = 0; i < entries.length; i += stride) starts.push(i)
    return (
      <ul className="tree-children" role="group">
        {starts.map((start) => (
          <Bucket
            key={start}
            entries={entries}
            from={start}
            to={Math.min(start + stride, entries.length)}
            depth={depth}
            expandTo={expandTo}
            ancestors={ancestors}
          />
        ))}
      </ul>
    )
  }

  return (
    <ul className="tree-children" role="group">
      {entries.map((entry, i) => (
        <TreeNode
          key={`${i}:${entry.key}`}
          label={entry.key}
          value={entry.value}
          problem={entry.problem}
          depth={depth + 1}
          expandTo={expandTo}
          ancestors={ancestors}
        />
      ))}
    </ul>
  )
}

function Bucket({
  entries,
  from,
  to,
  depth,
  expandTo,
  ancestors,
}: EntryListProps & { from: number; to: number }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const slice = useMemo(() => entries.slice(from, to), [entries, from, to])

  return (
    <li className="tree-node" role="treeitem" aria-expanded={open}>
      <span className="tree-line">
        <button
          type="button"
          className="tree-toggle"
          aria-label={t({
            en: `${open ? 'Collapse' : 'Expand'} items ${from} to ${to - 1}`,
            zh: `${open ? '收起' : '展开'}第 ${from} 到 ${to - 1} 项`,
          })}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className="tree-range">
          {from} … {to - 1}
        </span>
      </span>
      {open && (
        <EntryList entries={slice} depth={depth} expandTo={expandTo} ancestors={ancestors} />
      )}
    </li>
  )
}

export interface RawTreeProps {
  value: unknown
  rootLabel?: string
  /** Depth auto-opened at mount. Everything deeper renders only once opened. */
  defaultExpandDepth?: number
  className?: string
}

export function RawTree({
  value,
  rootLabel = 'root',
  defaultExpandDepth = 1,
  className,
}: RawTreeProps) {
  return (
    <div className={['tree', className].filter(Boolean).join(' ')}>
      <ul className="tree-children is-root" role="tree">
        <TreeNode
          label={rootLabel}
          value={value}
          depth={0}
          expandTo={defaultExpandDepth}
          ancestors={NO_ANCESTORS}
        />
      </ul>
    </div>
  )
}
