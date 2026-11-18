/**
 * Object metadata shared by the cloud disks, in a form both S3 and Azure accept.
 *
 * - Keys: S3 lowercases them; Azure requires C# identifiers. So every key is lowercase
 *   `[a-z][a-z0-9_]*`, prefixed `sv_` for ours and `u_` for the app's.
 * - Values: both providers only allow ASCII, so values are percent-encoded (a non-ASCII client
 *   file name survives the round trip).
 * - Size: S3 allows 2 KB of user metadata in total; the same cap applies everywhere, so a disk
 *   swap never breaks an upload. Metadata is for small, non-sensitive facts only.
 *
 * @module
 */
import type { FileVisibility } from '@strutvane/framework/contracts'

/** The total metadata budget in bytes (S3's limit). */
export const METADATA_LIMIT = 2048

const USER_KEY = /^[a-z][a-z0-9_]{0,62}$/

/** What we store with every object. */
export interface ObjectMetadata {
  readonly sha256?: string
  readonly visibility?: FileVisibility
  readonly createdAt?: string
  readonly originalName?: string
  readonly user?: Readonly<Record<string, string>>
}

/** Encode metadata for a provider. Throws a `RangeError` for bad keys or oversized metadata. */
export function encodeMetadata(meta: ObjectMetadata): Record<string, string> {
  const out: Record<string, string> = {}
  if (meta.sha256) out['sv_sha256'] = meta.sha256
  if (meta.visibility) out['sv_visibility'] = meta.visibility
  if (meta.createdAt) out['sv_created'] = meta.createdAt
  if (meta.originalName !== undefined) out['sv_name'] = encodeURIComponent(meta.originalName)
  for (const [key, value] of Object.entries(meta.user ?? {})) {
    if (!USER_KEY.test(key))
      throw new RangeError(`metadata key "${key}" must match ${USER_KEY} (lowercase, no dashes)`)
    out[`u_${key}`] = encodeURIComponent(value)
  }
  const size = Object.entries(out).reduce((n, [k, v]) => n + k.length + v.length, 0)
  if (size > METADATA_LIMIT)
    throw new RangeError(`object metadata is ${size} bytes; the limit is ${METADATA_LIMIT}`)
  return out
}

function decodeValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Decode provider metadata (keys in any case). Unknown or malformed values are ignored. */
export function decodeMetadata(raw: Readonly<Record<string, string | undefined>>): ObjectMetadata {
  const m: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) m[k.toLowerCase()] = v
  const user: Record<string, string> = {}
  for (const [k, v] of Object.entries(m))
    if (k.startsWith('u_')) user[k.slice(2)] = decodeValue(v) ?? v
  const visibility = m['sv_visibility']
  const sha256 = m['sv_sha256']
  const originalName = decodeValue(m['sv_name'])
  return {
    ...(sha256 && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
    ...(visibility === 'public' || visibility === 'private' ? { visibility } : {}),
    ...(m['sv_created'] ? { createdAt: m['sv_created'] } : {}),
    ...(originalName === undefined ? {} : { originalName }),
    ...(Object.keys(user).length > 0 ? { user } : {}),
  }
}

/** `https://cdn.example.com/` + `a b/c.png` → `https://cdn.example.com/a%20b/c.png`. */
export function publicObjectUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`
}
