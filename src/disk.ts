/**
 * Optional disk capabilities beyond the `StorageDisk` contract, implemented by this package's
 * cloud disks and detected at runtime, so any contract-only disk (the framework's `local` and
 * `memory` disks) still works everywhere.
 *
 * @module
 */
import type {
  FileVisibility,
  PutOptions,
  StorageDisk,
  StoredFile,
} from '@strutvane/framework/contracts'
import type { SpooledFile } from './spool.ts'

/** Extra put options understood by this package's disks (ignored by others). */
export interface FilesPutOptions extends PutOptions {
  /** Sanitised client file name, stored with the object for display and downloads. */
  readonly originalName?: string
  /** Stored `Content-Disposition`. Active content is always stored as `attachment`. */
  readonly contentDisposition?: string
  readonly signal?: AbortSignal
}

/** Extra options for signed download URLs. */
export interface FilesTemporaryUrlOptions {
  /** Default 300 (5 minutes, RFC-0002). Clamped to the disk's maximum. */
  readonly expiresInSeconds?: number
  /** Override the response `Content-Disposition` (e.g. force `attachment`). */
  readonly contentDisposition?: string
  /** Override the response `Content-Type`. */
  readonly contentType?: string
}

/** A disk that can upload from a temp file, re-reading it on each retry. */
export interface SpoolAwareDisk extends StorageDisk {
  putFile(key: string, file: SpooledFile, options?: FilesPutOptions): Promise<StoredFile>
}

/** Where and how a browser uploads directly to the provider. */
export interface DirectUploadTarget {
  readonly url: string
  readonly method: 'PUT'
  /** Headers the client MUST send exactly (they are part of the signature or required). */
  readonly headers: Readonly<Record<string, string>>
  /** ISO timestamp after which the URL stops working. */
  readonly expiresAt: string
}

/** Options for {@link PresigningDisk.presignUpload}. */
export interface PresignUploadOptions {
  readonly contentType: string
  /** Exact size in bytes. Signed where the provider supports it (S3); verified on confirm. */
  readonly contentLength: number
  /** Default 300. Clamped to the disk's maximum. */
  readonly expiresInSeconds?: number
  /** Stored with the object. Default `private`. */
  readonly visibility?: FileVisibility
  /** Sanitised client file name, stored with the object. */
  readonly originalName?: string
}

/** A disk that can hand out direct-to-cloud upload URLs. */
export interface PresigningDisk extends StorageDisk {
  presignUpload(key: string, options: PresignUploadOptions): Promise<DirectUploadTarget>
}

/** One uploaded part of a resumable upload, as the provider reports it. */
export interface UploadedPart {
  /** 1-based. */
  readonly partNumber: number
  /** Bytes the provider actually received for this part. */
  readonly size: number
  /** The provider's part identifier (S3 `ETag`; the block id on Azure). */
  readonly etag: string
}

/** Object settings for a resumable upload, applied when the provider creates or commits it. */
export interface MultipartObjectOptions {
  readonly contentType: string
  readonly visibility?: FileVisibility
  readonly originalName?: string
}

/**
 * A disk that supports **resumable** direct uploads through the provider's own multipart
 * protocol (S3 multipart upload, Azure block blobs). The browser uploads each part straight to
 * the provider with its own short-lived signed URL; a lost connection costs one part, not the
 * whole file, and the app server never carries the bytes.
 *
 * Every method takes the storage key the server generated, never a client value.
 */
export interface ResumableDisk extends StorageDisk {
  /** Smallest part the provider accepts (every part except the last). */
  readonly minPartSize: number
  /** Largest part the provider accepts. */
  readonly maxPartSize: number
  /** Most parts one upload may have. */
  readonly maxParts: number
  /** Start a provider-side upload session; resolves to its id. */
  createMultipartUpload(key: string, options: MultipartObjectOptions): Promise<string>
  /**
   * A signed URL for one part. Where the provider can, the exact `contentLength` is part of the
   * signature (S3); otherwise it is verified before the upload is completed (Azure).
   */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { readonly contentLength: number; readonly expiresInSeconds?: number },
  ): Promise<DirectUploadTarget>
  /**
   * The parts the provider has received so far, sorted by part number. Resolves to an empty
   * list for an unknown, aborted or already completed session.
   */
  listUploadedParts(key: string, uploadId: string): Promise<readonly UploadedPart[]>
  /** Assemble the object from exactly these parts (any others are discarded). */
  completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
    options: MultipartObjectOptions,
  ): Promise<void>
  /** Discard the session and its parts. Idempotent: an unknown session is not an error. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>
}

/** Whether a disk implements {@link ResumableDisk}. */
export function isResumable(disk: StorageDisk): disk is ResumableDisk {
  const candidate = disk as Partial<ResumableDisk>
  return (
    typeof candidate.createMultipartUpload === 'function' &&
    typeof candidate.presignUploadPart === 'function' &&
    typeof candidate.listUploadedParts === 'function' &&
    typeof candidate.completeMultipartUpload === 'function' &&
    typeof candidate.abortMultipartUpload === 'function'
  )
}

/** Whether a disk implements {@link SpoolAwareDisk}. */
export function isSpoolAware(disk: StorageDisk): disk is SpoolAwareDisk {
  return typeof (disk as Partial<SpoolAwareDisk>).putFile === 'function'
}

/** Whether a disk implements {@link PresigningDisk}. */
export function isPresigning(disk: StorageDisk): disk is PresigningDisk {
  return typeof (disk as Partial<PresigningDisk>).presignUpload === 'function'
}

/** Store a spooled file on any disk, using the retry-friendly path when the disk has one. */
export function putSpooled(
  disk: StorageDisk,
  key: string,
  file: SpooledFile,
  options: FilesPutOptions = {},
): Promise<StoredFile> {
  return isSpoolAware(disk)
    ? disk.putFile(key, file, options)
    : disk.put(key, file.stream(), options)
}

/** Clamp a requested expiry to `[1, max]`, defaulting to 300 seconds. */
export function clampExpiry(requested: number | undefined, max: number): number {
  const value = requested ?? 300
  if (!Number.isFinite(value) || value <= 0) throw new RangeError('expiresInSeconds must be > 0')
  return Math.min(Math.floor(value) || 1, max)
}
