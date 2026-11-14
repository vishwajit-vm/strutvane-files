/**
 * `@strutvane/files/clamav`: a virus scanner for uploads, using a ClamAV daemon (`clamd`).
 *
 * ```ts
 * const files = createFileManager({ …, scanner: createClamAvScanner({ host: 'clamav' }) })
 * ```
 *
 * @module
 */
export {
  type ClamAvOptions,
  type ClamAvScanner,
  createClamAvScanner,
  parseClamdReply,
} from './scanner.ts'
