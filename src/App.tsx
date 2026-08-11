import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Adapter, DemoPackage, ParsedFile, RouteState } from './types'
import { all, demoById, dispatch as dispatchFiles } from './adapters/registry'
import type { Dispatch } from './adapters/registry'
import { DropZone } from './shell/DropZone'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { RecordBrowser } from './shell/RecordBrowser'
import { fileFromBlob, parseFile, parseFiles } from './shell/parseClient'
import type { ParseProgress } from './shell/parseClient'
import {
  buildHref,
  goHome,
  openDemo,
  resolveRoute,
  selectRecord,
  shareUrl,
  useRoute,
} from './shell/router'
import { useTheme } from './shell/theme'
import './App.css'

/**
 * The shell. Files come in from a drop or a `?demo=` link, go through the parse
 * worker, then through dispatch, and land in one of two views: the adapter that
 * claimed them, or the raw record browser.
 *
 * The invariant this file exists to hold: nothing a file or an adapter can do
 * produces a blank page. Parse damage becomes a notice, an unclaimed drop becomes
 * RawTree, and an adapter that throws — in `parse()` or in `render` — is demoted
 * to RawTree with the reason on screen.
 */

const PRIVACY_LINE = 'All data stays in your browser — nothing is uploaded.'

/* ------------------------------------------------------------ landing cards */

/**
 * A roadmap row: an adapter that is *not* in this build. Live cards are derived
 * from the registry instead (see `landingCards`), so registering an adapter is
 * the only thing needed to put it on the landing page — including adapters that
 * appear on no roadmap row at all.
 */
interface Planned {
  /** The `?demo=` id, and the adapter name, the real adapter will publish. */
  id: string
  label: string
  blurb: string
  stage: string
  /**
   * Shown on the live card when a *preview* of this row ships — a partial view
   * has to say what it does not do yet. Unused while nothing previews the row.
   */
  previewNote?: string
}

const PLANNED: Planned[] = [
  {
    id: 'rm-r1',
    label: 'RM-R1',
    blurb: 'Reward-model evaluation runs: per-example verdicts, and where the judge and the label disagree.',
    stage: 'M1',
  },
  {
    id: 'promptwise',
    label: 'PromptWise',
    blurb: 'Cost-aware model routing: which model answered each prompt, when it escalated to a more expensive one, and what that cost.',
    stage: 'M2',
  },
  {
    id: 'arbiteros',
    label: 'ArbiterOS',
    blurb: 'Agent red-team cases: what the agent had already seen, and the call it was about to make.',
    stage: 'M3',
    previewNote: 'M0 preview — the case list only. The full trace view lands in M3.',
  },
  {
    id: 'recmem',
    label: 'RecMem',
    blurb: 'Memory stores over time: what was written, what was retrieved, and what went stale.',
    stage: 'M4',
  },
]

/**
 * An adapter named `<row>` *is* that roadmap row; one named `<row>-<suffix>`
 * (`arbiteros-preview`) is a preview of it. Either way the row is replaced by
 * the working card, so the landing page can never advertise a milestone as
 * unbuilt next to a card that opens it.
 */
function plannedFor(adapterName: string): Planned | undefined {
  return PLANNED.find((row) => adapterName === row.id || adapterName.startsWith(`${row.id}-`))
}

interface Card {
  key: string
  label: string
  blurb: string
  badge: string
  /** Set only when the card opens something. */
  demoId?: string
  note?: string
  planned?: boolean
}

