import { readFile } from 'node:fs/promises'
import { ValidationError } from '@strutvane/framework/core'
import sharp from 'sharp'
import { describe, expect, test } from 'vitest'
import { ImageProcessingError, type ImageProcessor } from '../src/image-processor.ts'
import { createSharpImageProcessor } from '../src/images/sharp-processor.ts'
import { runVariantJob } from '../src/images/variants.ts'
import { ImageProcessorMissingError, inspectUpload } from '../src/inspect.ts'
import type { FileRecord } from '../src/records.ts'
import { resolveRules } from '../src/rules.ts'
import { spool } from '../src/spool.ts'
import { createVariantJob, resolveVariants, variantKey } from '../src/variants.ts'
import {
  containsAscii,
  EXE,
  EXIF_MARKER,
  jpegWithGps,
  PDF,
  png,
  pngBomb,
  SVG,
  truncatedJpeg,
} from './helpers/fixtures.ts'
import { MemoryDisk, readAll } from './helpers/memory-disk.ts'

const processor = createSharpImageProcessor()

async function issueOf(
  promise: Promise<unknown>,
): Promise<{ code: string; params?: unknown; path: unknown }> {
  const error = await promise.catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ValidationError)
  const issue = (error as ValidationError).issues[0]
  if (!issue) throw new Error('no issue')
  return issue
}

describe('inspectUpload: type checks use magic bytes', () => {
  test('a renamed .exe posing as .pdf is refused', async () => {
    await using file = await spool(EXE)
    const issue = await issueOf(
      inspectUpload(file, resolveRules({ accept: ['application/pdf'] }), { path: ['pdf'] }),
    )
    expect(issue).toMatchObject({ code: 'file_type_not_allowed', path: ['pdf'] })
    expect(issue.params).toMatchObject({ detected: 'application/x-msdownload' })
  })

  test('an executable is refused even by accept: */*', async () => {
    await using file = await spool(EXE)
    expect((await issueOf(inspectUpload(file, resolveRules()))).code).toBe('file_type_not_allowed')
  })

  test('SVG with script is refused by image/* unless explicitly allowed', async () => {
    await using file = await spool(SVG)
    expect((await issueOf(inspectUpload(file, resolveRules({ accept: ['image/*'] })))).code).toBe(
      'file_type_not_allowed',
    )
    const allowed = await inspectUpload(
      file,
      resolveRules({ accept: ['image/svg+xml'], allowActiveContent: true }),
    )
    expect(allowed.detectedMime).toBe('image/svg+xml')
    expect(allowed.sanitized).toBe(false)
  })

  test('size problems are reported before type problems', async () => {
    await using empty = await spool('')
    expect((await issueOf(inspectUpload(empty, resolveRules()))).code).toBe('file_empty')
    await using pdf = await spool(PDF)
    expect((await issueOf(inspectUpload(pdf, resolveRules({ maxSize: 10 })))).code).toBe(
      'file_too_large',
    )
    const ok = await inspectUpload(pdf, resolveRules({ accept: ['application/pdf'] }))
    expect(ok).toMatchObject({ detectedMime: 'application/pdf', sanitized: false })
    await ok.dispose()
  })
})

