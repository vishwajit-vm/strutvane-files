/**
 * Worker-side variant generation with sharp. Run it from a queue job (see `createVariantJob`).
 *
 * The original is spooled to a temp file once, then each variant is decoded with the same pixel
 * cap as uploads, auto-oriented, resized (never enlarged), re-encoded without metadata and
 * stored next to the original. Re-running a job overwrites the same keys, so retries are safe.
 *
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageDisk, StoredFile } from '@strutvane/framework/contracts'
import sharp from 'sharp'
import { putSpooled } from '../disk.ts'
import { DEFAULT_RULES } from '../rules.ts'
import { spool, spoolFromPath } from '../spool.ts'
import { type VariantJob, variantKey } from '../variants.ts'
import { disableFileCache } from './sharp-processor.ts'

/** Options for {@link runVariantJob}. */
export interface VariantRunOptions {
  /** Disks by name (the job names its disk). */
  readonly disks: Readonly<Record<string, StorageDisk>>
  /** Pixel cap for decoding the original. Default 40 MP. */
  readonly maxPixels?: number
  readonly tempDir?: string
}

/** Generate every variant of a job. Returns the stored variants by name. */
export async function runVariantJob(
  job: VariantJob,
  options: VariantRunOptions,
): Promise<Readonly<Record<string, StoredFile>>> {
  const disk = options.disks[job.disk]
  if (!disk) throw new RangeError(`Unknown disk "${job.disk}"`)
  disableFileCache()
  const maxPixels = options.maxPixels ?? DEFAULT_RULES.maxPixels
  const tempOpts = options.tempDir === undefined ? {} : { tempDir: options.tempDir }
  await using original = await spool(await disk.get(job.key), tempOpts)
  const results: Record<string, StoredFile> = {}
  for (const variant of job.variants) {
    const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'strutvane-variant-'))
    const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true })
    try {
      const out = join(dir, 'variant')
      await sharp(original.path, { limitInputPixels: maxPixels, failOn: 'error' })
        .rotate()
        .resize({
          width: variant.width,
          ...(variant.height === undefined ? {} : { height: variant.height }),
          fit: variant.fit,
          withoutEnlargement: true,
        })
        .toFormat(variant.format, { quality: variant.quality })
        .toFile(out)
      await using file = await spoolFromPath(out, cleanup)
      const key = variantKey(job.key, variant.name, variant.format)
      results[variant.name] = await putSpooled(disk, key, file, {
        contentType: `image/${variant.format}`,
        visibility: (await disk.stat(job.key))?.visibility ?? 'private',
      })
    } finally {
      await cleanup()
    }
  }
  return results
}
