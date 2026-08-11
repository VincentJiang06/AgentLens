/**
 * Fault-tolerant streaming JSON / JSONL parsing.
 *
 * Pure core: no DOM, no Worker, no File. Chunks of text in, records out, so it
 * can be driven from a worker (`parse.worker.ts`) or from plain `node` in a test.
 *
 * The contract that matters: a file that is not valid JSON must still yield the
 * records we managed to recover, with `salvaged: true` and a ParseProblem
 * explaining what broke. Partial recovery is never reported as a clean parse.
 *
 * `parse.test.ts` drives this file directly under `node --test`.
 *
 * Every reason this file writes is a `Str`, because a parse problem is the one
 * notice a reader gets when their own file is the thing that went wrong, and it
 * sits at the top of the notice stack. The import is `import type`, so it is
 * erased: this module still pulls in no React, no DOM and no module state, which
 * is what lets the worker and `node --test` both run it. `Str` values are built
 * here and resolved wherever they are drawn — nothing in this file may ask what
 * language is on screen.
 */

import type { ParseProblem, ParseShape, ParsedRecord } from '../types'
import type { Str } from './lang'

export interface ParseOutcome {
  shape: ParseShape
  records: ParsedRecord[]
  problems: ParseProblem[]
  salvaged: boolean
  declaredFormat?: string
}

export interface ParseCoreOptions {
  /** Receives records as they are recovered, in file order. */
  onBatch?: (records: ParsedRecord[]) => void
  /** Records per `onBatch` call. */
  batchSize?: number
  /**
   * Keep every record in the returned outcome. The worker passes `false`: it
   * forwards each batch to the main thread and never holds the whole file.
   */
  retainRecords?: boolean
}

/** Enough text to tell an array from a JSONL stream without buying the file. */
const PROBE_CHARS = 64 * 1024
/** A first "line" longer than this is a minified document, not a JSONL record. */
const MAX_PROBE_LINE = 1 << 20
/** Drop consumed text once this much has piled up behind the cursor. */
const COMPACT_AT = 1 << 20
const MAX_PROBLEMS = 500
const EXCERPT_CHARS = 160
const DEFAULT_BATCH = 256
/** Guesses at where a swallowed value ended. Each wrong guess costs a rescan. */
const MAX_TAIL_RESYNCS = 16

/* --------------------------------------------------------- shape detection */

export function detectShape(probe: string): ParseShape {
  const head = probe.charCodeAt(0) === 0xfeff ? probe.slice(1) : probe
  let i = 0
  while (i < head.length && isWs(head[i])) i++
  if (i >= head.length) return 'unknown'

  const c = head[i]
  if (!isValueStart(c)) return 'unknown'

  // JSONL: the first line is a complete JSON value and more content follows it.
  // The caller must hand us a probe that actually reaches that newline; see the
  // probe loop in parseStream.
  const nl = head.indexOf('\n', i)
  if (nl !== -1 && nl - i <= MAX_PROBE_LINE) {
    const firstLine = head.slice(i, nl).trim()
    if (firstLine && hasNonWs(head, nl + 1) && isCompleteJson(firstLine)) return 'jsonl'
  }

  if (c === '[') return 'json-array'
  if (c === '{') return 'json-object'
  return 'jsonl' // a stream of bare scalars is only meaningful line by line
}

function isValueStart(c: string): boolean {
  return c === '{' || c === '[' || c === '"' || c === '-' || c === 't' || c === 'f' || c === 'n' || (c >= '0' && c <= '9')
}

function isCompleteJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function hasNonWs(text: string, from: number): boolean {
  for (let i = from; i < text.length; i++) if (!isWs(text[i])) return true
  return false
}

function isWs(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t'
}

/* ------------------------------------------------------------ record sink */

class Sink {
  records: ParsedRecord[] = []
  count = 0
  first: unknown = undefined
  private batch: ParsedRecord[] = []
  private batchSize: number
  private retain: boolean
  private onBatch?: (records: ParsedRecord[]) => void