describe('raster images: decode, pixel cap, metadata stripping', () => {
  test('EXIF GPS and other metadata are removed; orientation is applied to the pixels', async () => {
    const original = await jpegWithGps()
    expect(containsAscii(original, EXIF_MARKER)).toBe(true)
    expect((await sharp(original).metadata()).exif).toBeDefined()
    await using file = await spool(original)
    await using inspected = await inspectUpload(file, resolveRules({ accept: ['image/*'] }), {
      imageProcessor: processor,
    })
    expect(inspected.sanitized).toBe(true)
    expect(inspected.file).not.toBe(file)
    const cleaned = new Uint8Array(await readFile(inspected.file.path))
    expect(containsAscii(cleaned, EXIF_MARKER)).toBe(false)
    expect(containsAscii(cleaned, 'Exif')).toBe(false)
    const meta = await sharp(cleaned).metadata()
    expect(meta.exif).toBeUndefined()
    expect(meta.orientation).toBeUndefined()
    // 40×20 with orientation 6 (rotate 90°) becomes 20×40 pixels.
    expect([meta.width, meta.height]).toEqual([20, 40])
    expect([inspected.width, inspected.height]).toEqual([20, 40])
    expect(inspected.file.sha256).not.toBe(file.sha256)
  })

  test('stripMetadata: false keeps metadata (explicit opt-out)', async () => {
    await using file = await spool(await jpegWithGps())
    await using inspected = await inspectUpload(
      file,
      resolveRules({ image: { stripMetadata: false } }),
      { imageProcessor: processor },
    )
    expect(containsAscii(new Uint8Array(await readFile(inspected.file.path)), EXIF_MARKER)).toBe(
      true,
    )
  })

  test('decompression bomb: 50 000 × 50 000 PNG is refused from its header, before decoding', async () => {
    const bomb = pngBomb()
    expect(bomb.length).toBeLessThan(200)
    await using file = await spool(bomb)
    const started = performance.now()
    const issue = await issueOf(inspectUpload(file, resolveRules(), { imageProcessor: processor }))
    expect(issue.code).toBe('image_dimensions_invalid')
    expect(issue.params).toMatchObject({ width: 50_000, height: 50_000, maxPixels: 40_000_000 })
    expect(performance.now() - started).toBeLessThan(2000) // no 7.5 GB allocation happened
  })

  test('a corrupt (truncated) image is FILE_CORRUPT, not a half-grey picture', async () => {
    await using file = await spool(await truncatedJpeg())
    expect(
      (await issueOf(inspectUpload(file, resolveRules(), { imageProcessor: processor }))).code,
    ).toBe('file_corrupt')
    const header = await png()
    await using garbage = await spool(new Uint8Array([...header.slice(0, 16), 1, 2, 3, 4]))
    expect(
      (await issueOf(inspectUpload(garbage, resolveRules(), { imageProcessor: processor }))).code,
    ).toBe('file_corrupt')
  })

  test('dimension rules apply to the oriented image', async () => {
    await using file = await spool(await png(300, 100))
    const issue = await issueOf(
      inspectUpload(file, resolveRules({ image: { maxWidth: 200 } }), {
        imageProcessor: processor,
      }),
    )
    expect(issue).toMatchObject({ code: 'image_dimensions_invalid' })
    await using small = await spool(await png(10, 10))
    expect(
      (
        await issueOf(
          inspectUpload(small, resolveRules({ image: { minWidth: 50 } }), {
            imageProcessor: processor,
          }),
        )
      ).code,
    ).toBe('image_dimensions_invalid')
  })

  test('without an image processor, raster images fail closed with a developer error', async () => {
    await using file = await spool(await png())
    await expect(inspectUpload(file, resolveRules())).rejects.toBeInstanceOf(
      ImageProcessorMissingError,
    )
    const passthrough = await inspectUpload(file, resolveRules({ image: { stripMetadata: false } }))
    expect(passthrough.sanitized).toBe(false)
  })

  test('HEIC (cannot be stripped) is refused unless stripping is turned off; BMP passes', async () => {
    const heic = new Uint8Array(64)
    heic.set([0, 0, 0, 0x20, ...new TextEncoder().encode('ftypheic')])
    await using h = await spool(heic)
    expect((await issueOf(inspectUpload(h, resolveRules({ accept: ['image/*'] })))).code).toBe(
      'file_type_not_allowed',
    )
    expect(
      (
        await inspectUpload(
          h,
          resolveRules({ accept: ['image/*'], image: { stripMetadata: false } }),
        )
      ).sanitized,
    ).toBe(false)
    const bmp = new Uint8Array(64)
    bmp.set([0x42, 0x4d])
    await using b = await spool(bmp)
    expect((await inspectUpload(b, resolveRules({ accept: ['image/bmp'] }))).sanitized).toBe(false)
  })

  test('processor errors map to issues; unknown errors propagate', async () => {
    const failing = (error: unknown): ImageProcessor => ({
      sanitize: async () => {
        throw error
      },
    })
    await using file = await spool(await png())
    expect(
      (
        await issueOf(
          inspectUpload(file, resolveRules(), {
            imageProcessor: failing(new ImageProcessingError('too-many-pixels')),
          }),
        )
      ).code,
    ).toBe('image_dimensions_invalid')
    await expect(
      inspectUpload(file, resolveRules(), {
        imageProcessor: failing(new Error('libvips crashed')),
      }),
    ).rejects.toThrow('libvips crashed')
  })

  test('animated GIFs keep their frames and are capped per frame', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 10, height: 10, channels: 4, background } })
        .png()
        .toBuffer()
    const animated = await sharp([await frame('#f00'), await frame('#0f0'), await frame('#00f')], {
      join: { animated: true },
    })
      .gif()
      .toBuffer()
    expect((await sharp(animated).metadata()).pages).toBe(3)
    await using file = await spool(new Uint8Array(animated))
    await using inspected = await inspectUpload(file, resolveRules({ image: { maxPixels: 150 } }), {
      imageProcessor: processor,
    })
    expect(inspected.detectedMime).toBe('image/gif')
    expect([inspected.width, inspected.height]).toEqual([10, 10]) // per frame
    const out = await sharp(await readFile(inspected.file.path), { animated: true }).metadata()
    expect(out.pages).toBe(3) // frames kept
    // 10×10 = 100 pixels per frame: a 50-pixel cap refuses it.
    const issue = await issueOf(
      inspectUpload(file, resolveRules({ image: { maxPixels: 50 } }), {
        imageProcessor: processor,
      }),
    )
    expect(issue.code).toBe('image_dimensions_invalid')
  })

  test('every supported raster format round-trips through the sanitiser', async () => {
    const base = sharp({ create: { width: 8, height: 8, channels: 3, background: '#123456' } })
    for (const [format, mime] of [
      ['png', 'image/png'],
      ['jpeg', 'image/jpeg'],
      ['webp', 'image/webp'],
      ['avif', 'image/avif'],
      ['tiff', 'image/tiff'],
      ['gif', 'image/gif'],
    ] as const) {
      const bytes = new Uint8Array(await base.clone().toFormat(format).toBuffer())
      await using file = await spool(bytes)
      await using inspected = await inspectUpload(file, resolveRules(), {
        imageProcessor: processor,
      })
      expect(inspected.detectedMime).toBe(mime)
      expect(inspected.sanitized).toBe(true)
    }
  })
})