function landingCards(adapters: Adapter[]): Card[] {
  const live = adapters.flatMap((adapter): Card[] => {
    const row = plannedFor(adapter.name)
    const note = row && adapter.name !== row.id ? row.previewNote : undefined
    const demos = adapter.demos ?? []
    if (demos.length === 0) {
      return [
        {
          key: adapter.name,
          label: adapter.label,
          blurb: adapter.blurb,
          badge: 'no demo package',
          note: 'Registered in this build — drop matching logs below and it takes over.',
        },
      ]
    }
    return demos.map((demo) => ({
      key: `${adapter.name}:${demo.id}`,
      // One demo speaks for the adapter; several have to name themselves.
      label: demos.length > 1 ? demo.label : adapter.label,
      blurb: adapter.blurb,
      badge: 'Open demo',
      demoId: demo.id,
      note,
    }))
  })

  const covered = new Set(adapters.map((adapter) => plannedFor(adapter.name)?.id))
  const planned = PLANNED.filter((row) => !covered.has(row.id)).map(
    (row): Card => ({
      key: row.id,
      label: row.label,
      blurb: row.blurb,
      badge: `${row.stage} · planned`,
      note: 'No adapter in this build yet.',
      planned: true,
    }),
  )

  return [...live, ...planned]
}

/* -------------------------------------------------------------------- state */

interface Dataset {
  /** `demo:<id>` or `drop:<n>` — identifies what is loaded without comparing files. */
  key: string
  title: string
  /**
   * Set only for a demo package. A dropped file has no URL anyone else can open,
   * so there is no link to copy for it.
   */
  demoId?: string
  files: ParsedFile[]
  dispatch: Dispatch
  /** Undefined when nobody claimed the data, or when the claimant failed. */
  adapter?: Adapter
  model?: unknown
  /** Things the reader has to know that dispatch itself did not report. */
  notes: string[]
}

interface Progress extends ParseProgress {
  fileName: string
  fileIndex: number
  fileCount: number
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy'; title: string; progress: Progress | null }
  | { kind: 'failed'; title: string; message: string }
  | { kind: 'ready'; dataset: Dataset }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function buildDataset(
  source: { key: string; title: string; demoId?: string },
  files: ParsedFile[],
  preferred?: Adapter,
): Dataset {
  const dispatch = dispatchFiles(files)
  const notes: string[] = []
  let adapter = dispatch.adapter

  if (!adapter && preferred) {
    // A demo package that no longer matches its own adapter's fingerprint is a
    // bug worth showing, but not a reason to drop the reader into RawTree.
    adapter = preferred
    notes.push(
      `This package ships with the ${preferred.label} view, but its records no longer match that adapter's fingerprint. Opening it anyway.`,
    )
  }

  let model: unknown
  if (adapter) {
    try {
      model = adapter.parse(files)
    } catch (error) {
      notes.push(
        `${adapter.label} could not read these files (${messageOf(error)}). Showing the raw records instead.`,
      )
      adapter = undefined
    }
  }

  return { ...source, files, dispatch, adapter, model, notes }
}

/* ---------------------------------------------------------------------- app */

function App() {
  const route = useRoute()
  const { theme, toggle } = useTheme()
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const resolved = useMemo(() => resolveRoute(route, knownDemoIds()), [route])

  // What is loaded, tracked outside React state so the demo effect can tell a
  // repeat of the same route from a real change without re-running on every render.
  const loadedKey = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const runId = useRef(0)
  const dropCount = useRef(0)

  const startLoad = useCallback((key: string, title: string) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    loadedKey.current = key
    const token = ++runId.current
    setPhase({ kind: 'busy', title, progress: null })
    return { controller, current: () => token === runId.current }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    runId.current += 1
    loadedKey.current = null
    setPhase({ kind: 'idle' })
  }, [])

  const handleFiles = useCallback(
    async (files: File[]) => {
      dropCount.current += 1
      const key = `drop:${dropCount.current}`
      const title = files.length === 1 ? files[0].name : `${files.length} files`
      const { controller, current } = startLoad(key, title)
      // A drop replaces whatever the URL pointed at; the old `?record=` is meaningless now.
      goHome({ replace: true })

      try {
        const parsed = await parseFiles(files, {
          signal: controller.signal,
          onProgress: (file, progress) => {
            if (!current()) return
            setPhase((previous) =>
              previous.kind === 'busy'
                ? {
                    ...previous,
                    progress: {
                      ...progress,
                      fileName: file.name,
                      fileIndex: files.indexOf(file),
                      fileCount: files.length,
                    },
                  }
                : previous,
            )
          },
        })
        if (!current()) return
        setPhase({ kind: 'ready', dataset: buildDataset({ key, title }, parsed) })
      } catch (error) {
        if (!current() || controller.signal.aborted) return
        setPhase({ kind: 'failed', title, message: messageOf(error) })
      }
    },
    [startLoad],
  )

