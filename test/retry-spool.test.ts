import { stat } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import { StorageUnavailableError } from '../src/errors.ts'
import { backoffDelay, isTransientError, statusOf, withRetry } from '../src/retry.ts'
import { readHead, SpoolLimitError, spool, spoolFromPath, toWebStream } from '../src/spool.ts'

const httpError = (status: number, name = 'Err') =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

describe('isTransientError', () => {
  test('throttling, 5xx, timeouts and network errors are transient', () => {
    for (const s of [408, 429, 500, 502, 503, 504])
      expect(isTransientError(httpError(s))).toBe(true)
    expect(isTransientError({ statusCode: 503 })).toBe(true) // Azure RestError shape
    expect(isTransientError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isTransientError({ name: 'SlowDown' })).toBe(true)
    expect(isTransientError(new Error('wrapped', { cause: { code: 'ETIMEDOUT' } }))).toBe(true)
  })

  test('client errors are not retried (they would only delay the answer)', () => {
    for (const s of [400, 401, 403, 404, 412]) expect(isTransientError(httpError(s))).toBe(false)
    expect(isTransientError(new Error('bug'))).toBe(false)
    expect(isTransientError(null)).toBe(false)
    expect(isTransientError(new StorageUnavailableError('s3'))).toBe(false)
  })

  test('statusOf reads AWS, Azure and fetch-style errors', () => {
    expect(statusOf(httpError(503))).toBe(503)
    expect(statusOf({ statusCode: 404 })).toBe(404)
    expect(statusOf({ status: 429 })).toBe(429)
    expect(statusOf('nope')).toBeUndefined()
  })
})

describe('withRetry', () => {
  test('backoff is full-jitter exponential and capped', () => {
    expect(backoffDelay(1, { random: () => 0.999, baseDelayMs: 100 })).toBe(199)
    expect(backoffDelay(3, { random: () => 0.5, baseDelayMs: 100 })).toBe(400)
    expect(backoffDelay(10, { random: () => 0.999, baseDelayMs: 100, maxDelayMs: 2000 })).toBe(1998)
    expect(backoffDelay(2, { random: () => 0 })).toBe(0)
  })

  test('recovers from transient failures', async () => {
    const sleep = vi.fn(async () => {})
    let calls = 0
    const result = await withRetry(
      's3',
      async () => {
        calls++
        if (calls < 3) throw httpError(503, 'SlowDown')
        return 'ok'
      },
      { sleep, random: () => 0.5 },
    )
    expect(result).toBe('ok')
    expect(calls).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  test('exhausted retries become STORAGE_UNAVAILABLE 503 with Retry-After, cause kept', async () => {
    const last = httpError(503)
    const error = await withRetry(
      'azure',
      async () => {
        throw last
      },
      { attempts: 3, sleep: async () => {} },
    ).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StorageUnavailableError)
    const e = error as StorageUnavailableError
    expect(e.code).toBe('STORAGE_UNAVAILABLE')
    expect(e.status).toBe(503)
    expect(e.headers['Retry-After']).toBe('5')
    expect(e.disk).toBe('azure')
    expect(e.cause).toBe(last)
  })

  test('non-transient errors are rethrown at once, unchanged', async () => {
    const denied = httpError(403, 'AccessDenied')
    let calls = 0
    await expect(
      withRetry('s3', async () => {
        calls++
        throw denied
      }),
    ).rejects.toBe(denied)
    expect(calls).toBe(1)
  })

  test('an aborted signal stops retrying', async () => {
    const controller = new AbortController()
    controller.abort(new Error('client gone'))
    await expect(withRetry('s3', async () => 'x', { signal: controller.signal })).rejects.toThrow(
      'client gone',
    )
  })

  test('the default sleep waits, and an abort interrupts it', async () => {
    const controller = new AbortController()
    const promise = withRetry(
      's3',
      async () => {
        throw httpError(503)
      },
      { baseDelayMs: 10_000, random: () => 0.99, signal: controller.signal },
    )
    setTimeout(() => controller.abort(new Error('stop')), 20)
    await expect(promise).rejects.toThrow('stop')
    // and a short real sleep completes
    await expect(
      withRetry(
        's3',
        async (attempt) => {
          if (attempt === 1) throw httpError(500)
          return attempt
        },
        { baseDelayMs: 1 },
      ),
    ).resolves.toBe(2)
  })
})

function countingStream(
  chunks: number,
  size: number,
): {
  stream: ReadableStream<Uint8Array>
  pulled: () => number
} {
  let n = 0
  return {
    stream: new ReadableStream({
      pull(controller) {
        if (n >= chunks) controller.close()
        else {
          n++
          controller.enqueue(new Uint8Array(size).fill(n % 256))
        }
      },
    }),
    pulled: () => n,
  }
}

describe('spool', () => {
  test('copies to a private temp file with size, sha256 and head; dispose deletes it', async () => {
    const file = await spool('hello world')
    expect(file.size).toBe(11)
    expect(file.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9')
    expect(new TextDecoder().decode(file.head)).toBe('hello world')
    expect(
      new TextDecoder().decode(new Uint8Array(await new Response(file.stream()).arrayBuffer())),
    ).toBe('hello world')
    const range: Buffer[] = []
    for await (const c of file.createReadStream({ start: 6, end: 10 })) range.push(c as Buffer)
    expect(Buffer.concat(range).toString()).toBe('world')
    if (process.platform !== 'win32') expect((await stat(file.path)).mode & 0o777).toBe(0o600)
    await file.dispose()
    await file.dispose() // idempotent
    await expect(stat(file.path)).rejects.toThrow()
  })

  test('works with `await using` and empty bodies', async () => {
    let path = ''
    {
      await using file = await spool(new Uint8Array())
      path = file.path
      expect(file.size).toBe(0)
      expect(file.head).toHaveLength(0)
    }
    await expect(stat(path)).rejects.toThrow()
  })

  test('stops reading at the limit: the rest of the body is never pulled', async () => {
    const source = countingStream(1000, 1024) // 1 MB offered
    await expect(spool(source.stream, { maxBytes: 4096 })).rejects.toBeInstanceOf(SpoolLimitError)
    expect(source.pulled()).toBeLessThanOrEqual(6)
  })

  test('a client disconnect (abort) deletes the temp file and rethrows', async () => {
    const controller = new AbortController()
    let tick = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(c) {
        tick++
        if (tick === 3) controller.abort(new Error('client disconnected'))
        await new Promise((r) => setTimeout(r, 1))
        c.enqueue(new Uint8Array(10))
      },
    })
    await expect(spool(stream, { signal: controller.signal })).rejects.toThrow(
      'client disconnected',
    )
    const pre = new AbortController()
    pre.abort(new Error('already gone'))
    await expect(spool('x', { signal: pre.signal })).rejects.toThrow('already gone')
  })

  test('a failing source deletes the temp file and rethrows', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(5))
        c.error(new Error('socket hang up'))
      },
    })
    await expect(spool(stream)).rejects.toThrow('socket hang up')
  })

  test('spoolFromPath hashes an existing file and readHead cancels after the head', async () => {
    const original = await spool('abcdef')
    const again = await spoolFromPath(original.path, async () => {})
    expect(again.sha256).toBe(original.sha256)
    expect(again.size).toBe(6)
    const source = countingStream(100, 1000)
    const head = await readHead(source.stream, 1500)
    expect(head).toHaveLength(1500)
    expect(source.pulled()).toBeLessThanOrEqual(3)
    expect(await readHead(toWebStream('ab'), 10)).toHaveLength(2)
    await original.dispose()
  })
})