describe('variants (queue job)', () => {
  test('specs are validated and normalised', () => {
    expect(
      resolveVariants({ thumb: [200, 200], large: { width: 1600, format: 'jpeg', quality: 70 } }),
    ).toEqual([
      { name: 'thumb', width: 200, height: 200, fit: 'cover', format: 'webp', quality: 80 },
      { name: 'large', width: 1600, fit: 'inside', format: 'jpeg', quality: 70 },
    ])
    expect(() => resolveVariants({ '../x': [1, 1] })).toThrow()
    expect(() => resolveVariants({ a: { width: 0 } })).toThrow(/width/)
    expect(() => resolveVariants({ a: { width: 10, quality: 101 } })).toThrow(/quality/)
    expect(variantKey('tenants/t/a/0190.png', 'thumb', 'webp')).toBe('tenants/t/a/0190-thumb.webp')
    expect(variantKey('x', 'big', 'jpeg')).toBe('x-big.jpg')
  })

  test('the worker generates resized, stripped variants next to the original (idempotent)', async () => {
    const disk = new MemoryDisk('local')
    const key = 'tenants/t1/avatars/0190.jpg'
    await disk.put(key, await jpegWithGps(), { contentType: 'image/jpeg', visibility: 'public' })
    const record = { id: 'f1', tenantId: 't1', disk: 'local', key } as FileRecord
    const job = createVariantJob(record, { thumb: [10, 10], wide: { width: 400, format: 'png' } })
    expect(JSON.parse(JSON.stringify(job))).toEqual(job) // serialisable for the queue
    const out = await runVariantJob(job, { disks: { local: disk } })
    expect(Object.keys(out)).toEqual(['thumb', 'wide'])
    const thumb = await readAll(await disk.get('tenants/t1/avatars/0190-thumb.webp'))
    const meta = await sharp(thumb).metadata()
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(['webp', 10, 10, undefined])
    expect(containsAscii(thumb, EXIF_MARKER)).toBe(false)
    const wide = await sharp(
      await readAll(await disk.get('tenants/t1/avatars/0190-wide.png')),
    ).metadata()
    expect([wide.width, wide.height]).toEqual([20, 40]) // never enlarged, orientation applied
    expect(out['thumb']?.visibility).toBe('public')
    await runVariantJob(job, { disks: { local: disk } }) // re-run overwrites the same keys
    expect(disk.objects.size).toBe(3)
    await expect(
      runVariantJob({ ...job, disk: 'nope' }, { disks: { local: disk } }),
    ).rejects.toThrow(/Unknown disk/)
  })
})