  const loadDemo = useCallback(
    async (adapter: Adapter, demo: DemoPackage) => {
      const key = `demo:${demo.id}`
      const { controller, current } = startLoad(key, demo.label)

      try {
        const response = await fetch(demoUrl(demo.path), { signal: controller.signal })
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        const blob = await response.blob()
        if (!current()) return
        const parsed = await parseFile(fileFromBlob(blob, fileNameOf(demo.path)), {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!current()) return
            setPhase((previous) =>
              previous.kind === 'busy'
                ? {
                    ...previous,
                    progress: { ...progress, fileName: demo.label, fileIndex: 0, fileCount: 1 },
                  }
                : previous,
            )
          },
        })
        if (!current()) return
        setPhase({
          kind: 'ready',
          dataset: buildDataset({ key, title: demo.label, demoId: demo.id }, [parsed], adapter),
        })
      } catch (error) {
        if (!current() || controller.signal.aborted) return
        setPhase({
          kind: 'failed',
          title: demo.label,
          message: `Could not load this demo package (${messageOf(error)}). Dropping your own files still works.`,
        })
      }
    },
    [startLoad],
  )

  useEffect(() => {
    const id = resolved.demo
    if (id === undefined) {
      // Back out of a demo (Back button, or an unknown `?demo=`) returns to landing.
      if (loadedKey.current?.startsWith('demo:')) reset()
      return
    }
    if (loadedKey.current === `demo:${id}`) return
    const found = demoById(id)
    if (found) void loadDemo(found.adapter, found.demo)
  }, [resolved.demo, loadDemo, reset])

  const leaveDataset = useCallback(() => {
    reset()
    goHome()
  }, [reset])

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="ghost brand" onClick={leaveDataset}>
          AgentLens
        </button>
        <span className="spacer" />
        <span className="privacy truncate">{PRIVACY_LINE}</span>
        <span className="spacer" />
        <button
          type="button"
          className="icon"
          onClick={toggle}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <main className="app-main">
        {phase.kind === 'ready' ? (
          <DatasetView dataset={phase.dataset} recordId={resolved.record} onClose={leaveDataset} />
        ) : phase.kind === 'busy' ? (
          <Loading title={phase.title} progress={phase.progress} />
        ) : (
          <Landing
            failure={phase.kind === 'failed' ? phase : undefined}
            unknownDemo={resolved.unknownDemo}
            orphanRecord={resolved.demo === undefined ? resolved.record : undefined}
            onFiles={handleFiles}
          />
        )}
      </main>

      <footer className="statusbar">
        <StatusBar phase={phase} />
      </footer>
    </div>
  )
}

export default App

/* ------------------------------------------------------------------ landing */

interface LandingProps {
  failure?: { title: string; message: string }
  unknownDemo?: string
  orphanRecord?: string
  onFiles: (files: File[]) => void
}

function Landing({ failure, unknownDemo, orphanRecord, onFiles }: LandingProps) {
  return (
    <div className="scroll fill">
      <div className="container stack landing">
        <div className="stack">
          <h1>AgentLens</h1>
          <p className="lead">
            One viewer for the artifacts LLM and agent research leaves behind — evaluation logs,
            agent traces, memory stores, router decisions. Nothing is installed and nothing is
            uploaded: the files are read in this tab.
          </p>
        </div>

        {unknownDemo !== undefined && (
          <p className="notice warn">
            This link asks for a demo called “{unknownDemo}”, which this build does not have. It is
            probably from a later milestone.
          </p>
        )}
        {orphanRecord !== undefined && (
          <p className="notice">
            This link points at record “{orphanRecord}”. Open a demo or drop the matching file and
            it will be selected.
          </p>
        )}
        {failure && (
          <p className="notice bad">
            {failure.title}: {failure.message}
          </p>
        )}

        <section className="stack">
          <h2>Open a demo</h2>
          <div className="card-grid">
            {landingCards(all()).map((card) => (
              <DemoCard key={card.key} card={card} />
            ))}
          </div>
        </section>

        <section className="stack">
          <h2>Or read your own</h2>
          <DropZone
            onFiles={onFiles}
            heading="Drop logs here"
            hint="JSON, JSONL, one file or a folder. Damaged files are salvaged as far as they go."
          />
        </section>
      </div>
    </div>
  )
}

