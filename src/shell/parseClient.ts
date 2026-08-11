/**
 * Main-thread side of the parser: hand it a File, get a ParsedFile back.
 * Parsing itself never happens on this thread.
 */

import type { ParseRequest, ParseResponse, ParsedFile, ParsedRecord } from '../types'

export interface ParseProgress {
  bytesRead: number
  totalBytes: number
  recordCount: number
}

export interface ParseFileOptions {
  onProgress?: (progress: ParseProgress) => void
  /** Records as they are recovered, for a list that fills while the file loads. */
  onBatch?: (records: ParsedRecord[]) => void
  signal?: AbortSignal
}

export interface ParseFilesOptions extends Omit<ParseFileOptions, 'onProgress' | 'onBatch'> {
  /** Workers to keep alive at once. Dropping a folder of 105 files must not spawn 105. */
  concurrency?: number
  onProgress?: (file: File, progress: ParseProgress) => void
}

const DEFAULT_CONCURRENCY = 4

let sequence = 0

export function parseFile(file: File, options: ParseFileOptions = {}): Promise<ParsedFile> {
  const worker = spawn()
  return request(worker, file, options).finally(() => worker.terminate())
}

/** Parses many files over a small worker pool; resolves in input order. */
export async function parseFiles(files: File[], options: ParseFilesOptions = {}): Promise<ParsedFile[]> {
  if (files.length === 0) return []
  const { concurrency = DEFAULT_CONCURRENCY, onProgress, signal } = options
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, spawn)
  const results: ParsedFile[] = new Array(files.length)
  let next = 0

  try {
    await Promise.all(
      workers.map(async (worker) => {
        for (;;) {
          const index = next++
          if (index >= files.length) return
          const file = files[index]
          results[index] = await request(worker, file, {
            signal,
            onProgress: onProgress && ((progress) => onProgress(file, progress)),
          })
        }
      }),
    )
  } finally {
    for (const worker of workers) worker.terminate()
  }
  return results
}

/** Demo packages arrive over `fetch`; the worker needs a File-shaped thing. */
export function fileFromBlob(blob: Blob, fileName: string): File {
  return new File([blob], fileName, { type: blob.type })
}

// The `new URL(..., import.meta.url)` form is what lets Vite bundle the worker.
const spawn = (): Worker => new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' })

function request(worker: Worker, file: File, options: ParseFileOptions): Promise<ParsedFile> {
  const { onProgress, onBatch, signal } = options

  return new Promise<ParsedFile>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal))
      return
    }

    const id = `parse-${++sequence}`
    const records: ParsedRecord[] = []

    const settle = (run: () => void) => {
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      run()
    }

    const onMessage = (event: MessageEvent<ParseResponse>) => {
      const message = event.data
      if (message.id !== id) return
      switch (message.type) {
        case 'progress':
          onProgress?.({
            bytesRead: message.bytesRead,
            totalBytes: message.totalBytes,
            recordCount: message.recordCount,
          })
          break
        case 'batch':
          for (const record of message.records) records.push(record)
          onBatch?.(message.records)
          break
        case 'done': {
          // The worker streams records as batches and sends `done` with an empty
          // array; honour a non-empty one anyway so the worker stays free to change.
          const result = message.result
          settle(() => resolve({ ...result, records: result.records.length ? result.records : records }))
          break
        }
        case 'error':
          settle(() => reject(new Error(message.message)))
          break
      }
    }

    const onError = (event: ErrorEvent) => {
      settle(() => reject(new Error(event.message || `parse worker failed on ${file.name}`)))
    }

    const onAbort = () => settle(() => reject(abortReason(signal)))

    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })

    const payload: ParseRequest = { id, file }
    worker.postMessage(payload)
  })
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException('Parse aborted', 'AbortError')
}
