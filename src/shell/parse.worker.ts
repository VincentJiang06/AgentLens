/**
 * Module worker: File in, ParseResponse messages out.
 *
 * One request at a time per worker — `parseClient` never sends a second file
 * until the first is done.
 */

import type { ParseRequest, ParseResponse } from '../types'
import { parseStream } from './parse'

const BATCH_SIZE = 256
const PROGRESS_EVERY_MS = 100

// Typed narrowly because the app's TS lib is DOM: there is no
// DedicatedWorkerGlobalScope to reach for here.
const scope = self as unknown as { postMessage(message: unknown): void }
const post = (message: ParseResponse): void => scope.postMessage(message)

self.addEventListener('message', (event) => {
  void run(event.data as ParseRequest)
})

async function run({ id, file }: ParseRequest): Promise<void> {
  const totalBytes = file.size
  let bytesRead = 0
  let recordCount = 0
  let sentBytes = -1
  let sentRecords = -1
  let sentAt = 0

  // Time-throttled rather than byte-throttled: a File may arrive as one chunk
  // (then only the record count moves) or as hundreds (then only bytes move).
  const reportProgress = (force = false) => {
    const now = Date.now()
    if (!force && now - sentAt < PROGRESS_EVERY_MS) return
    if (bytesRead === sentBytes && recordCount === sentRecords) return
    sentAt = now
    sentBytes = bytesRead
    sentRecords = recordCount
    post({ id, type: 'progress', bytesRead, totalBytes, recordCount })
  }

  try {
    const outcome = await parseStream(
      chunksOf(file, (read) => {
        bytesRead = read
        reportProgress()
      }),
      {
        // Records leave as `batch` messages; the worker never holds the file.
        retainRecords: false,
        batchSize: BATCH_SIZE,
        onBatch: (records) => {
          recordCount += records.length
          post({ id, type: 'batch', records })
          reportProgress()
        },
      },
    )

    reportProgress(true)
    post({
      id,
      type: 'done',
      result: {
        fileName: file.name,
        size: totalBytes,
        shape: outcome.shape,
        problems: outcome.problems,
        salvaged: outcome.salvaged,
        declaredFormat: outcome.declaredFormat,
        // Already delivered as batches — re-sending would structured-clone 20MB twice.
        records: [],
      },
    })
  } catch (error) {
    post({ id, type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

async function* chunksOf(file: File, onBytes: (bytesRead: number) => void): AsyncIterable<string> {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder('utf-8')
  let read = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      read += value.byteLength
      onBytes(read)
      // stream:true so a multi-byte character split across chunks survives.
      const text = decoder.decode(value, { stream: true })
      if (text) yield text
    }
  } finally {
    reader.releaseLock()
  }
  const tail = decoder.decode()
  if (tail) yield tail
}
