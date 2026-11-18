/**
 * Storage keys and file names (RFC-0002 §4).
 *
 * A key is the *only* thing that decides where a file lives, so it is validated strictly and is
 * never derived from a client file name. Keys this package generates look like
 * `tenants/<tenant>/<resource>/<uuidv7>.<ext>` (or `shared/<resource>/…` without tenancy):
 * lowercase, `/`-separated and identical on every driver and file system.
 *
 * The validation rules intentionally match `@strutvane/framework`'s local and memory disks, so a
 * key that works on one disk works on all of them.
 *
 * @module
 */
import { NotFoundError, uuidv7 } from '@strutvane/framework/core'
import { UnsafeKeyError } from './errors.ts'
import { extensionFor } from './mime.ts'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,127}$/

/** Maximum key length in bytes (S3 allows 1024; Azure allows 1024 characters). */
export const MAX_KEY_LENGTH = 1024

/**
 * Validate a key: `/`-separated segments of `[A-Za-z0-9._=-]`, each starting with a letter or
 * digit (so no `.`/`..` and no hidden files), no leading or trailing `/`, no backslashes, no
 * control characters, at most {@link MAX_KEY_LENGTH} characters. Throws {@link UnsafeKeyError}.
 */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH)
    throw new UnsafeKeyError(`key must be 1-${MAX_KEY_LENGTH} characters`)
  for (const segment of key.split('/')) {
    if (!SEGMENT.test(segment))
      throw new UnsafeKeyError(`unsafe key segment in "${printable(key)}"`)
  }
}

/** Whether a key passes {@link assertSafeKey}. */
export function isSafeKey(key: string): boolean {
  try {
    assertSafeKey(key)
    return true
  } catch {
    return false
  }
}

/** Validate a key prefix used for listing (`""` or a safe key, optionally ending in `/`). */
export function assertSafePrefix(prefix: string): void {
  if (prefix === '') return
  assertSafeKey(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)
}

/** Validate one key segment (a tenant id or resource name used to build keys). */
export function assertSafeSegment(segment: string, what: string): void {
  if (typeof segment !== 'string' || !SEGMENT.test(segment))
    throw new UnsafeKeyError(`unsafe ${what} "${printable(String(segment))}" for a storage key`)
}

function printable(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing control characters is the point.
  return s.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 80)
}

/** Join key segments, validating the result. Empty parts are skipped. */
export function joinKey(...parts: readonly string[]): string {
  const key = parts.filter((p) => p !== '').join('/')
  assertSafeKey(key)
  return key
}

/**
 * The key prefix that holds every file of one tenant (`tenants/<id>/`), or `shared/` when the
 * app has no tenancy (`tenantId` is `null`). The trailing slash matters: it stops tenant `a1`
 * from matching tenant `a10`'s files in a prefix comparison.
 */
export function tenantPrefix(tenantId: string | null): string {
  if (tenantId === null) return 'shared/'
  assertSafeSegment(tenantId, 'tenant id')
  return `tenants/${tenantId}/`
}

/** Options for {@link generateFileKey}. */
export interface GenerateKeyOptions {
  /** The tenant, or `null` without tenancy. */
  readonly tenantId: string | null
  /** Logical group, e.g. `"invoices"` or `"users.avatar"`. */
  readonly resource: string
  /** The detected MIME type; decides the extension. Never the client's file name. */
  readonly contentType?: string
  /** Id generator (UUIDv7 by default: time-ordered, unguessable, lowercase). */
  readonly id?: () => string
}

/**
 * Generate a fresh key: `tenants/<tenant>/<resource>/<uuidv7>.<ext>`. The extension comes from
 * the *detected* type, so a renamed executable never gets a `.pdf` key.
 */
export function generateFileKey(options: GenerateKeyOptions): string {
  assertSafeSegment(options.resource, 'resource')
  const ext = options.contentType ? extensionFor(options.contentType) : undefined
  const id = (options.id ?? uuidv7)()
  return joinKey(`${tenantPrefix(options.tenantId)}${options.resource}`, ext ? `${id}.${ext}` : id)
}

/**
 * Resolve a key that came from a client (a URL, a form value, a confirm request) for a tenant.
 * Anything unsafe or outside the tenant's prefix is answered with a 404 `NotFoundError`, never a
 * 403: a different answer would confirm that another tenant's file exists (RFC-0002 §4).
 */
export function assertTenantKey(key: string, tenantId: string | null): string {
  if (!isSafeKey(key) || !key.startsWith(tenantPrefix(tenantId))) throw new NotFoundError('file')
  return key
}

/**
 * Sanitise a client file name for display and `Content-Disposition`: NFC-normalised, path parts
 * and control/bidi-override characters removed, leading dots and spaces dropped, at most 200
 * characters, never empty. The result is *never* used as a storage key.
 */
export function sanitizeFileName(name: string | undefined): string {
  const base = (name ?? '').normalize('NFC').split(/[\\/]/).pop() ?? ''
  const clean = base
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
  const short = [...clean].slice(0, 200).join('') // by code point: never split a surrogate pair
  return short === '' ? 'file' : short
}

/**
 * A `Content-Disposition` header value for a file name: an ASCII fallback plus the RFC 5987
 * `filename*` form, so non-ASCII names survive and no quote or newline can break the header.
 */
export function contentDisposition(
  type: 'attachment' | 'inline',
  name: string | undefined,
): string {
  const safe = sanitizeFileName(name)
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
