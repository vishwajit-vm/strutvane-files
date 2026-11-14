/**
 * The errors this package throws, all built on `@strutvane/core`'s error classes so the central
 * handler turns them into RFC 9457 problems with catalog messages (RFC-0003).
 *
 * Two kinds of failure exist, and they are deliberately different:
 *
 * - **Field problems** (a file is too big, the wrong type, corrupt): a `ValidationError` with
 *   one issue per file, so a form can show the message next to the right input. Issue codes are
 *   lowercase (`file_too_large`), matching the `validation.*` message keys.
 * - **Operation problems** (storage down, scanner down, virus found, quota exceeded): a single
 *   `StrutvaneError` with the RFC-0002 code (`STORAGE_UNAVAILABLE`, …).
 *
 * Messages are never written here: the catalog renders them from the code and params.
 *
 * @module
 */
import {
  type ErrorParams,
  type IssueInput,
  StrutvaneError,
  type StrutvaneErrorOptions,
  ValidationError,
} from '@strutvane/core'

/** Issue codes for per-file validation problems (keys under `validation.` in the catalog). */
export const FILE_ISSUE_CODES: readonly FileIssueCode[] = [
  'file_too_large',
  'file_too_small',
  'file_empty',
  'file_type_not_allowed',
  'file_corrupt',
  'image_dimensions_invalid',
  'too_many_files',
  'required',
]

/** A per-file validation issue code. */
export type FileIssueCode =
  | 'file_too_large'
  | 'file_too_small'
  | 'file_empty'
  | 'file_type_not_allowed'
  | 'file_corrupt'
  | 'image_dimensions_invalid'
  | 'too_many_files'
  | 'required'

/** A per-file validation problem. */
export interface FileIssue extends IssueInput {
  readonly code: FileIssueCode
}

/** Build a file issue. `path` is where the file sits in the input, e.g. `['attachments', 2]`. */
export function fileIssue(
  code: FileIssueCode,
  path: readonly (string | number)[],
  params?: ErrorParams,
): FileIssue {
  return params ? { code, path, params } : { code, path }
}

/** Throw a 422 `ValidationError` for one or more file issues. */
export function throwFileIssues(issues: readonly FileIssue[]): never {
  throw new ValidationError(issues)
}

type OperationOptions = Omit<StrutvaneErrorOptions, 'params' | 'headers' | 'status'>

function retryAfter(seconds: number): Readonly<Record<string, string>> {
  return { 'Retry-After': String(Math.max(0, Math.ceil(seconds))) }
}

function causeOf(options: OperationOptions): { readonly cause?: unknown } {
  return options.cause === undefined ? {} : { cause: options.cause }
}

/**
 * The storage provider is down or throttling and retries are exhausted. 503 with `Retry-After`.
 * The underlying SDK error is kept as `cause` for logs; it never reaches the client.
 */
export class StorageUnavailableError extends StrutvaneError {
  /** The disk that failed, for logs and metrics. */
  readonly disk: string
  constructor(
    disk: string,
    options: OperationOptions & { readonly retryAfterSeconds?: number } = {},
  ) {
    super('STORAGE_UNAVAILABLE', {
      status: 503,
      ...causeOf(options),
      headers: retryAfter(options.retryAfterSeconds ?? 5),
    })
    this.disk = disk
  }
}

/** The virus scanner could not be reached or did not answer. 503 (the fail-closed default). */
export class ScanUnavailableError extends StrutvaneError {
  constructor(options: OperationOptions & { readonly retryAfterSeconds?: number } = {}) {
    super('SCAN_UNAVAILABLE', {
      status: 503,
      ...causeOf(options),
      headers: retryAfter(options.retryAfterSeconds ?? 30),
    })
  }
}

/**
 * The scanner found malware. 422. The signature name is kept on the error for logs and the audit
 * event, but is *not* a message param: telling an attacker which signature fired helps them
 * iterate on evasion.
 */
export class FileInfectedError extends StrutvaneError {
  readonly signature: string
  constructor(signature: string, options: OperationOptions = {}) {
    super('FILE_INFECTED', { status: 422, ...causeOf(options) })
    this.signature = signature
  }
}

/** Accepting the file would exceed the tenant's storage quota. 422. */
export class QuotaExceededError extends StrutvaneError {
  constructor(params: {
    readonly limit: number
    readonly used: number
    readonly requested: number
  }) {
    super('QUOTA_EXCEEDED', {
      status: 422,
      params: { ...params, available: Math.max(0, params.limit - params.used) },
    })
  }
}

/** A direct upload was confirmed, but the object never arrived (or arrived partially). 400. */
export class UploadIncompleteError extends StrutvaneError {
  constructor(options: OperationOptions = {}) {
    super('UPLOAD_INCOMPLETE', { status: 400, ...causeOf(options) })
  }
}

/**
 * A file was rejected outside of a form field (for example when confirming a direct upload):
 * `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED`, `FILE_EMPTY`, `FILE_CORRUPT` or
 * `IMAGE_DIMENSIONS_INVALID`. 422, per RFC-0002 §4 (field-level size problems are 422, not 413:
 * 413 is for the request body as a whole, which the framework's parser handles).
 */
export class FileRejectedError extends StrutvaneError {
  constructor(
    code:
      | 'FILE_TOO_LARGE'
      | 'FILE_TYPE_NOT_ALLOWED'
      | 'FILE_EMPTY'
      | 'FILE_CORRUPT'
      | 'IMAGE_DIMENSIONS_INVALID',
    params?: ErrorParams,
  ) {
    super(code, { status: 422, ...(params ? { params } : {}) })
  }
}

/**
 * A key that could escape the disk root or confuse a driver (`..`, a leading `/`, backslashes,
 * control characters). Keys are generated by the server, so this is a programming error or an
 * attack, never a user mistake: it maps to a 500 and is logged. Code that resolves a
 * client-supplied key must answer 404 instead (see `assertTenantKey`).
 */
export class UnsafeKeyError extends Error {
  override readonly name = 'UnsafeKeyError'
}
