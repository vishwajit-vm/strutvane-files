/**
 * An S3 `StorageDisk`: AWS S3 and S3-compatible stores (Cloudflare R2, MinIO, Backblaze B2,
 * DigitalOcean Spaces, Wasabi).
 *
 * Design choices, and why:
 * - **Bodies are spooled to a temp file first** (see `spool.ts`): bounded memory, a known
 *   `Content-Length`, and every retry re-reads the file, so retries are idempotent.
 * - **Integrity:** the SHA-256 is sent as `x-amz-checksum-sha256`, so S3 itself rejects a body
 *   that was corrupted in transit. It is also stored as metadata for `stat()`.
 * - **Large files** (above `multipartThreshold`) use multipart upload with per-part retries; a
 *   failed upload is aborted so no invisible parts keep costing money.
 * - **Private by default.** S3 ACLs are deprecated (new buckets enforce "bucket owner"), so
 *   visibility is metadata here: `url()` only answers for `public` files and builds the URL from
 *   `publicUrl` (a CDN or a bucket policy that exposes the public prefix). Private files are
 *   reached only through short-lived signed URLs (default 5 minutes, at most `maxExpirySeconds`).
 * - **Failures:** throttling, 5xx and network errors are retried with backoff + jitter, then
 *   surface as `STORAGE_UNAVAILABLE` (503). Missing objects are `NotFoundError` (404).
 *
 * @module
 */
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { FileBody, FileListPage, StoredFile } from '@strutvane/framework/contracts'
import { NotFoundError } from '@strutvane/framework/core'
import {
  clampExpiry,
  type DirectUploadTarget,
  type FilesPutOptions,
  type FilesTemporaryUrlOptions,
  type PresigningDisk,
  type PresignUploadOptions,
  type SpoolAwareDisk,
} from '../disk.ts'
import { assertSafeKey, assertSafePrefix } from '../keys.ts'
import { type RetryOptions, statusOf, withRetry } from '../retry.ts'
import { type SpooledFile, spool } from '../spool.ts'
import { decodeMetadata, encodeMetadata, publicObjectUrl } from '../storage-metadata.ts'

const MiB = 1024 * 1024

/** Options for {@link S3Disk}. */
export interface S3DiskOptions {
  /** Disk name as configured. Default `"s3"`. */
  readonly name?: string
  readonly bucket: string
  /** A configured client (region, credentials, endpoint). See `createS3Client`. */
  readonly client: S3Client
  /** Optional root inside the bucket, e.g. `"app-prod"`. Keys are stored below it. */
  readonly root?: string
  /** Base URL for public files (a CDN or website endpoint), e.g. `https://cdn.example.com`. */
  readonly publicUrl?: string
  readonly retry?: RetryOptions
  /** Upper bound for signed URL lifetimes. Default 3600 (1 hour). */
  readonly maxExpirySeconds?: number
  /** Files above this size use multipart upload. Default 64 MiB. */
  readonly multipartThreshold?: number
  /** Multipart part size. Default 16 MiB (S3's minimum is 5 MiB). */
  readonly partSize?: number
  /** Server-side encryption. Default: the bucket's default (S3 encrypts with AES256 anyway). */
  readonly serverSideEncryption?: 'AES256' | 'aws:kms'
  readonly kmsKeyId?: string
  /** Send `x-amz-checksum-sha256` on uploads. Default `true`; turn off for stores without it. */
  readonly checksum?: boolean
  /** Parent directory for temp files. */
  readonly tempDir?: string
  /** Injected for tests. */
  readonly now?: () => Date
}

/**
 * Run `send` with a fresh read stream over the file (or a range), and always destroy it after.
 * A request that fails before the body is read would otherwise leave an open file handle, and
 * later an unhandled ENOENT once the temp file is deleted.
 */
