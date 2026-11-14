/**
 * The image-processing seam. The upload pipeline only knows this interface; the `sharp`-based
 * implementation lives in `@strutvane/files/images`, so apps that never handle images don't
 * need the native dependency.
 *
 * @module
 */

/** What decoding an image revealed. */
export interface ImageInfo {
  readonly width: number
  readonly height: number
  /** MIME type of the written copy (same format as the input). */
  readonly mime: string
}

/** Why an image could not be processed. */
export type ImageFailure = 'corrupt' | 'too-many-pixels'

/** Thrown by an {@link ImageProcessor} for images it refuses to process. */
export class ImageProcessingError extends Error {
  override readonly name = 'ImageProcessingError'
  readonly reason: ImageFailure
  readonly width: number | undefined
  readonly height: number | undefined
  constructor(
    reason: ImageFailure,
    options: { readonly cause?: unknown; readonly width?: number; readonly height?: number } = {},
  ) {
    super(reason === 'corrupt' ? 'image could not be decoded' : 'image exceeds the pixel limit', {
      cause: options.cause,
    })
    this.reason = reason
    this.width = options.width
    this.height = options.height
  }
}

/** Options for {@link ImageProcessor.sanitize}. */
export interface SanitizeOptions {
  /** Refuse images above this many pixels, judged from the header before decoding. */
  readonly maxPixels: number
  /** Drop EXIF/XMP/IPTC/ICC-comment metadata (orientation is applied to the pixels first). */
  readonly stripMetadata: boolean
}

/** Decodes, checks and re-encodes images. */
export interface ImageProcessor {
  /**
   * Fully decode `inputPath` (proving it is not corrupt), refuse it if it has too many pixels,
   * and write a re-encoded copy in the same format to `outputPath`.
   * Throws {@link ImageProcessingError}.
   */
  sanitize(inputPath: string, outputPath: string, options: SanitizeOptions): Promise<ImageInfo>
}