  constructor(options: ParseCoreOptions) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH
    this.retain = options.retainRecords !== false
    this.onBatch = options.onBatch
  }

  push(value: unknown): void {
    if (this.count === 0) this.first = value
    const record: ParsedRecord = { index: this.count++, value }
    if (this.retain) this.records.push(record)
    if (this.onBatch) {
      this.batch.push(record)
      if (this.batch.length >= this.batchSize) this.flush()
    }
  }

  flush(): void {
    if (this.onBatch && this.batch.length) {
      this.onBatch(this.batch)
      this.batch = []
    }
  }
}

/* ------------------------------------------------------- problem bookkeeping */

interface Ctx {
  problem(at: number, kind: ParseProblem['kind'], reason: Str, snippet?: string): void
  salvage(): void
}

/**
 * Text that arrived rather than text we wrote: the offending bytes, a property
 * name, a `JSON.parse` message, a platform read error. It reads the same in both
 * languages because translating a quotation would misquote it.
 */
function verbatim(text: string): Str {
  return { en: text, zh: text }
}

/**
 * Everything this file can say about a broken file. Written out as a table so a
 * reason is authored once, in both languages, rather than at each call site —
 * and so `REASON.trailingContent` can be recognised by identity below instead of
 * by matching English prose that a translation would have quietly broken.
 */
const REASON = {
  parserFailed: { en: 'parser failed', zh: '解析器出错' },
  notJson: { en: 'not JSON or JSONL', zh: '既不是 JSON 也不是 JSONL' },
  trailingContent: {
    en: 'trailing content after the top-level value',
    zh: '顶层的值结束之后还有多余的内容',
  },
  trailingComma: { en: 'trailing comma', zh: '多了一个逗号' },
  emptyElement: { en: 'empty element', zh: '空的元素' },
  wantPropertyName: { en: 'expected a property name', zh: '这里应该是一个属性名' },
  wantColon: { en: 'expected ":"', zh: '这里应该是 ":"' },
  wantValue: { en: 'expected a value', zh: '这里应该是一个值' },
  wantCommaOrClose: {
    en: 'expected "," or a closing bracket',
    zh: '这里应该是 "," 或者右括号',
  },
  badPropertyName: { en: 'unreadable property name', zh: '读不出来的属性名' },
  unterminatedString: { en: 'unterminated string', zh: '字符串没有收尾' },
  endedInsideValue: { en: 'file ended inside a value', zh: '文件在一个值的中间就结束了' },
} satisfies Record<string, Str>

/** `expected "["` and friends: the bracket is punctuation, not a word. */
function wantChar(char: string): Str {
  return { en: `expected "${char}"`, zh: `这里应该是 "${char}"` }
}

