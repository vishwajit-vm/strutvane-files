/**
 * Spooling: copying an incoming body to a private temp file while hashing, counting and keeping
 * its first bytes.
 *
 * **Why spool instead of streaming straight to the cloud?**
 * - Memory stays bounded whatever the file size (RFC-0002 rejects buffering uploads in memory).
 * - Retries need to re-send the body. A half-consumed network stream cannot be replayed; a file
 *   can, so every retry is idempotent.
 * - Validation (magic bytes, image decoding, virus scanning) must finish *before* anything is
 *   written to storage, so nothing unvalidated ever lands in a bucket.
 * - The size and SHA-256 are known up front, so S3 gets a `Content-Length` and can verify the
 *   checksum on its side.
 *
 * Temp files are created with mode 0600 in a fresh `mkdtemp` directory and are always deleted:
 * on success by the caller (`await using`), on any error here before the error is rethrown.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { createReadStream, type ReadStream } from 'node:fs'
import { mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { FileBody } from '@strutvane/framework/contracts'
import { SNIFF_BYTES } from './mime.ts'

/** A body copied to a temp file. Dispose it (`await using`) to delete the file. */
export interface SpooledFile extends AsyncDisposable {
  /** Absolute path of the temp file. */
  readonly path: string
  readonly size: number
  /** Lowercase hex SHA-256 of the contents. */
  readonly sha256: string
  /** The first {@link SNIFF_BYTES} bytes (or fewer for small files), for MIME detection. */
  readonly head: Uint8Array
  /** A fresh Node stream over the file (or a byte range of it, `end` inclusive). */
  createReadStream(range?: { readonly start: number; readonly end: number }): ReadStream
  /** A fresh Web stream over the whole file. */
  stream(): ReadableStream<Uint8Array>
  /** Delete the temp file and its directory. Safe to call more than once. */
  dispose(): Promise<void>
}

/** Options for {@link spool}. */
export interface SpoolOptions {
  /** Parent directory for temp files. Default: the OS temp directory. */
  readonly tempDir?: string
  /**
   * Stop reading as soon as the body exceeds this many bytes, delete what was written and throw
   * {@link SpoolLimitError}. The rest of the body is never read (RFC-0002: stop at the limit).
   */
  readonly maxBytes?: number
  /** Abort spooling (client disconnected): the temp file is deleted and the reason rethrown. */
  readonly signal?: AbortSignal
}

/** The body was larger than {@link SpoolOptions.maxBytes}. */
export class SpoolLimitError extends Error {
  override readonly name = 'SpoolLimitError'
  readonly limit: number
  constructor(limit: number) {
    super(`body exceeds ${limit} bytes`)
    this.limit = limit
  }
}

/** A Web byte stream for any {@link FileBody}. */
export function toWebStream(body: FileBody): ReadableStream<Uint8Array> {
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) return body
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes)
      controller.close()
    },
  })
}

/** Copy a body to a private temp file. See the module docs for why. */
export async function spool(body: FileBody, options: SpoolOptions = {}): Promise<SpooledFile> {
  options.signal?.throwIfAborted()
  const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'strutvane-files-'))
  const path = join(dir, 'body')
  const remove = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true })
  }
  const reader = toWebStream(body).getReader()
  const onAbort = (): void => {
    reader.cancel(options.signal?.reason).catch(() => {})
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  const hash = createHash('sha256')
  const head = new Uint8Array(SNIFF_BYTES)
  let headLength = 0
  let size = 0
  try {
    // 'wx': fail if the file exists (it cannot, the directory is fresh); 0600: owner only.
    const handle = await open(path, 'wx', 0o600)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        options.signal?.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (options.maxBytes !== undefined && size > options.maxBytes) {
          await reader.cancel().catch(() => {})
          throw new SpoolLimitError(options.maxBytes)
        }
        if (headLength < SNIFF_BYTES) {
          const take = value.subarray(0, SNIFF_BYTES - headLength)
          head.set(take, headLength)
          headLength += take.byteLength
        }
        hash.update(value)
        await handle.write(value)
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    reader.releaseLock()
    await remove()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
  return makeSpooled(path, size, hash.digest('hex'), head.slice(0, headLength), remove)
}

/**
 * Wrap an existing file (e.g. one written by the image pipeline) as a {@link SpooledFile},
 * hashing it once. `dispose` runs `onDispose`.
 */
export async function spoolFromPath(
  path: string,
  onDispose: () => Promise<void>,
): Promise<SpooledFile> {
  const hash = createHash('sha256')
  const head: Uint8Array[] = []
  let headLength = 0
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    hash.update(chunk)
    if (headLength < SNIFF_BYTES) {
      const take = chunk.subarray(0, SNIFF_BYTES - headLength)
      head.push(take)
      headLength += take.byteLength
    }
  }
  const { size } = await stat(path)
  return makeSpooled(path, size, hash.digest('hex'), new Uint8Array(Buffer.concat(head)), onDispose)
}

function makeSpooled(
  path: string,
  size: number,
  sha256: string,
  head: Uint8Array,
  remove: () => Promise<void>,
): SpooledFile {
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposed ??= remove()
    return disposed
  }
  return {
    path,
    size,
    sha256,
    head,
    createReadStream: (range) => createReadStream(path, range ? { ...range } : {}),
    stream: () => Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
    dispose,
    [Symbol.asyncDispose]: dispose,
  }
}

/**
 * Read up to `limit` bytes from the start of a stream, then cancel it so the rest is never
 * downloaded. Used to sniff the type of an object that is already in storage.
 */
export async function readHead(
  stream: ReadableStream<Uint8Array>,
  limit: number = SNIFF_BYTES,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const out = new Uint8Array(limit)
  let length = 0
  try {
    while (length < limit) {
      const { done, value } = await reader.read()
      if (done) break
      const take = value.subarray(0, limit - length)
      out.set(take, length)
      length += take.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return out.slice(0, length)
}
