/**
 * Per-tenant storage quotas (RFC-0002 §4: "checked before accepting").
 *
 * A {@link QuotaCounter} keeps bytes used per tenant and can *reserve* bytes atomically: the
 * check and the increment happen in one step, so two concurrent uploads can never both squeeze
 * under the limit. Reservations are released when an upload fails or a file is purged.
 *
 * Counters are pluggable: {@link MemoryQuotaCounter} for tests and single-process apps, and the
 * SQL counter in `@strutvane/files/sql` (one atomic `UPDATE … WHERE used + n <= limit`).
 *
 * @module
 */
import { QuotaExceededError } from './errors.ts'

/** Key used for quotas when the app has no tenancy. */
export const GLOBAL_QUOTA_KEY = '__global__'

/** Stores usage and reserves bytes atomically. */
export interface QuotaCounter {
  /** Bytes currently used (including reservations). */
  usage(tenantKey: string): Promise<number>
  /**
   * Add `bytes` only if the result stays `<= limit`. Returns whether it did, and the usage seen.
   * MUST be atomic with respect to concurrent calls.
   */
  reserve(
    tenantKey: string,
    bytes: number,
    limit: number,
  ): Promise<{ readonly ok: boolean; readonly used: number }>
  /** Subtract `bytes` (never below zero). */
  release(tenantKey: string, bytes: number): Promise<void>
}

/** In-memory counter. Atomic because each call runs synchronously between awaits. */
export class MemoryQuotaCounter implements QuotaCounter {
  readonly #used = new Map<string, number>()

  async usage(tenantKey: string): Promise<number> {
    return this.#used.get(tenantKey) ?? 0
  }

  async reserve(
    tenantKey: string,
    bytes: number,
    limit: number,
  ): Promise<{ readonly ok: boolean; readonly used: number }> {
    const used = this.#used.get(tenantKey) ?? 0
    if (used + bytes > limit) return { ok: false, used }
    this.#used.set(tenantKey, used + bytes)
    return { ok: true, used: used + bytes }
  }

  async release(tenantKey: string, bytes: number): Promise<void> {
    const used = this.#used.get(tenantKey) ?? 0
    this.#used.set(tenantKey, Math.max(0, used - bytes))
  }
}

/** Quota settings. */
export interface QuotaOptions {
  readonly counter: QuotaCounter
  /** Bytes allowed for a tenant (`null` = no tenancy); `undefined` means unlimited. */
  readonly limitFor: (tenantId: string | null) => number | undefined | Promise<number | undefined>
}

/** Applies a quota policy on top of a counter. */
export interface QuotaGuard {
  /** Reserve bytes or throw {@link QuotaExceededError}. Returns a release function (idempotent). */
  reserve(tenantId: string | null, bytes: number): Promise<() => Promise<void>>
  /** Give back bytes for a file that was deleted for good. */
  release(tenantId: string | null, bytes: number): Promise<void>
}

const keyFor = (tenantId: string | null): string => tenantId ?? GLOBAL_QUOTA_KEY

/** Create a {@link QuotaGuard}. */
export function createQuotaGuard(options: QuotaOptions): QuotaGuard {
  const release = (tenantId: string | null, bytes: number): Promise<void> =>
    options.counter.release(keyFor(tenantId), bytes)
  return {
    async reserve(tenantId, bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new RangeError(`bytes must be a whole number >= 0 (got ${bytes})`)
      // Unlimited tenants are still counted, so usage is right if a limit is introduced later
      // and purges never release bytes that were not reserved.
      const limit = (await options.limitFor(tenantId)) ?? Number.MAX_SAFE_INTEGER
      const result = await options.counter.reserve(keyFor(tenantId), bytes, limit)
      if (!result.ok) throw new QuotaExceededError({ limit, used: result.used, requested: bytes })
      let released = false
      return async () => {
        if (released) return
        released = true
        await release(tenantId, bytes)
      }
    },
    release,
  }
}
