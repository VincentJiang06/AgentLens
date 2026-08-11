import { useMemo } from 'react'
import type { ParsedFile } from '../types'
import { RawTree } from './RawTree'
import { useT } from './lang'
import { VirtualList } from './VirtualList'
import './RecordBrowser.css'

/**
 * The fallback view, and the one the DoD is written against: whatever no adapter
 * claimed is still browsable. A list of every recovered record on the left, the
 * selected record as a collapsible tree on the right.
 *
 * Previews are built inside `renderRow`, so only the ~20 visible rows of a 2985
 * record file are ever inspected.
 *
 * Like `RawTree`, this shows every field a dropped file carries. The redaction
 * promise applies to what AgentLens ships, not to what it shows a reader of
 * their own file; `App.tsx`'s RawScopeNote renders that above this view.
 */

const ROW_HEIGHT = 28
const PREVIEW_KEYS = 6
const PREVIEW_CHARS = 240

interface RawRecord {
  /**
   * What `?record=` matches. `<file>:<index>`, never `<file>#<index>`: a '#' in a
   * URL is a fragment, so the browser strips it before the query is read and the
   * emailed link silently opens the wrong record. Adapters mint ids the same way.
   */
  id: string
  index: number
  fileName: string
  value: unknown
}

function flattenRecords(files: ParsedFile[]): RawRecord[] {
  return files.flatMap((file) =>
    file.records.map((record) => ({
      id: `${file.fileName}:${record.index}`,
      index: record.index,
      fileName: file.fileName,
      value: record.value,
    })),
  )
}

function clip(text: string): string {
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text
}

function briefly(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') return '{…}'
  if (typeof value === 'string') return value.length > 40 ? `"${value.slice(0, 40)}…"` : `"${value}"`
  return String(value)
}

function previewOf(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value !== 'object') return clip(typeof value === 'string' ? value : String(value))
  if (Array.isArray(value)) return `${value.length} items`
  try {
    const fields = value as Record<string, unknown>
    const keys = Object.keys(fields)
    if (keys.length === 0) return '{}'
    const shown = keys.slice(0, PREVIEW_KEYS).map((key) => `${key}: ${briefly(fields[key])}`)
    const rest = keys.length - PREVIEW_KEYS
    return clip(shown.join('   ') + (rest > 0 ? `   +${rest} more` : ''))
  } catch {
    return '(unreadable)'
  }
}

export interface RecordBrowserProps {
  files: ParsedFile[]
  /** `?record=` — selects a row and scrolls it into view. */
  recordId?: string
  onSelect: (id: string) => void
}

export function RecordBrowser({ files, recordId, onSelect }: RecordBrowserProps) {
  const t = useT()
  const records = useMemo(() => flattenRecords(files), [files])
  const showFileName = files.length > 1

  // A bare `?record=7` is what a reader types by hand; it can only be resolved
  // when there is a single file to index into.
  const bareIndexOk = files.length === 1

  const selectedIndex = useMemo(() => {
    if (recordId === undefined) return -1
    return records.findIndex(
      (record) => record.id === recordId || (bareIndexOk && String(record.index) === recordId),
    )
  }, [records, recordId, bareIndexOk])

  const selected = selectedIndex >= 0 ? records[selectedIndex] : undefined

  return (
    <div className="browser">
      <section className="panel browser-list">
        <header className="panel-header">
          {/* English inflects at one, Chinese does not: 条 is a measure word and
              takes the same form whatever the numeral in front of it is. */}
          {t({
            en: `${records.length.toLocaleString()} record${records.length === 1 ? '' : 's'}`,
            zh: `${records.length.toLocaleString()} 条记录`,
          })}
          {records.length > 0 && recordId !== undefined && selectedIndex < 0 && (
            <span className="badge warn">
              {t({ en: `no record “${recordId}” here`, zh: `这里没有记录「${recordId}」` })}
            </span>
          )}
        </header>
        <div className="panel-body fill">
          <VirtualList
            items={records}
            estimateSize={ROW_HEIGHT}
            scrollToIndex={selectedIndex >= 0 ? selectedIndex : undefined}
            getKey={(record) => record.id}
            label={t({ en: 'Parsed records', zh: '已解析的记录' })}
            empty={
              <span className="muted">
                {t({
                  en: 'No records were recovered from these files.',
                  zh: '这些文件里没有抢救出任何记录。',
                })}
              </span>
            }
            renderRow={(record) => (
              <button
                type="button"
                className="list-row record-row"
                aria-current={record.id === selected?.id ? 'true' : undefined}
                onClick={() => onSelect(record.id)}
              >
                <span className="list-index">{record.index}</span>
                {showFileName && <span className="record-file truncate">{record.fileName}</span>}
                <span className="record-preview truncate mono">{previewOf(record.value)}</span>
              </button>
            )}
          />
        </div>
      </section>

      <section className="panel browser-detail">
        <header className="panel-header">
          {/* The id is `<file>:<index>` — the file's own name, so it is not translated. */}
          {selected
            ? t({ en: `record ${selected.id}`, zh: `记录 ${selected.id}` })
            : t({ en: 'record', zh: '记录' })}
        </header>
        <div className="panel-body">
          {selected ? (
            <RawTree value={selected.value} rootLabel={String(selected.index)} defaultExpandDepth={2} />
          ) : (
            <p className="browser-hint muted">
              {records.length === 0
                ? t({
                    en: 'Nothing to inspect — see the notices above for what went wrong.',
                    zh: '没有可查看的内容，具体原因见上方的提示。',
                  })
                : t({ en: 'Select a record to open it.', zh: '选一条记录打开。' })}
            </p>
          )}
        </div>
      </section>
    </div>
  )
}