function DemoCard({ card }: { card: Card }) {
  const body = (
    <>
      <span className="cluster card-head">
        <strong>{card.label}</strong>
        <span className="spacer" />
        <span className={card.demoId === undefined ? 'badge' : 'badge info'}>{card.badge}</span>
      </span>
      <span className="small muted">{card.blurb}</span>
      {card.note !== undefined && <span className="small faint">{card.note}</span>}
    </>
  )

  if (card.demoId === undefined) {
    return <div className={card.planned ? 'card is-planned' : 'card'}>{body}</div>
  }

  const demoId = card.demoId
  return (
    <a
      className="card"
      href={buildHref({ demo: demoId })}
      onClick={(event) => {
        // Left click routes in place; modified clicks stay real link clicks.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        openDemo(demoId)
      }}
    >
      {body}
    </a>
  )
}

/* ------------------------------------------------------------------ loading */

function Loading({ title, progress }: { title: string; progress: Progress | null }) {
  const pct =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.bytesRead / progress.totalBytes) * 100))
      : 0

  return (
    <div className="scroll fill">
      <div className="container stack loading">
        <h2>Reading {title}</h2>
        <div
          className="progress"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`Parsing ${title}`}
        >
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <p className="small muted">
          {progress
            ? `${formatBytes(progress.bytesRead)} of ${formatBytes(progress.totalBytes)} · ${progress.recordCount.toLocaleString()} records` +
              (progress.fileCount > 1
                ? ` · file ${progress.fileIndex + 1} of ${progress.fileCount} (${progress.fileName})`
                : '')
            : 'Starting the parse worker…'}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ dataset */

interface DatasetViewProps {
  dataset: Dataset
  recordId?: string
  onClose: () => void
}

function DatasetView({ dataset, recordId, onClose }: DatasetViewProps) {
  const { adapter, dispatch, files } = dataset
  const fallback = (
    <RecordBrowser files={files} recordId={recordId} onSelect={(id) => selectRecord(id)} />
  )

  return (
    <div className="dataset">
      <div className="cluster dataset-head">
        <strong className="truncate">{dataset.title}</strong>
        {adapter ? (
          <span className="badge info">
            {adapter.label}
            {dispatch.outcome === 'declared'
              ? ' · declared'
              : ` · ${Math.round(dispatch.confidence * 100)}% match`}
          </span>
        ) : (
          <span className="badge">Raw records</span>
        )}
        <span className="spacer" />
        {dataset.demoId !== undefined && (
          <CopyLink route={{ demo: dataset.demoId, record: recordId }} />
        )}
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="dataset-notices stack">
        <ParseNotices files={files} />
        {dispatch.warnings.map((warning) => (
          <p key={warning.kind + warning.message} className="notice warn">
            {warning.message}
          </p>
        ))}
        {dataset.notes.map((note) => (
          <p key={note} className="notice bad">
            {note}
          </p>
        ))}
        {!adapter && dispatch.outcome === 'unclaimed' && (
          <p className="notice">
            No adapter recognised this data
            {dispatch.scores.length > 0 && dispatch.confidence > 0
              ? ` (best guess ${dispatch.scores[0].name} at ${Math.round(dispatch.confidence * 100)}%)`
              : ''}
            . Showing the records as they were parsed.
          </p>
        )}
      </div>

      <div className="dataset-body">
        {adapter ? (
          <ErrorBoundary
            resetKey={dataset.key}
            fallback={(error) => (
              <div className="dataset-fallback">
                <p className="notice bad">
                  The {adapter.label} view crashed ({error.message}). Falling back to the raw
                  records.
                </p>
                {fallback}
              </div>
            )}
          >
            <div className="scroll fill adapter-view">
              <adapter.View model={dataset.model} recordId={recordId} />
            </div>
          </ErrorBoundary>
        ) : (
          fallback
        )}
      </div>
    </div>
  )
}

