/**
 * `@strutvane/files/images`: image processing with `sharp` (an optional peer dependency).
 *
 * - {@link createSharpImageProcessor}: decode with a pixel cap, auto-orient, strip metadata.
 *   `createFileManager` loads it automatically when `sharp` is installed.
 * - {@link runVariantJob}: generate thumbnails and other variants from a queue worker.
 *
 * @module
 */
export { createSharpImageProcessor, type SharpProcessorOptions } from './sharp-processor.ts'
export { runVariantJob, type VariantRunOptions } from './variants.ts'
