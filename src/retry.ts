/**
 * Retries with exponential backoff and full jitter, for calls to storage providers.
 *
 * **Why full jitter?** When a provider throttles, every client retrying on the same schedule
 * hammers it again at the same instant. Picking a random delay in `[0, cap]` spreads retries
 * out; it is the approach AWS recommends for its own SDKs.
 *
 * **Idempotency:** only operations that are safe to repeat may be retried. Every disk operation
 * here is (a PUT of the same bytes to the same key, a GET, a HEAD, a DELETE), and bodies are
 * re-read from a temp file on each attempt, never from a half-consumed stream.
 *
 * @module
 */
import { StorageUnavailableError } from './errors.ts'

/** Retry settings. */
export interface RetryOptions {
  /** Total attempts, including the first. Default 4. `1` disables retries. */
  readonly attempts?: number
  /** Base delay in ms. Default 100. */
  readonly baseDelayMs?: number
  /** Upper bound for one delay in ms. Default 2000. */
  readonly maxDelayMs?: number
  /** Decides whether an error is worth retrying. Default {@link isTransientError}. */
  readonly isRetryable?: (error: unknown) => boolean
  /** Injected for tests. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Injected for tests; returns a number in `[0, 1)`. */
  readonly random?: () => number
  /** Stops waiting and retrying when aborted. */
  readonly signal?: AbortSignal
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'RequestTimeout',
  'RequestTimeTooSkewed',
  'InternalError',
  'ServiceUnavailable',
  'ServerBusy',
  'OperationTimedOut',
  'TimeoutError',
])

function field(error: unknown, name: string): unknown {
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)[name]
    : undefined
}

/** The HTTP status carried by an SDK error (AWS `$metadata.httpStatusCode`, Azure `statusCode`). */
export function statusOf(error: unknown): number | undefined {
  const meta = field(error, '$metadata')
  const candidates = [
    field(meta, 'httpStatusCode'),
    field(error, 'statusCode'),
    field(error, 'status'),
  ]
  for (const c of candidates) if (typeof c === 'number') return c
  return undefined
}

/**
 * Network failures, timeouts, throttling (429, `SlowDown`) and 5xx are transient. Client errors
 * (4xx such as "access denied" or "not found") are not: retrying them only delays the answer.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof StorageUnavailableError) return false // already retried below us
  const status = statusOf(error)
  if (status !== undefined) return RETRYABLE_STATUS.has(status)
  for (const name of ['code', 'name', 'Code']) {
    const value = field(error, name)
    if (typeof value === 'string' && RETRYABLE_CODES.has(value)) return true
  }
  const cause = field(error, 'cause')
  return cause !== undefined && cause !== error ? isTransientError(cause) : false
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/** The delay before retry number `attempt` (1-based): random in `[0, min(max, base·2^attempt)]`. */
export function backoffDelay(
  attempt: number,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = options.baseDelayMs ?? 100
  const cap = Math.min(options.maxDelayMs ?? 2000, base * 2 ** attempt)
  return Math.floor((options.random ?? Math.random)() * cap)
}

/**
 * Run `operation`, retrying transient failures. When attempts run out on a transient failure,
 * throws {@link StorageUnavailableError} (503 + `Retry-After`) with the last error as `cause`.
 * Non-transient errors are rethrown unchanged on the first occurrence.
 */
export async function withRetry<T>(
  disk: string,
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 4))
  const isRetryable = options.isRetryable ?? isTransientError
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal))
  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted()
    try {
      return await operation(attempt)
    } catch (error) {
      if (!isRetryable(error)) throw error
      last = error
      if (attempt < attempts) await sleep(backoffDelay(attempt, options))
    }
  }
  throw new StorageUnavailableError(disk, { cause: last })
}
