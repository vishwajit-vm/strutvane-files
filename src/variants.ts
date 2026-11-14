/**
 * Image variant definitions and queue jobs (RFC-0002: "image variants via sharp, on the queue").
 *
 * Variants are generated *after* the upload, by a queue worker, so a request never waits for
 * resizing. This module holds the serialisable parts (specs, keys, the job payload); the
 * worker-side generator lives in `@strutvane/files/images`.
 *
 * @module
 */
import { assertSafeSegment, joinKey } from './keys.ts'
import type { FileRecord } from './records.ts'

/** Output formats for variants. */
export type VariantFormat = 'webp' | 'avif' | 'jpeg' | 'png'

/** One variant. A `[width, height]` tuple means "cover-crop to exactly this size, as WebP". */
export interface VariantSpec {
  readonly width: number
  readonly height?: number
  /** Default `cover` with a height, `inside` without. */
  readonly fit?: 'cover' | 'contain' | 'inside'
  /** Default `webp`. */
  readonly format?: VariantFormat
  /** 1-100. Default 80. */
  readonly quality?: number
}

/** Variants by name, e.g. `{ thumb: [200, 200], large: { width: 1600 } }`. */
export type VariantSpecs = Readonly<Record<string, VariantSpec | readonly [number, number]>>

/** A variant spec with defaults applied. */
export interface ResolvedVariant {
  readonly name: string
  readonly width: number
  readonly height?: number
  readonly fit: 'cover' | 'contain' | 'inside'
  readonly format: VariantFormat
  readonly quality: number
}

const MAX_VARIANT_SIDE = 10_000

/** Validate and normalise variant specs. Throws a `RangeError` on bad specs (boot-time). */
export function resolveVariants(specs: VariantSpecs): readonly ResolvedVariant[] {
  return Object.entries(specs).map(([name, spec]) => {
    assertSafeSegment(name, 'variant name')
    const s: VariantSpec = Array.isArray(spec)
      ? { width: spec[0] as number, height: spec[1] as number, fit: 'cover' }
      : (spec as VariantSpec)
    for (const [k, v] of [
      ['width', s.width],
      ['height', s.height],
    ] as const) {
      if (v !== undefined && (!Number.isSafeInteger(v) || v < 1 || v > MAX_VARIANT_SIDE))
        throw new RangeError(`variant "${name}": ${k} must be 1-${MAX_VARIANT_SIDE}`)
    }
    const quality = s.quality ?? 80
    if (!Number.isInteger(quality) || quality < 1 || quality > 100)
      throw new RangeError(`variant "${name}": quality must be 1-100`)
    return Object.freeze({
      name,
      width: s.width,
      ...(s.height === undefined ? {} : { height: s.height }),
      fit: s.fit ?? (s.height === undefined ? 'inside' : 'cover'),
      format: s.format ?? 'webp',
      quality,
    })
  })
}

/** The key of a variant: `<key without extension>-<name>.<format>`, next to the original. */
export function variantKey(key: string, name: string, format: VariantFormat): string {
  const slash = key.lastIndexOf('/')
  const dir = key.slice(0, slash + 1)
  const base = key.slice(slash + 1).replace(/\.[^.]+$/, '')
  const ext = format === 'jpeg' ? 'jpg' : format
  return joinKey(`${dir}${base}-${name}.${ext}`)
}

/** The queue job that generates a file's variants. Plain JSON, safe to serialise. */
export interface VariantJob {
  readonly type: 'files.variants'
  readonly fileId: string
  readonly tenantId: string | null
  readonly disk: string
  readonly key: string
  readonly variants: readonly ResolvedVariant[]
}

/** Build the variant job for a stored image. Idempotent: re-running overwrites the same keys. */
export function createVariantJob(record: FileRecord, specs: VariantSpecs): VariantJob {
  return {
    type: 'files.variants',
    fileId: record.id,
    tenantId: record.tenantId,
    disk: record.disk,
    key: record.key,
    variants: resolveVariants(specs),
  }
}
