/**
 * File rules: what a field (or an upload endpoint) accepts. They are plain data, so the same
 * rules drive server validation, the OpenAPI schema and the UI dropzone's hints.
 *
 * @module
 */
import { type ByteSize, parseSize } from './size.ts'

/** Image-specific rules. */
export interface ImageRules {
  readonly minWidth?: number
  readonly minHeight?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
  /**
   * Global pixel cap (width × height), checked from the header *before* decoding: the guard
   * against decompression bombs (a 50 KB PNG that inflates to 10 GB of pixels). Default 40 MP.
   */
  readonly maxPixels?: number
  /**
   * Remove EXIF/XMP/IPTC metadata (GPS location, camera serials, author names) by re-encoding.
   * Default `true` (privacy by default, RFC-0002 §4). The EXIF orientation is applied to the
   * pixels first, so photos keep their correct rotation.
   */
  readonly stripMetadata?: boolean
}

/** Rules for one file. */
export interface FileRules {
  /**
   * Allowed types, checked against the type detected from the file's bytes: exact types
   * (`application/pdf`) or families (`image/*`). Default: any type except active content and
   * executables (which need their own opt-ins below).
   */
  readonly accept?: readonly string[]
  /** Maximum size. Default `'25MB'`. */
  readonly maxSize?: ByteSize
  /** Minimum size. Default `1` byte, i.e. empty files are rejected; use `0` to allow them. */
  readonly minSize?: ByteSize
  /**
   * Allow SVG, HTML and XML (they can carry scripts: stored XSS). Default `false`. When allowed,
   * such files are always served as attachments with a sandbox CSP, never inline.
   */
  readonly allowActiveContent?: boolean
  /** Allow executables and macro-capable legacy Office files. Default `false`. */
  readonly allowExecutables?: boolean
  /** Image checks. Raster images are always decoded (corruption + pixel cap) and stripped. */
  readonly image?: ImageRules
}

/** Rules for a multi-file field. */
export interface FilesRules extends FileRules {
  /** Maximum number of files. Default 10. */
  readonly maxCount?: number
  /** Minimum number of files. Default 0. */
  readonly minCount?: number
}

/** Rules with defaults applied and sizes in bytes. */
export interface ResolvedRules {
  readonly accept: readonly string[]
  readonly maxSize: number
  readonly minSize: number
  readonly allowActiveContent: boolean
  readonly allowExecutables: boolean
  readonly image: Required<Pick<ImageRules, 'maxPixels' | 'stripMetadata'>> &
    Omit<ImageRules, 'maxPixels' | 'stripMetadata'>
}

/** Defaults, mirroring `config/filesystems.ts` (`uploads.maxFileSize: '25MB'`). */
export const DEFAULT_RULES: {
  readonly maxSize: number
  readonly minSize: number
  readonly maxPixels: number
  readonly maxCount: number
} = Object.freeze({
  maxSize: 25 * 1024 * 1024,
  minSize: 1,
  maxPixels: 40_000_000,
  maxCount: 10,
})

/** Image types accepted by `imageField` when no `accept` is given. */
export const DEFAULT_IMAGE_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

function positiveInt(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
    throw new RangeError(`${name} must be a whole number >= 1 (got ${value})`)
}

const RESOLVED = new WeakSet<object>()

/** Resolve rules unless they already are (resolving twice is harmless but wasteful). */
export function ensureResolved(rules: FileRules | ResolvedRules | undefined): ResolvedRules {
  if (rules !== undefined && RESOLVED.has(rules)) return rules as ResolvedRules
  return resolveRules(rules as FileRules | undefined)
}

/**
 * Apply defaults and validate the rules themselves. Throws a `RangeError` for impossible rules
 * (e.g. `minSize` above `maxSize`), so misconfiguration fails at boot, not on the first upload.
 */
export function resolveRules(rules: FileRules = {}): ResolvedRules {
  const maxSize = rules.maxSize === undefined ? DEFAULT_RULES.maxSize : parseSize(rules.maxSize)
  const minSize = rules.minSize === undefined ? DEFAULT_RULES.minSize : parseSize(rules.minSize)
  if (minSize > maxSize) throw new RangeError(`minSize (${minSize}) is above maxSize (${maxSize})`)
  const accept = rules.accept ?? ['*/*']
  if (accept.length === 0) throw new RangeError('accept must list at least one type')
  for (const a of accept) {
    if (!/^(\*\/\*|[a-z0-9][a-z0-9.+-]*\/(\*|[a-z0-9][a-z0-9.+-]*))$/i.test(a))
      throw new RangeError(`accept entry "${a}" is not a MIME type or family such as image/*`)
  }
  const image = rules.image ?? {}
  for (const k of ['minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'maxPixels'] as const)
    positiveInt(image[k], `image.${k}`)
  if ((image.minWidth ?? 0) > (image.maxWidth ?? Number.POSITIVE_INFINITY))
    throw new RangeError('image.minWidth is above image.maxWidth')
  if ((image.minHeight ?? 0) > (image.maxHeight ?? Number.POSITIVE_INFINITY))
    throw new RangeError('image.minHeight is above image.maxHeight')
  const resolved: ResolvedRules = Object.freeze({
    accept: Object.freeze([...accept]),
    maxSize,
    minSize,
    allowActiveContent: rules.allowActiveContent ?? false,
    allowExecutables: rules.allowExecutables ?? false,
    image: Object.freeze({
      ...image,
      maxPixels: image.maxPixels ?? DEFAULT_RULES.maxPixels,
      stripMetadata: image.stripMetadata ?? true,
    }),
  })
  RESOLVED.add(resolved)
  return resolved
}

/** Resolve multi-file count limits. */
export function resolveCount(rules: FilesRules = {}): {
  readonly min: number
  readonly max: number
} {
  const max = rules.maxCount ?? DEFAULT_RULES.maxCount
  const min = rules.minCount ?? 0
  positiveInt(max, 'maxCount')
  if (!Number.isSafeInteger(min) || min < 0) throw new RangeError('minCount must be >= 0')
  if (min > max) throw new RangeError(`minCount (${min}) is above maxCount (${max})`)
  return { min, max }
}
