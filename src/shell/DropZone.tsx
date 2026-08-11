import { useCallback, useId, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent, ReactNode } from 'react'
import { useT } from './lang'
import type { Str } from './lang'
import './shell.css'

/** Symlink loops are not expressible through the entries API, but a malformed tree still can be. */
const MAX_DIR_DEPTH = 12

interface FoundFile {
  file: File
  /** Full path inside the dropped tree, used only for stable ordering. */
  path: string
}

/**
 * readEntries() returns at most ~100 children per call in Chrome, so a single
 * call silently truncates any folder bigger than that. Loop until it is empty.
 */
function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  const all: FileSystemEntry[] = []
  return new Promise((resolve) => {
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(all)
        else {
          all.push(...batch)
          readBatch()
        }
      }, () => resolve(all))
    }
    readBatch()
  })
}

function entryToFile(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file((file) => resolve(file), () => resolve(null)))
}

async function collectEntry(entry: FileSystemEntry, depth: number, out: FoundFile[]): Promise<void> {
  if (entry.isFile) {
    const file = await entryToFile(entry as FileSystemFileEntry)
    if (file) out.push({ file, path: entry.fullPath || file.name })
    return
  }
  if (entry.isDirectory && depth < MAX_DIR_DEPTH) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry)
    for (const child of children) await collectEntry(child, depth + 1, out)
  }
}

async function walkEntries(entries: FileSystemEntry[]): Promise<File[]> {
  const found: FoundFile[] = []
  for (const entry of entries) await collectEntry(entry, 0, found)
  found.sort((a, b) => a.path.localeCompare(b.path))
  return found.map((f) => f.file)
}

function sortByPath(files: File[]): File[] {
  return [...files].sort((a, b) =>
    (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name),
  )
}

const DEFAULT_HEADING: Str = { en: 'Drop logs here', zh: '把日志拖到这里' }

export interface DropZoneProps {
  /** Receives every file found, ordered by path. Nothing is filtered — the parser decides. */
  onFiles: (files: File[]) => void
  /** Blocks input while the shell is parsing. */
  busy?: boolean
  heading?: Str
  /** Small print under the buttons: parse counts, skipped lines, errors. */
  hint?: ReactNode
  className?: string
}

export function DropZone({
  onFiles,
  busy = false,
  heading = DEFAULT_HEADING,
  hint,
  className,
}: DropZoneProps) {
  const t = useT()
  const [over, setOver] = useState(false)
  // Held as a `Str` rather than a rendered string so a language switch while the
  // note is on screen re-renders it in the new language.
  const [note, setNote] = useState<Str | null>(null)
  const headingId = useId()
  const dragDepth = useRef(0)
  const filePicker = useRef<HTMLInputElement>(null)
  const folderPicker = useRef<HTMLInputElement>(null)

  const deliver = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        setNote({ en: 'No files in that drop.', zh: '这次拖入里没有文件。' })
        return
      }
      setNote(null)
      onFiles(files)
    },
    [onFiles],
  )

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragDepth.current = 0
      setOver(false)
      if (busy) return

      const dt = e.dataTransfer
      // The item list is emptied the moment this handler yields, so take the
      // entries synchronously and walk them afterwards.
      const entries: FileSystemEntry[] = []
      for (let i = 0; i < dt.items.length; i++) {
        const item = dt.items[i]
        if (item.kind !== 'file') continue
        const entry = item.webkitGetAsEntry()
        if (entry) entries.push(entry)
      }

      // dataTransfer.files never recurses into folders; entries do.
      if (entries.length === 0) {
        deliver(sortByPath(Array.from(dt.files)))
        return
      }

      setNote({ en: 'Reading dropped items…', zh: '正在读取拖入的内容…' })
      walkEntries(entries).then(deliver, () =>
        setNote({ en: 'Could not read that folder.', zh: '这个文件夹读不了。' }),
      )
    },
    [busy, deliver],
  )

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = busy ? 'none' : 'copy'
  }

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    dragDepth.current += 1
    setOver(true)
  }

  const handleDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setOver(false)
  }

  const handlePick = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = '' // picking the same path twice must fire change again
    deliver(sortByPath(files))
  }

  return (
    <div
      className={['dropzone', over && 'over', busy && 'busy', className].filter(Boolean).join(' ')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      aria-busy={busy}
      role="group"
      aria-labelledby={headingId}
    >
      <p className="dropzone-title" id={headingId}>
        {t(heading)}
      </p>
      <p className="dropzone-sub">
        {t({
          en: 'One file, several files, or a whole folder — JSON or JSONL. Everything is read in this browser.',
          zh: '一个文件、多个文件，或者整个文件夹，JSON 或 JSONL。所有内容都在这个浏览器里读取。',
        })}
      </p>

      <div className="cluster">
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => filePicker.current?.click()}
        >
          {t({ en: 'Choose files', zh: '选择文件' })}
        </button>
        <button type="button" disabled={busy} onClick={() => folderPicker.current?.click()}>
          {t({ en: 'Choose folder', zh: '选择文件夹' })}
        </button>
      </div>

      {/* Rendered even when empty: a live region has to be in the DOM before the
          message arrives, or the announcement is lost. CSS reserves its height. */}
      <p className="dropzone-note" role="status">
        {note ? t(note) : hint}
      </p>

      {/* .sr-only hides these from sight but leaves them tabbable, which put two
          unlabelled 2x2px file pickers in the tab order. The buttons above are
          the only way in; these never need focus. */}
      <input
        ref={filePicker}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handlePick}
      />
      <input
        ref={(node) => {
          folderPicker.current = node
          // React's typings carry no webkitdirectory, so set it on the node.
          node?.setAttribute('webkitdirectory', '')
        }}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handlePick}
      />
    </div>
  )
}
