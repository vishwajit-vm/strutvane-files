/**
 * The `sharp` (libvips) implementation of {@link ImageProcessor}.
 *
 * Decoding happens in two steps on purpose:
 * 1. Read only the header and refuse the image if `width × height` exceeds the pixel cap. A
 *    decompression bomb (a tiny file that claims 50 000 × 50 000 pixels) is refused here, before
 *    a single pixel is allocated.
 * 2. Fully decode with `limitInputPixels` (a second, independent guard) and `failOn: 'error'`
 *    (truncated or corrupt data fails instead of producing a half-grey image), apply the EXIF
 *    orientation to the pixels, and re-encode in the same format. sharp writes no metadata unless
 *    asked, so EXIF (including GPS), XMP and IPTC are gone from the copy.
 *
 * @module
 */
import type { FormatEnum, Metadata } from 'sharp'
import sharp from 'sharp'
import {
  type ImageInfo,
  ImageProcessingError,
  type ImageProcessor,
  type SanitizeOptions,
} from '../image-processor.ts'

/** sharp output formats by MIME type. */
const FORMATS: Readonly<Record<string, keyof FormatEnum | 'avif'>> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/tiff': 'tiff',
}

/** MIME types by the format name sharp reports. */
const MIME_BY_FORMAT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heif: 'image/avif',
  avif: 'image/avif',
  tiff: 'image/tiff',
}

/**
 * libvips keeps recently used *files* open in its operation cache. Temp files must be deleted
 * right after processing (and Windows refuses to delete an open file), so the file part of the
 * cache is turned off. The in-memory operation cache is left as configured by the app.
 */
export function disableFileCache(): void {
  sharp.cache({ files: 0 })
}

/** Options for {@link createSharpImageProcessor}. */
export interface SharpProcessorOptions {
  /** JPEG/WebP/AVIF quality for re-encoding (1-100). Default 90: visually lossless for photos. */
  readonly quality?: number
}

/** Create the sharp-based image processor. */
export function createSharpImageProcessor(options: SharpProcessorOptions = {}): ImageProcessor {
  const quality = options.quality ?? 90
  disableFileCache()
  return {
    async sanitize(
      inputPath: string,
      outputPath: string,
      opts: SanitizeOptions,
    ): Promise<ImageInfo> {
      let meta: Metadata
      try {
        // Header only: no pixel buffers are allocated here.
        meta = await sharp(inputPath, { limitInputPixels: false }).metadata()
      } catch (cause) {
        throw new ImageProcessingError('corrupt', { cause })
      }
      const mime = meta.format ? MIME_BY_FORMAT[meta.format] : undefined
      const format = mime ? FORMATS[mime] : undefined
      const width = meta.autoOrient?.width ?? meta.width
      const height = meta.autoOrient?.height ?? meta.height
      if (!mime || !format || !width || !height) throw new ImageProcessingError('corrupt')
      const frameHeight = meta.pageHeight ?? height
      // Per frame against the cap; animations also get a total budget (64 full-size frames), so
      // thousands of tiny frames cannot add up to a bomb either.
      const framePixels = width * frameHeight
      if (framePixels > opts.maxPixels || framePixels * (meta.pages ?? 1) > opts.maxPixels * 64)
        throw new ImageProcessingError('too-many-pixels', { width, height })
      const animated = (meta.pages ?? 1) > 1
      try {
        let pipeline = sharp(inputPath, {
          limitInputPixels: opts.maxPixels * (animated ? (meta.pages ?? 1) : 1),
          failOn: 'error',
          animated,
        }).rotate() // apply EXIF orientation to the pixels before the tag is dropped
        if (!opts.stripMetadata) pipeline = pipeline.keepMetadata()
        pipeline =
          format === 'jpeg'
            ? pipeline.jpeg({ quality, mozjpeg: true })
            : format === 'webp'
              ? pipeline.webp({ quality })
              : format === 'avif'
                ? pipeline.avif({ quality })
                : pipeline.toFormat(format)
        await pipeline.toFile(outputPath)
      } catch (cause) {
        if (cause instanceof Error && /pixel limit/i.test(cause.message))
          throw new ImageProcessingError('too-many-pixels', { cause, width, height })
        throw new ImageProcessingError('corrupt', { cause })
      }
      return { width, height, mime }
    },
  }
}
