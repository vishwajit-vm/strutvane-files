/**
 * English messages for the codes this package adds on top of `@strutvane/core`'s built-in
 * catalog (which already has `file_too_large`, `file_empty`, `file_type_not_allowed` and
 * `too_many_files`, plus the error titles). Register it as a package catalog; apps override any
 * key in their own `lang/` files.
 *
 * @module
 */
import { defineMessages, type MessageCatalog } from '@strutvane/core'

/** The package catalog for `en`. */
export const FILES_MESSAGES_EN: MessageCatalog = defineMessages('en', {
  'validation.file_too_small': '{attribute} must be at least {min}.',
  'validation.file_corrupt': '{attribute} could not be read. Please upload a valid file.',
  'validation.image_dimensions_invalid':
    '{attribute} must be between {minWidth}x{minHeight} and {maxWidth}x{maxHeight} pixels.',
  'errors.FILE_INFECTED.detail': 'The file was rejected by the virus scanner.',
  'errors.SCAN_UNAVAILABLE.detail': 'Files cannot be checked right now. Please try again shortly.',
  'errors.STORAGE_UNAVAILABLE.detail':
    'Files cannot be saved right now. Please try again in a moment.',
  'errors.QUOTA_EXCEEDED.detail':
    'This upload needs {requested} bytes, but only {available} of {limit} bytes are free.',
  'errors.UPLOAD_INCOMPLETE.detail': 'The upload did not finish. Please upload the file again.',
})