/** ParseProblem has no message field, so the reason is folded into `excerpt`. */
function excerpt(reason: Str, snippet: string): Str {
  const clean = snippet.replace(/\s+/g, ' ').trim()
  if (!clean) return reason
  const body = clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS)}…` : clean
  return { en: `${reason.en}: ${body}`, zh: `${reason.zh}：${body}` }
}

/* ------------------------------------------------------------ entry points */

export async function parseStream(
  chunks: AsyncIterable<string>,
  options: ParseCoreOptions = {},
): Promise<ParseOutcome> {
  const sink = new Sink(options)
  const problems: ParseProblem[] = []
  let salvaged = false
  let suppressed = 0
  let declaredFormat: string | undefined
  // Set even when the problem itself is suppressed by MAX_PROBLEMS: the shape
  // warning it triggers below is about the whole file, not about one segment.
  let sawTrailingContent = false

  const ctx: Ctx = {
    problem(at, kind, reason, snippet = '') {
      if (reason === REASON.trailingContent) sawTrailingContent = true
      if (problems.length >= MAX_PROBLEMS) {
        suppressed++
        return
      }
      problems.push({ at, kind, excerpt: excerpt(reason, snippet) })
    },
    salvage() {
      salvaged = true
    },
  }

  /**
   * A read error is the same event whether it lands in the probe or 500 MB in,
   * so it gets the same treatment in both places: a ParseProblem plus whatever
   * we already recovered. It must never reject the promise — the caller has no
   * way to reach the salvaged records from a rejection.
   */
  const noteReadError = (error: unknown) => {
    ctx.problem(0, 'malformed-json', REASON.parserFailed, String(error))
    ctx.salvage()
  }

  // Acquiring the iterator can throw too (a getter that fails, a broken iterable).
  // Rare, but "parseStream never rejects" is a contract the whole shell leans on:
  // a rejection strands the records we did recover.
  let iterator: AsyncIterator<string>
  try {
    iterator = chunks[Symbol.asyncIterator]()
  } catch (error) {
    noteReadError(error)
    return { shape: 'unknown', records: [], problems, salvaged, declaredFormat: undefined }
  }
  let probe = ''
  let exhausted = false

  // The first line is what separates JSONL from a minified document, so the
  // probe has to contain it. Stopping at PROBE_CHARS would misread every JSONL
  // file whose first record is bigger than that (real logs here reach 77 KB) as
  // a single JSON object and drop every record after the first.
  let firstValue = -1
  let firstNewline = -1
  let cursor = 0 // everything below this has been classified; keeps the scan O(n)
  const rescan = () => {
    if (firstValue === -1) {
      if (cursor === 0 && probe.charCodeAt(0) === 0xfeff) cursor = 1
      while (cursor < probe.length && isWs(probe[cursor])) cursor++
      if (cursor >= probe.length) return
      firstValue = cursor
    }
    if (firstNewline === -1) {
      const nl = probe.indexOf('\n', cursor)
      firstNewline = nl
      cursor = nl === -1 ? probe.length : nl
    }
  }

  // detectShape needs three facts, and stopping at a fixed size gets the third one
  // wrong: when the newline lands on the probe's last character there is nothing
  // after it to prove more records follow, so the file reads as one document and
  // every later record is dropped. Chunked reads make that systematic at k*64KiB-1
  // rather than rare. Keep buying until the probe can actually answer the question.
  const probeSettled = () =>
    firstValue !== -1 && firstNewline !== -1 && hasNonWs(probe, firstNewline + 1)

  for (;;) {
    rescan()
    const wantMore =
      !probeSettled() && (probe.length < PROBE_CHARS || probe.length < MAX_PROBE_LINE)
    if (!wantMore) break
    let next: IteratorResult<string>
    try {
      next = await iterator.next()
    } catch (error) {
      noteReadError(error)
      exhausted = true
      break
    }
    if (next.done) {
      exhausted = true
      break
    }
    probe += next.value
  }
  if (probe.charCodeAt(0) === 0xfeff) probe = probe.slice(1)

  const shape = detectShape(probe)
  const stream = replay(probe, iterator, exhausted, noteReadError)

  try {
    if (shape === 'jsonl') {
      await parseLines(stream, sink, ctx)
    } else if (shape === 'json-array') {
      await walkContainer(stream, '[', (_key, value) => sink.push(value), ctx)
    } else if (shape === 'json-object') {
      declaredFormat = await collectObject(stream, sink, ctx)
    } else {
      ctx.problem(0, 'malformed-json', REASON.notJson, probe.slice(0, EXCERPT_CHARS))
    }
  } catch (error) {
    // The walkers are written not to throw; if one ever does, keep what we have.
    ctx.problem(0, 'malformed-json', REASON.parserFailed, String(error))
    ctx.salvage()
  }

  sink.flush()
  // A document that ends in trailing content is almost always JSONL whose first
  // record outran the probe budget above. Say so: silently keeping record 1 of
  // several thousand is the one failure here that looks like success.
  if (shape !== 'jsonl' && sawTrailingContent) {
    const budget = MAX_PROBE_LINE >> 20
    problems.push({
      at: 0,
      kind: 'malformed-json',
      excerpt: {
        // `shape` is one of this file's own format ids and reads the same either way.
        en:
          `read as a single ${shape} because the first line exceeds the ` +
          `${budget} MiB shape probe; if this file is JSONL, records after ` +
          `the first were not read`,
        zh:
          `第一行超过了 ${budget} MiB 的形状探测上限，所以整个文件按一个 ${shape} 读；` +
          `如果它其实是 JSONL，那么第一条之后的记录都没有被读进来`,
      },
    })
    ctx.salvage()
  }
  if (suppressed > 0) {
    problems.push({
      at: 0,
      kind: 'malformed-json',
      excerpt: {
        en: `…and ${suppressed} more problems (list truncated)`,
        zh: `……还有 ${suppressed} 处问题（列表已截断）`,
      },
    })
  }

  return {
    shape,
    records: sink.records,
    problems,
    salvaged,
    declaredFormat: declaredFormat ?? declaredFormatOf(sink.first),
  }
}

/** Convenience for tests and for already-in-memory text. */
export function parseText(text: string, options: ParseCoreOptions = {}): Promise<ParseOutcome> {
  return parseStream(onceAsync(text), options)
}

async function* onceAsync(text: string): AsyncIterable<string> {
  yield text
}

async function* replay(
  head: string,
  iterator: AsyncIterator<string>,
  exhausted: boolean,
  onReadError: (error: unknown) => void,
): AsyncIterable<string> {
  if (head) yield head
  if (exhausted) return
  for (;;) {
    let next: IteratorResult<string>
    try {
      next = await iterator.next()
    } catch (error) {
      onReadError(error)
      return
    }
    if (next.done) return
    yield next.value
  }
}

function declaredFormatOf(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const declared = (value as Record<string, unknown>).agentlens_format
  return typeof declared === 'string' ? declared : undefined
}

/* ------------------------------------------------------------------- jsonl */

async function parseLines(chunks: AsyncIterable<string>, sink: Sink, ctx: Ctx): Promise<void> {
  let buf = ''
  let line = 0

  const take = (raw: string) => {
    line++
    const text = raw.trim()
    if (!text || text === ',') return // blank lines and stray separators are not errors
    try {
      sink.push(JSON.parse(text))
    } catch (error) {
      // `JSON.parse`'s own message: the platform's words, quoted, not translated.
      ctx.problem(line, 'malformed-json', verbatim(String((error as Error).message ?? error)), text)
      ctx.salvage()
    }
  }

  for await (const chunk of chunks) {
    buf += chunk
    let start = 0
    let nl = buf.indexOf('\n', start)
    while (nl !== -1) {
      take(buf.slice(start, nl))
      start = nl + 1
      nl = buf.indexOf('\n', start)
    }
    if (start > 0) buf = buf.slice(start)
  }
  if (buf.trim()) take(buf)
}

/* -------------------------------------------------- top-level object shape */

/**
 * A top-level object is one record (index 0), with two exceptions:
 *
 *  1. one key whose value is an array → an envelope; the array's elements are
 *     the records (`{"results": [...]}`, and the RMB log's `{"0": [...]}`);
 *  2. a map of id → record → each entry's **value** is a record, in key order.
 *
 * Why split at all: a map held as one record defeats the virtual list, defeats
 * per-record deep links, and turns a syntax error near the end of the file into
 * "we recovered nothing". Splitting also means an adapter can sniff and read a
 * map-shaped file with exactly the code it uses for an array-shaped one.
 *
 * Why the key is dropped: ParsedRecord carries only `index` and `value`, and
 * wrapping every record in a synthetic `{key: value}` envelope would push that
 * quirk onto every adapter. In the logs we ship, keys are ordinals equal to
 * `index`, so nothing is lost.
 *
 * The walker descends one level here (`nestOneLevel`). Without that, case 1
 * only reaches this function after the whole inner array has survived a single
 * JSON.parse — one bad byte anywhere in a 22 MB envelope would cost every
 * record in it, and the walker's buffer could not compact until the file was
 * fully in memory.
 */
async function collectObject(
  chunks: AsyncIterable<string>,
  sink: Sink,
  ctx: Ctx,
): Promise<string | undefined> {
  const entries: [string, unknown][] = []
  let declaredFormat: string | undefined

  await walkContainer(
    chunks,
    '{',
    (key, value) => {
      const name = key ?? String(entries.length)
      if (name === 'agentlens_format' && typeof value === 'string') declaredFormat = value
      entries.push([name, value])
    },
    ctx,
    true,
  )

  if (entries.length === 1 && Array.isArray(entries[0][1])) {
    for (const value of entries[0][1] as unknown[]) sink.push(value)
  } else if (looksLikeRecordMap(entries)) {
    for (const [, value] of entries) sink.push(value)
  } else if (entries.length > 0) {
    const object: Record<string, unknown> = {}
    for (const [key, value] of entries) object[key] = value
    sink.push(object)
  }
  return declaredFormat
}

const SIGNATURE_SAMPLE = 32

export function looksLikeRecordMap(entries: [string, unknown][]): boolean {
  if (entries.length < 2) return false
  if (entries.some(([key]) => key === 'agentlens_format')) return false
  if (!entries.every(([, value]) => typeof value === 'object' && value !== null)) return false

  if (entries.every(([key]) => /^-?\d+$/.test(key))) return true
  if (entries.every(([, value]) => Array.isArray(value))) return true

  // Otherwise the values must look like instances of one thing, not fields of one thing.
  const sample = entries.slice(0, SIGNATURE_SAMPLE)
  if (sample.some(([, value]) => Array.isArray(value))) return false
  const signature = signatureOf(sample[0][1])
  return signature.length > 0 && sample.every(([, value]) => signatureOf(value) === signature)
}

function signatureOf(value: unknown): string {
  return Object.keys(value as object)
    .sort()
    .join(' ')
}

/* ------------------------------------------- streaming container walker */

type WalkState = 'open' | 'key' | 'colon' | 'value' | 'scan' | 'after' | 'resync' | 'tail'
type ScanKind = 'string' | 'structured' | 'bare'

/** One open container. The root frame has `container: null` — its values are emitted. */
interface Frame {
  open: '[' | '{'
  close: ']' | '}'
  container: unknown[] | Record<string, unknown> | null
  /** Key this frame is stored under in its parent. */
  ownKey: string | null
  /** Key currently being read inside this frame. */
  key: string | null
  sawComma: boolean
}

/**
 * Walks a top-level `[...]` or `{...}` without ever handing the whole document
 * to JSON.parse: a string-aware, escape-aware depth counter finds the extent of
 * each element, and only that element is parsed. One bad element costs one
 * record, not the file.
 *
 * `nestOneLevel` extends that to a structured value of the top-level container
 * (the envelope shape `{"key": [...]}`), so its elements are scanned and parsed
 * one at a time too. Exactly one level: descending into the records themselves
 * would turn a broken field into a silently truncated record, whereas at one
 * level a broken element costs that element — which is the contract everywhere
 * else in this file.
 */
async function walkContainer(
  chunks: AsyncIterable<string>,
  open: '[' | '{',
  emit: (key: string | null, value: unknown) => void,
  ctx: Ctx,
  nestOneLevel = false,
): Promise<void> {
  const rootClose = open === '[' ? ']' : '}'
  const maxDepth = nestOneLevel ? 2 : 1
  const stack: Frame[] = []

  let buf = ''
  let i = 0 // read cursor within buf
  let base = 0 // absolute character offset of buf[0]
  // `as` on the initialiser: `step()` reassigns these from a closure, which
  // control-flow analysis cannot see.
  let state = 'open' as WalkState

  let start = 0 // where the value/key currently being scanned begins
  let scanKind = 'bare' as ScanKind
  let depth = 0
  let inString = false
  let escaped = false
  let readingKey = false

  let closed = false
  let stopped = false // unrecoverable: ignore the rest of the file

  const top = (): Frame => stack[stack.length - 1]
  const at = () => base + i
  const ahead = () => buf.slice(i, i + EXCERPT_CHARS)

  const fail = (kind: ParseProblem['kind'], reason: Str, offset = at(), snippet = ahead()) => {
    ctx.problem(offset, kind, reason, snippet)
    ctx.salvage()
  }

  /** Hand a finished value to the innermost open container. */
  const deliver = (key: string | null, value: unknown) => {
    const frame = top()
    frame.sawComma = false
    if (frame.container === null) emit(key, value)
    else if (Array.isArray(frame.container)) frame.container.push(value)
    else frame.container[key ?? String(Object.keys(frame.container).length)] = value
  }

  const pushFrame = (kind: '[' | '{') => {
    const parent = top()
    const ownKey = parent.key
    parent.key = null
    stack.push({
      open: kind,
      close: kind === '[' ? ']' : '}',
      container: kind === '[' ? [] : {},
      ownKey,
      key: null,
      sawComma: false,
    })
    i++
    state = kind === '{' ? 'key' : 'value'
  }

  /** Close the innermost frame, giving its container to the parent. */
  const popFrame = () => {
    const done = stack.pop()
    if (!done) return
    if (stack.length === 0) {
      closed = true
      state = 'tail'
      return
    }
    deliver(done.ownKey, done.container)
    state = 'after'
  }

  const beginScan = (kind: ScanKind) => {
    start = i
    scanKind = kind
    depth = 0
    inString = false
    escaped = false
    state = 'scan'
  }

  /** Advance to the end of the value that starts at `start`; false = need more input. */
  const scan = (): boolean => {
    const end = buf.length
    if (scanKind === 'bare') {
      while (i < end) {
        const c = buf[i]
        if (c === ',' || c === ']' || c === '}' || isWs(c)) return true
        i++
      }
      return false
    }
    while (i < end) {
      const c = buf[i++]
      if (escaped) {
        escaped = false
      } else if (c === '\\') {
        escaped = inString
      } else if (c === '"') {
        inString = !inString
        if (!inString && scanKind === 'string') return true
      } else if (!inString) {
        if (c === '{' || c === '[') depth++
        else if (c === '}' || c === ']') {
          if (--depth === 0) return true
        }
      }
    }
    return false
  }

  const step = () => {
    for (;;) {
      if (stopped) {
        i = buf.length
        return
      }
      switch (state) {
        case 'open': {
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          if (buf[i] === open) {
            i++
            stack.push({ open, close: rootClose, container: null, ownKey: null, key: null, sawComma: false })
            state = open === '{' ? 'key' : 'value'
          } else {
            fail('malformed-json', wantChar(open))
            stopped = true
          }
          break
        }
        case 'key': {
          const frame = top()
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          const c = buf[i]
          if (c === '}' || c === ']') {
            if (c !== frame.close) fail('malformed-json', wantChar(frame.close))
            else if (frame.sawComma) fail('malformed-json', REASON.trailingComma)
            i++
            popFrame()
          } else if (c === '"') {
            readingKey = true
            beginScan('string')
          } else {
            fail('malformed-json', REASON.wantPropertyName)
            state = 'resync'
            inString = false
            escaped = false
          }
          break
        }
        case 'colon': {
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          if (buf[i] === ':') {
            i++
            state = 'value'
          } else {
            fail('malformed-json', REASON.wantColon)
            state = 'resync'
            inString = false
            escaped = false
          }
          break
        }
        case 'value': {
          const frame = top()
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          const c = buf[i]
          if (c === '}' || c === ']') {
            if (c !== frame.close) fail('malformed-json', wantChar(frame.close))
            else if (frame.sawComma) fail('malformed-json', REASON.trailingComma)
            else if (frame.open === '{') fail('malformed-json', REASON.wantValue)
            i++
            popFrame()
          } else if (c === ',') {
            fail('malformed-json', REASON.emptyElement)
            i++
          } else if ((c === '{' || c === '[') && stack.length < maxDepth) {
            pushFrame(c)
          } else {
            readingKey = false
            beginScan(c === '"' ? 'string' : c === '{' || c === '[' ? 'structured' : 'bare')
          }
          break
        }
        case 'scan': {
          if (!scan()) return
          const text = buf.slice(start, i)
          const frame = top()
          if (readingKey) {
            frame.key = parseKey(text)
            state = 'colon'
          } else {
            try {
              deliver(frame.key, JSON.parse(text))
            } catch (error) {
              fail('malformed-json', verbatim(String((error as Error).message ?? error)), base + start, text)
            }
            frame.key = null
            state = 'after'
          }
          frame.sawComma = false
          break
        }
        case 'after': {
          const frame = top()
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          const c = buf[i]
          if (c === ',') {
            i++
            frame.sawComma = true
            state = frame.open === '{' ? 'key' : 'value'
          } else if (c === frame.close) {
            i++
            popFrame()
          } else {
            fail('malformed-json', REASON.wantCommaOrClose)
            state = 'resync'
            inString = false
            escaped = false
          }
          break
        }
        case 'resync': {
          // Skip junk, string-aware, until something we can restart from: a
          // separator, the closing bracket, or the start of the next entry.
          const frame = top()
          while (i < buf.length) {
            const c = buf[i]
            if (escaped) escaped = false
            else if (c === '\\') escaped = inString
            else if (inString) {
              if (c === '"') inString = false
            } else if (c === ',' || c === frame.close) {
              state = 'after'
              break
            } else if (c === '"') {
              if (frame.open === '{') {
                state = 'key'
                break
              }
              inString = true
            } else if (frame.open === '[' && (c === '{' || c === '[')) {
              state = 'value'
              break
            }
            i++
          }
          if (state === 'resync') return
          break
        }
        case 'tail': {
          while (i < buf.length && isWs(buf[i])) i++
          if (i >= buf.length) return
          fail('malformed-json', REASON.trailingContent)
          stopped = true
          break
        }
      }
    }
  }

  const parseKey = (text: string): string => {
    try {
      return String(JSON.parse(text))
    } catch {
      fail('malformed-json', REASON.badPropertyName, base + start, text)
      return text
    }
  }

  for await (const chunk of chunks) {
    buf += chunk
    step()
    const consumed = state === 'scan' ? start : i
    if (consumed >= COMPACT_AT) {
      buf = buf.slice(consumed)
      base += consumed
      i -= consumed
      start -= consumed
    }
  }

  // End of input. A value still being scanned means the file stopped inside it —
  // usually truncation, but also the aftermath of a stray quote, which flips
  // string parity so the depth counter swallows everything to EOF as one value.
  // Report it, then guess where the next element began and keep going, so the
  // damage costs a segment rather than the whole tail. Every guess is verified
  // by JSON.parse, so a bad guess costs one more reported problem.
  let resyncs = 0
  while (!stopped && state === 'scan' && stack.length > 0) {
    if (scanKind === 'bare' && i > start) {
      try {
        deliver(top().key, JSON.parse(buf.slice(start, i)))
      } catch {
        /* reported as the unterminated value below */
      }
    }
    fail(
      inString ? 'unterminated' : 'unexpected-eof',
      inString ? REASON.unterminatedString : REASON.endedInsideValue,
      base + start,
      buf.slice(start, start + EXCERPT_CHARS),
    )
    if (resyncs++ >= MAX_TAIL_RESYNCS) break
    const frame = top()
    const boundary = nextElementBoundary(buf, start + 1, frame.open)
    if (boundary === -1) break
    i = boundary
    inString = false
    escaped = false
    depth = 0
    readingKey = false
    frame.key = null
    state = frame.open === '{' ? 'key' : 'value'
    step()
  }

  const ranOut = !closed && !stopped
  // Hand back partial containers so a truncated envelope still yields elements.
  while (stack.length > 1) popFrame()
  if (ranOut && state !== 'scan') {
    fail(
      'unexpected-eof',
      { en: `file ended before "${rootClose}"`, zh: `文件在 "${rootClose}" 之前就结束了` },
      at(),
      '',
    )
  }
}

/**
 * Guess where the element after a swallowed value starts: the next `{`/`[` (in
 * an array) or `"` (in an object) whose previous non-whitespace character is a
 * comma. It is a guess — that comma may itself be inside the broken string —
 * but a wrong guess only produces another reported problem, and the caller
 * bounds the number of attempts.
 */
function nextElementBoundary(buf: string, from: number, open: '[' | '{'): number {
  for (let j = from; j < buf.length; j++) {
    const c = buf[j]
    const starts = open === '[' ? c === '{' || c === '[' : c === '"'
    if (!starts) continue
    let k = j - 1
    while (k >= 0 && isWs(buf[k])) k--
    if (k >= 0 && buf[k] === ',') return j
  }
  return -1
}
