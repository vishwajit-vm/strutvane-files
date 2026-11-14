/**
 * `@strutvane/files`: file storage and uploads, layer 3 of RFC-0002.
 *
 * The main entry has no heavy dependencies. Cloud disks, image processing, ClamAV and SQL live
 * in subpaths so apps only load what they use:
 *
 * | Import | What | Needs |
 * |---|---|---|
 * | `@strutvane/files` | file manager, fields, rules, validation, quotas, scan hook, keys, MIME | — |
 * | `@strutvane/files/s3` | `S3Disk` (AWS S3, R2, MinIO, …) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
 * | `@strutvane/files/azure` | `AzureBlobDisk` | `@azure/storage-blob` (+ `@azure/identity`) |
 * | `@strutvane/files/images` | sharp image processor, variant worker | `sharp` |
 * | `@strutvane/files/clamav` | ClamAV scanner | a `clamd` server |
 * | `@strutvane/files/sql` | tables (with RLS), SQL store, SQL quota counter | `pg` or `node:sqlite` |
 *
 * @module
 */
export {
  clampExpiry,
  type DirectUploadTarget,
  type FilesPutOptions,
  type FilesTemporaryUrlOptions,
  isPresigning,
  isSpoolAware,
  type PresigningDisk,
  type PresignUploadOptions,
  putSpooled,
  type SpoolAwareDisk,
} from './disk.ts'
export {
  FILE_ISSUE_CODES,
  FileInfectedError,
  type FileIssue,
  type FileIssueCode,
  FileRejectedError,
  fileIssue,
  QuotaExceededError,
  ScanUnavailableError,
  StorageUnavailableError,
  throwFileIssues,
  UnsafeKeyError,
  UploadIncompleteError,
} from './errors.ts'
export {
  type FileFieldOptions,
  type FileSchemaIssue,
  type FilesFieldOptions,
  type FileValue,
  fileField,
  filesField,
  type ImageFieldOptions,
  imageField,
  isFileId,
} from './fields.ts'
export {
  type ImageFailure,
  type ImageInfo,
  ImageProcessingError,
  type ImageProcessor,
  type SanitizeOptions,
} from './image-processor.ts'
export {
  ImageProcessorMissingError,
  type InspectedUpload,
  type InspectOptions,
  inspectUpload,
} from './inspect.ts'
export {
  assertSafeKey,
  assertSafePrefix,
  assertSafeSegment,
  assertTenantKey,
  contentDisposition,
  type GenerateKeyOptions,
  generateFileKey,
  isSafeKey,
  joinKey,
  MAX_KEY_LENGTH,
  sanitizeFileName,
  tenantPrefix,
} from './keys.ts'
export {
  type AttachInput,
  type CleanupOptions,
  type CleanupReport,
  type ConfirmInput,
  createFileManager,
  type DirectUpload,
  type DirectUploadInput,
  type FileEvent,
  type FileEventPayload,
  type FileEventType,
  type FileManager,
  type FileManagerOptions,
  type StoreInput,
} from './manager.ts'
export { FILES_MESSAGES_EN } from './messages.ts'
export {
  ACTIVE_CONTENT,
  baseMime,
  detectMime,
  EXECUTABLE_CONTENT,
  extensionFor,
  mimeMatches,
  RASTER_IMAGE_TYPES,
  SNIFF_BYTES,
} from './mime.ts'
export {
  createQuotaGuard,
  GLOBAL_QUOTA_KEY,
  MemoryQuotaCounter,
  type QuotaCounter,
  type QuotaGuard,
  type QuotaOptions,
} from './quota.ts'
export {
  type AttachmentFilter,
  FILE_STATUSES,
  type FileAttachment,
  type FileRecord,
  type FileRecordPatch,
  type FileRecordStore,
  type FileStatus,
  MemoryFileStore,
  type StaleQuery,
} from './records.ts'
export {
  backoffDelay,
  isTransientError,
  type RetryOptions,
  statusOf,
  withRetry,
} from './retry.ts'
export {
  DEFAULT_IMAGE_TYPES,
  DEFAULT_RULES,
  ensureResolved,
  type FileRules,
  type FilesRules,
  type ImageRules,
  type ResolvedRules,
  resolveCount,
  resolveRules,
} from './rules.ts'
export {
  type ScanFailurePolicy,
  type ScanStatus,
  type ScanVerdict,
  scanWithPolicy,
  type VirusScanner,
} from './scan.ts'
export { type ByteSize, formatSize, parseSize, type SizeUnit } from './size.ts'
export {
  readHead,
  type SpooledFile,
  SpoolLimitError,
  type SpoolOptions,
  spool,
  spoolFromPath,
  toWebStream,
} from './spool.ts'
export {
  decodeMetadata,
  encodeMetadata,
  METADATA_LIMIT,
  type ObjectMetadata,
  publicObjectUrl,
} from './storage-metadata.ts'
export {
  checkDimensions,
  checkFile,
  checkSize,
  checkType,
  type FileFacts,
  isTypeAllowed,
} from './validate.ts'
export {
  createVariantJob,
  type ResolvedVariant,
  resolveVariants,
  type VariantFormat,
  type VariantJob,
  type VariantSpec,
  type VariantSpecs,
  variantKey,
} from './variants.ts'
