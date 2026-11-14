/**
 * Upload inspection: everything that must be true about a file *before* it is written to
 * storage (RFC-0002 §3–4).
 *
 * 1. Size: empty / too small / too large.
 * 2. Type: detected from magic bytes and matched against the allow-list. The client's file name
 *    and `Content-Type` are ignored, so a renamed `.exe` posing as `.pdf` is refused.
 * 3. Raster images: fully decoded with a pixel cap checked from the header first
 *    (decompression bombs), then re-encoded without metadata (GPS location removed), then the
 *    `dimensions` rules are applied.
 *
 * Any problem throws a 422 `ValidationError` whose issue points at `path`.
 *
 * @module
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileIssue, throwFileIssues } from './errors.ts'
import { ImageProcessingError, type ImageProcessor } from './image-processor.ts'
import { ACTIVE_CONTENT, detectMime, RASTER_IMAGE_TYPES } from './mime.ts'
import type { ResolvedRules } from './rules.ts'
import { type SpooledFile, spoolFromPath } from './spool.ts'
import { checkDimensions, checkSize, checkType } from './validate.ts'

/** Image types without an embedded metadata block worth stripping. */
const METADATA_FREE_IMAGES: ReadonlySet<string> = new Set(['image/bmp'])

/** Options for {@link inspectUpload}. */
export interface InspectOptions {
  /** Where the file sits in the input, for the issue path. Default `[]`. */
  readonly path?: readonly (string | number)[]
  /** Needed for raster images. Without one, raster images are refused (fail closed). */
  readonly imageProcessor?: ImageProcessor | undefined
  /** Parent directory for the sanitised copy. Default: the OS temp directory. */
  readonly tempDir?: string
}

/** The result of a successful inspection. Dispose it to delete the sanitised copy, if any. */
export interface InspectedUpload extends AsyncDisposable {
  /** The bytes to store: the original, or its sanitised copy for raster images. */
  readonly file: SpooledFile
  readonly detectedMime: string
  readonly width?: number
  readonly height?: number
  /** Whether `file` is a re-encoded copy (metadata stripped). */
  readonly sanitized: boolean
  dispose(): Promise<void>
}

/** Thrown when a raster image arrives but no image processor is configured. */
export class ImageProcessorMissingError extends Error {
  override readonly name = 'ImageProcessorMissingError'
  constructor() {
    super(
      'A raster image was uploaded but no image processor is configured, so it cannot be ' +
        'checked or stripped of metadata. Install the optional peer "sharp" and pass ' +
        '`imageProcessor: createSharpImageProcessor()` (from "@strutvane/files/images"), or set ' +
        '`image: { stripMetadata: false }` and accept the risk explicitly.',
    )
  }
}

/** Inspect a spooled upload. See the module docs. */
export async function inspectUpload(
  file: SpooledFile,
  rules: ResolvedRules,
  options: InspectOptions = {},
): Promise<InspectedUpload> {
  const path = options.path ?? []
  const sizeIssues = checkSize(file.size, rules, path)
  if (sizeIssues.length > 0) throwFileIssues(sizeIssues)
  const detectedMime = detectMime(file.head)
  const typeIssues = checkType(detectedMime, rules, path)
  if (typeIssues.length > 0) throwFileIssues(typeIssues)

  const plain = (): InspectedUpload => ({
    file,
    detectedMime,
    sanitized: false,
    dispose: async () => {},
    [Symbol.asyncDispose]: async () => {},
  })

  if (
    !detectedMime.startsWith('image/') ||
    METADATA_FREE_IMAGES.has(detectedMime) ||
    ACTIVE_CONTENT.has(detectedMime) // SVG: text, allowed only by explicit opt-in, served as attachment
  )
    return plain()
  if (!RASTER_IMAGE_TYPES.has(detectedMime)) {
    // e.g. HEIC: allowed by the list, but we cannot decode or strip it.
    if (rules.image.stripMetadata) throwFileIssues(typeIssuesFor(detectedMime, rules, path))
    return plain()
  }
  const processor = options.imageProcessor
  if (!processor) {
    if (rules.image.stripMetadata) throw new ImageProcessorMissingError()
    return plain()
  }

  const dir = await mkdtemp(join(options.tempDir ?? tmpdir(), 'strutvane-img-'))
  const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true })
  try {
    const outPath = join(dir, 'image')
    const info = await processor.sanitize(file.path, outPath, {
      maxPixels: rules.image.maxPixels,
      stripMetadata: rules.image.stripMetadata,
    })
    const dimensionIssues = checkDimensions(info.width, info.height, rules, path)
    if (dimensionIssues.length > 0) throwFileIssues(dimensionIssues)
    const sanitizedFile = await spoolFromPath(outPath, cleanup)
    return {
      file: sanitizedFile,
      detectedMime,
      width: info.width,
      height: info.height,
      sanitized: true,
      dispose: sanitizedFile.dispose,
      [Symbol.asyncDispose]: sanitizedFile.dispose,
    }
  } catch (error) {
    await cleanup()
    if (error instanceof ImageProcessingError) {
      if (error.reason === 'too-many-pixels')
        throwFileIssues(
          checkDimensions(error.width ?? rules.image.maxPixels, error.height ?? 2, rules, path),
        )
      throwFileIssues([fileIssue('file_corrupt', path)])
    }
    throw error
  }
}

function typeIssuesFor(
  detectedMime: string,
  rules: ResolvedRules,
  path: readonly (string | number)[],
): ReturnType<typeof checkType> {
  return [
    fileIssue('file_type_not_allowed', path, {
      accept: rules.accept.join(', '),
      detected: detectedMime,
    }),
  ]
}