/**
 * The deep link is how this project reaches people, so it is copyable from the
 * page rather than only from the address bar: whatever record is open is in the
 * URL, and this hands that URL over in one click.
 */
function CopyLink({ route }: { route: RouteState }) {
  const url = shareUrl(route)
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')

  // Selecting another record makes the copied link stale; say so by resetting.
  useEffect(() => setState('idle'), [url])

  return (
    <button
      type="button"
      className="ghost copy-link"
      title={url}
      aria-live="polite"
      onClick={() => {
        // There is no clipboard on an insecure origin, and the user may refuse
        // permission: both land here, and neither is worth an error dialog.
        void (async () => {
          try {
            await navigator.clipboard.writeText(url)
            setState('copied')
          } catch {
            setState('failed')
          }
        })()
      }}
    >
      {state === 'copied'
        ? 'Link copied'
        : state === 'failed'
          ? 'Copy failed — the link is in the address bar'
          : 'Copy link'}
    </button>
  )
}

/** Counts first, then the first few excerpts — a damaged file must not look clean. */
function ParseNotices({ files }: { files: ParsedFile[] }) {
  const salvaged = files.filter((file) => file.salvaged)
  const problems = files.flatMap((file) =>
    file.problems.map((problem) => ({ file: file.fileName, ...problem })),
  )
  if (salvaged.length === 0 && problems.length === 0) return null

  // Only what came out of the damaged files, so the count matches the claim.
  const rescued = salvaged.reduce((total, file) => total + file.records.length, 0)

  return (
    <div className={`notice ${rescued === 0 && salvaged.length > 0 ? 'bad' : 'warn'} stack problems`}>
      <span>{damageSummary(salvaged.length, problems.length, rescued)}</span>
      {problems.slice(0, 3).map((problem) => (
        <span key={`${problem.file}:${problem.at}:${problem.excerpt}`} className="small mono">
          {problem.file} @ {problem.at} · {problem.excerpt}
        </span>
      ))}
      {problems.length > 3 && (
        <span className="small">…and {(problems.length - 3).toLocaleString()} more.</span>
      )}
    </div>
  )
}

function damageSummary(damagedFiles: number, problems: number, records: number): string {
  if (damagedFiles === 0) return `${countOf(problems, 'malformed line')} skipped.`
  if (records === 0) {
    return `Nothing could be read from ${countOf(damagedFiles, 'file')} — this does not look like JSON or JSONL.`
  }
  return `Recovered ${countOf(records, 'record')} from ${countOf(damagedFiles, 'damaged file')} — the JSON was not valid. ${countOf(problems, 'problem')} found.`
}

/* ---------------------------------------------------------------- statusbar */

function StatusBar({ phase }: { phase: Phase }) {
  if (phase.kind !== 'ready') {
    return <span>{phase.kind === 'busy' ? 'Parsing…' : 'No data loaded.'}</span>
  }
  const { files, dispatch, adapter } = phase.dataset
  const records = files.reduce((total, file) => total + file.records.length, 0)
  const bytes = files.reduce((total, file) => total + file.size, 0)
  const shapes = [...new Set(files.map((file) => file.shape))]

  return (
    <>
      <span>{countOf(files.length, 'file')}</span>
      <span>{countOf(records, 'record')}</span>
      <span>{formatBytes(bytes)}</span>
      <span className="mono">{shapes.join(', ')}</span>
      <span className="spacer" />
      <span>{adapter ? `${adapter.name} · ${dispatch.outcome}` : 'unclaimed'}</span>
    </>
  )
}

/* ------------------------------------------------------------------ helpers */

function knownDemoIds(): string[] {
  return all().flatMap((adapter) => adapter.demos?.map((demo) => demo.id) ?? [])
}

function demoUrl(path: string): string {
  return new URL(path, new URL(import.meta.env.BASE_URL, window.location.href)).href
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path
}

function countOf(n: number, noun: string): string {
  return `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
