/**
 * Per-tenant and per-user storage quotas (RFC-0002 §4: "checked before accepting").
 *
 * Two independent guards exist, and an upload must fit both:
 * - {@link createQuotaGuard}: bytes per tenant (or per app without tenancy);
 * - {@link createOwnerQuotaGuard}: bytes per user *within* a tenant (the file's `ownerId`), so one
 *   user cannot fill the whole tenant's allowance.
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

/** The longest owner id accepted (it is stored in a `varchar(255)` column). */
export const MAX_OWNER_ID_LENGTH = 255

/**
 * Check an owner id before it is used as a counter key or stored: 1 to 255 characters, no control
 * characters. It comes from the app's auth layer, never from the client, but a bad value must
 * still fail loudly instead of creating a strange counter row.
 *
 * @example
 * assertOwnerId('018f2c3e-7b1a-7c00-9d1e-2f3a4b5c6d7e')
 */
export function assertOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== 'string' ||
    ownerId.length === 0 ||
    ownerId.length > MAX_OWNER_ID_LENGTH ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point.
    /[\u0000-\u001f\u007f]/.test(ownerId)
  )
    throw new RangeError('ownerId must be 1-255 characters without control characters')
}

/** Stores usage per (tenant, owner) and reserves bytes atomically. */
export interface OwnerQuotaCounter {
  /** Bytes the owner currently uses in the tenant (including reservations). */
  usage(tenantKey: string, ownerId: string): Promise<number>
  /** Atomically add `bytes` if the result stays within `limit`. */
  reserve(
    tenantKey: string,
    ownerId: string,
    bytes: number,
    limit: number,
  ): Promise<{ readonly ok: boolean; readonly used: number }>
  /** Give bytes back (never below zero). */
  release(tenantKey: string, ownerId: string, bytes: number): Promise<void>
}

/**
 * An in-memory {@link OwnerQuotaCounter} for tests and single-process apps.
 *
 * @example
 * const counter = new MemoryOwnerQuotaCounter()
 */
export class MemoryOwnerQuotaCounter implements OwnerQuotaCounter {
  readonly #inner = new MemoryQuotaCounter()

  // JSON keeps (tenant, owner) pairs distinct even when an id contains the separator.
  #key(tenantKey: string, ownerId: string): string {
    return JSON.stringify([tenantKey, ownerId])
  }

  usage(tenantKey: string, ownerId: string): Promise<number> {
    return this.#inner.usage(this.#key(tenantKey, ownerId))
  }

  reserve(
    tenantKey: string,
    ownerId: string,
    bytes: number,
    limit: number,
  ): Promise<{ readonly ok: boolean; readonly used: number }> {
    return this.#inner.reserve(this.#key(tenantKey, ownerId), bytes, limit)
  }

  release(tenantKey: string, ownerId: string, bytes: number): Promise<void> {
    return this.#inner.release(this.#key(tenantKey, ownerId), bytes)
  }
}

/** Options for {@link createOwnerQuotaGuard}. */
export interface OwnerQuotaOptions {
  readonly counter: OwnerQuotaCounter
  /** Bytes allowed for this owner in this tenant; `undefined` = unlimited (still counted). */
  readonly limitFor: (
    tenantId: string | null,
    ownerId: string,
  ) => number | undefined | Promise<number | undefined>
}

/** Reserves and releases per-owner quota. */
export interface OwnerQuotaGuard {
  /** Reserve bytes or throw `QuotaExceededError`. Returns an idempotent release function. */
  reserve(tenantId: string | null, ownerId: string, bytes: number): Promise<() => Promise<void>>
  release(tenantId: string | null, ownerId: string, bytes: number): Promise<void>
}

/**
 * Create a per-owner quota guard. Files stored without an `ownerId` are not counted here (only in
 * the tenant quota).
 *
 * @example
 * const owners = createOwnerQuotaGuard({
 *   counter: new MemoryOwnerQuotaCounter(),
 *   limitFor: () => 500 * 1024 * 1024, // 500 MB per user
 * })
 */
export function createOwnerQuotaGuard(options: OwnerQuotaOptions): OwnerQuotaGuard {
  const release = (tenantId: string | null, ownerId: string, bytes: number): Promise<void> => {
    assertOwnerId(ownerId)
    return options.counter.release(keyFor(tenantId), ownerId, bytes)
  }
  return {
    async reserve(tenantId, ownerId, bytes) {
      assertOwnerId(ownerId)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new RangeError(`bytes must be a whole number >= 0 (got ${bytes})`)
      const limit = (await options.limitFor(tenantId, ownerId)) ?? Number.MAX_SAFE_INTEGER
      const result = await options.counter.reserve(keyFor(tenantId), ownerId, bytes, limit)
      if (!result.ok)
        throw new QuotaExceededError({ limit, used: result.used, requested: bytes, scope: 'owner' })
      let released = false
      return async () => {
        if (released) return
        released = true
        await release(tenantId, ownerId, bytes)
      }
    },
    release,
  }
}