async function withBody<T>(
  file: SpooledFile,
  range: { readonly start: number; readonly end: number } | undefined,
  send: (body: ReturnType<SpooledFile['createReadStream']>) => Promise<T>,
): Promise<T> {
  const body = file.createReadStream(range)
  body.on('error', () => {}) // surfaced by the SDK call; never crash the process
  try {
    return await send(body)
  } finally {
    body.destroy()
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'NoSuchKey' || name === 'NotFound' || statusOf(error) === 404
}

/** An S3 disk. See the module docs. */
export class S3Disk implements SpoolAwareDisk, PresigningDisk {
  readonly name: string
  readonly bucket: string
  readonly #client: S3Client
  readonly #root: string
  readonly #options: S3DiskOptions

  constructor(options: S3DiskOptions) {
    if (!options.bucket) throw new TypeError('S3Disk: bucket is required')
    if (options.root !== undefined) assertSafeKey(options.root)
    const partSize = options.partSize ?? 16 * MiB
    if (partSize < 5 * MiB) throw new RangeError('S3Disk: partSize must be at least 5 MiB')
    this.name = options.name ?? 's3'
    this.bucket = options.bucket
    this.#client = options.client
    this.#root = options.root ? `${options.root}/` : ''
    this.#options = options
  }

  #key(key: string): string {
    assertSafeKey(key)
    return `${this.#root}${key}`
  }

  #retry<T>(operation: () => Promise<T>): Promise<T> {
    return withRetry(this.name, operation, this.#options.retry)
  }

  #now(): Date {
    return this.#options.now?.() ?? new Date()
  }

  #encryption(): Record<string, string> {
    const sse = this.#options.serverSideEncryption
    if (!sse) return {}
    return sse === 'aws:kms' && this.#options.kmsKeyId
      ? { ServerSideEncryption: sse, SSEKMSKeyId: this.#options.kmsKeyId }
      : { ServerSideEncryption: sse }
  }

  async put(key: string, body: FileBody, options: FilesPutOptions = {}): Promise<StoredFile> {
    this.#key(key) // validate before reading the body
    await using file = await spool(body, {
      ...(this.#options.tempDir === undefined ? {} : { tempDir: this.#options.tempDir }),
      ...(options.signal ? { signal: options.signal } : {}),
    })
    // `return await`: the temp file must outlive the upload (disposal runs on return).
    return await this.putFile(key, file, options)
  }

  async putFile(
    key: string,
    file: SpooledFile,
    options: FilesPutOptions = {},
  ): Promise<StoredFile> {
    const fullKey = this.#key(key)
    const createdAt = this.#now().toISOString()
    const contentType = options.contentType ?? 'application/octet-stream'
    const visibility = options.visibility ?? 'private'
    const common = {
      Bucket: this.bucket,
      Key: fullKey,
      ContentType: contentType,
      ...(options.contentDisposition ? { ContentDisposition: options.contentDisposition } : {}),
      Metadata: encodeMetadata({
        sha256: file.sha256,
        visibility,
        createdAt,
        ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
        ...(options.metadata ? { user: options.metadata } : {}),
      }),
      ...this.#encryption(),
    }
    const threshold = this.#options.multipartThreshold ?? 64 * MiB
    if (file.size <= threshold) {
      const checksum =
        this.#options.checksum === false
          ? {}
          : { ChecksumSHA256: Buffer.from(file.sha256, 'hex').toString('base64') }
      await this.#retry(() =>
        withBody(file, undefined, (Body) =>
          this.#client.send(
            new PutObjectCommand({ ...common, Body, ContentLength: file.size, ...checksum }),
            options.signal ? { abortSignal: options.signal } : {},
          ),
        ),
      )
    } else {
      await this.#multipart(common, file, options.signal)
    }
    return {
      disk: this.name,
      key,
      size: file.size,
      contentType,
      sha256: file.sha256,
      visibility,
      createdAt,
      ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
    }
  }

  async #multipart(
    common: { readonly Bucket: string; readonly Key: string } & Record<string, unknown>,
    file: SpooledFile,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const partSize = this.#options.partSize ?? 16 * MiB
    const sendOptions = signal ? { abortSignal: signal } : {}
    const created = await this.#retry(() =>
      this.#client.send(new CreateMultipartUploadCommand(common), sendOptions),
    )
    const uploadId = created.UploadId
    if (!uploadId) throw new Error('S3 did not return an UploadId')
    try {
      const parts: { ETag: string; PartNumber: number }[] = []
      for (let offset = 0, n = 1; offset < file.size; offset += partSize, n++) {
        const end = Math.min(offset + partSize, file.size) - 1
        const out = await this.#retry(() =>
          withBody(file, { start: offset, end }, (Body) =>
            this.#client.send(
              new UploadPartCommand({
                Bucket: common.Bucket,
                Key: common.Key,
                UploadId: uploadId,
                PartNumber: n,
                Body,
                ContentLength: end - offset + 1,
              }),
              sendOptions,
            ),
          ),
        )
        if (!out.ETag) throw new Error(`S3 returned no ETag for part ${n}`)
        parts.push({ ETag: out.ETag, PartNumber: n })
      }
      await this.#retry(() =>
        this.#client.send(
          new CompleteMultipartUploadCommand({
            Bucket: common.Bucket,
            Key: common.Key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
          sendOptions,
        ),
      )
    } catch (error) {
      // Abandoned parts are invisible but billed: always abort (best effort).
      await this.#client
        .send(
          new AbortMultipartUploadCommand({
            Bucket: common.Bucket,
            Key: common.Key,
            UploadId: uploadId,
          }),
        )
        .catch(() => {})
      throw error
    }
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const fullKey = this.#key(key)
    try {
      const out = await this.#retry(() =>
        this.#client.send(new GetObjectCommand({ Bucket: this.bucket, Key: fullKey })),
      )
      if (!out.Body) throw new NotFoundError('file')
      return out.Body.transformToWebStream() as ReadableStream<Uint8Array>
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError('file', { cause: error })
      throw error
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== undefined
  }

  async stat(key: string): Promise<StoredFile | undefined> {
    const fullKey = this.#key(key)
    let head: HeadObjectCommandOutput
    try {
      head = await this.#retry(() =>
        this.#client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: fullKey })),
      )
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
    const meta = decodeMetadata(head.Metadata ?? {})
    return {
      disk: this.name,
      key,
      size: head.ContentLength ?? 0,
      contentType: head.ContentType ?? 'application/octet-stream',
      sha256:
        meta.sha256 ??
        (head.ChecksumSHA256 && !head.ChecksumSHA256.includes('-')
          ? Buffer.from(head.ChecksumSHA256, 'base64').toString('hex')
          : ''),
      visibility: meta.visibility ?? 'private',
      createdAt: meta.createdAt ?? (head.LastModified ?? this.#now()).toISOString(),
      ...(meta.originalName === undefined ? {} : { originalName: meta.originalName }),
    }
  }

  async delete(key: string): Promise<void> {
    const fullKey = this.#key(key)
    try {
      await this.#retry(() =>
        this.#client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: fullKey })),
      )
    } catch (error) {
      if (!isNotFound(error)) throw error // deleting a missing file is not an error
    }
  }

  async list(
    prefix: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<FileListPage> {
    assertSafePrefix(prefix)
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 1000)
    const out = await this.#retry(() =>
      this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${this.#root}${prefix}`,
          MaxKeys: limit,
          ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
        }),
      ),
    )
    const keys = (out.Contents ?? [])
      .map((o) => o.Key?.slice(this.#root.length))
      .filter((k): k is string => k !== undefined && k !== '')
    // Listing has no metadata, so stat each object (bounded concurrency).
    const items: StoredFile[] = []
    for (let i = 0; i < keys.length; i += 8) {
      const batch = await Promise.all(keys.slice(i, i + 8).map((k) => this.stat(k)))
      for (const item of batch) if (item) items.push(item)
    }
    return {
      items,
      ...(out.IsTruncated && out.NextContinuationToken
        ? { nextCursor: out.NextContinuationToken }
        : {}),
    }
  }

  async url(key: string): Promise<string> {
    const stat = await this.stat(key)
    if (!stat) throw new NotFoundError('file')
    if (stat.visibility !== 'public' || !this.#options.publicUrl)
      throw new Error(`"${key}" has no public URL on disk "${this.name}"`)
    return publicObjectUrl(this.#options.publicUrl, `${this.#root}${key}`)
  }

  async temporaryUrl(key: string, options: FilesTemporaryUrlOptions = {}): Promise<string> {
    const fullKey = this.#key(key)
    const expiresIn = clampExpiry(options.expiresInSeconds, this.#options.maxExpirySeconds ?? 3600)
    return getSignedUrl(
      this.#client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        ...(options.contentDisposition
          ? { ResponseContentDisposition: options.contentDisposition }
          : {}),
        ...(options.contentType ? { ResponseContentType: options.contentType } : {}),
      }),
      { expiresIn },
    )
  }

  async presignUpload(key: string, options: PresignUploadOptions): Promise<DirectUploadTarget> {
    const fullKey = this.#key(key)
    if (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0)
      throw new RangeError('contentLength must be a whole number of bytes')
    const expiresIn = clampExpiry(options.expiresInSeconds, this.#options.maxExpirySeconds ?? 3600)
    const url = await getSignedUrl(
      this.#client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: fullKey,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
        // Metadata is hoisted into the signed query string, so the browser needn't send it.
        Metadata: encodeMetadata({
          visibility: options.visibility ?? 'private',
          createdAt: this.#now().toISOString(),
          ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
        }),
        ...this.#encryption(),
      }),
      {
        expiresIn,
        // Signed headers: S3 rejects an upload with a different type or size (no "small file
        // presign, huge upload" bypass).
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    )
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': options.contentType,
        'content-length': String(options.contentLength),
      },
      expiresAt: new Date(this.#now().getTime() + expiresIn * 1000).toISOString(),
    }
  }
}
