/**
 * An Azure Blob Storage `StorageDisk`.
 *
 * Design choices, and why:
 * - **Managed identity first.** With `auth: 'managed-identity'` (see `createAzureBlobDisk`) there
 *   is no secret at all; signed URLs then use a *user delegation key* (signed by Entra ID,
 *   revocable, at most 7 days) instead of the account key.
 * - **Bodies are spooled to a temp file** and uploaded with `uploadFile` (parallel blocks); a
 *   retry re-reads the file, so it is idempotent.
 * - **Private by default.** Containers should not allow anonymous access. `url()` only answers
 *   for `public` files and uses `publicUrl` (a CDN) when set. Private files are reached through
 *   short-lived SAS URLs (default 5 minutes, at most `maxExpirySeconds`, HTTPS only, read only).
 * - **Uploads can't overwrite.** Upload SAS URLs carry only the *create* permission, so once
 *   the server has verified and scanned a blob, a client still holding the URL cannot replace it.
 * - **Resumable direct uploads** use block blobs: each part is a `Put Block` with its own SAS
 *   URL, and the server commits the block list itself after checking every block's size (a SAS
 *   cannot pin a size). Uncommitted blocks of an abandoned upload are discarded by Azure after
 *   7 days; there is no API to delete them earlier.
 * - **Failures:** throttling (503 ServerBusy), 5xx and network errors are retried with backoff +
 *   jitter, then surface as `STORAGE_UNAVAILABLE` (503). Missing blobs are `NotFoundError` (404).
 *
 * @module
 */
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  BlobSASPermissions,
  type BlobServiceClient,
  type ContainerClient,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from '@azure/storage-blob'
import type { FileBody, FileListPage, StoredFile } from '@strutvane/framework/contracts'
import { NotFoundError } from '@strutvane/framework/core'
import {
  clampExpiry,
  type DirectUploadTarget,
  type FilesPutOptions,
  type FilesTemporaryUrlOptions,
  type MultipartObjectOptions,
  type PresigningDisk,
  type PresignUploadOptions,
  type ResumableDisk,
  type SpoolAwareDisk,
  type UploadedPart,
} from '../disk.ts'
import { assertSafeKey, assertSafePrefix } from '../keys.ts'
import { type RetryOptions, statusOf, withRetry } from '../retry.ts'
import { type SpooledFile, spool } from '../spool.ts'
import { decodeMetadata, encodeMetadata, publicObjectUrl } from '../storage-metadata.ts'

/** Options for {@link AzureBlobDisk}. */
export interface AzureBlobDiskOptions {
  /** Disk name as configured. Default `"azure"`. */
  readonly name?: string
  readonly container: ContainerClient
  /**
   * Needed for signed URLs when the container client does not use an account key (managed
   * identity / Entra ID): the user delegation key is requested from it.
   */
  readonly serviceClient?: BlobServiceClient
  /** Optional root inside the container. */
  readonly root?: string
  /** Base URL for public files (a CDN). Default: the blob URL. */
  readonly publicUrl?: string
  readonly retry?: RetryOptions
  /** Upper bound for SAS lifetimes. Default 3600 (1 hour). */
  readonly maxExpirySeconds?: number
  /** Allow `http` SAS URLs. Only for local emulators (Azurite). Default `false`. */
  readonly allowHttp?: boolean
  /** Block size for uploads. Default 8 MiB. */
  readonly blockSize?: number
  /** Parallel block uploads. Default 4. */
  readonly concurrency?: number
  readonly tempDir?: string
  /** Injected for tests. */
  readonly now?: () => Date
}

const MiB = 1024 * 1024

/** A resumable upload id: 24 lowercase hex characters (it prefixes every block id). */
const UPLOAD_ID = /^[0-9a-f]{24}$/

/** Clock-skew allowance: a SAS starts slightly in the past so it works on a fast client clock. */
const SKEW_MS = 5 * 60_000

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'BlobNotFound' || code === 'ContainerNotFound' || statusOf(error) === 404
}

/** An Azure Blob disk. See the module docs. */
export class AzureBlobDisk implements SpoolAwareDisk, PresigningDisk, ResumableDisk {
  readonly name: string
  /** Azure has no minimum block size; 1 byte keeps the contract honest. */
  readonly minPartSize: number = 1
  /** Azure's largest block (4000 MiB). */
  readonly maxPartSize: number = 4000 * MiB
  /** Azure's block limit per blob. */
  readonly maxParts: number = 50_000
  readonly #container: ContainerClient
  readonly #root: string
  readonly #options: AzureBlobDiskOptions
  #delegationKey: { readonly key: UserDelegationKey; readonly expires: number } | undefined

  constructor(options: AzureBlobDiskOptions) {
    if (options.root !== undefined) assertSafeKey(options.root)
    this.name = options.name ?? 'azure'
    this.#container = options.container
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

  async put(key: string, body: FileBody, options: FilesPutOptions = {}): Promise<StoredFile> {
    this.#key(key)
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
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    const createdAt = this.#now().toISOString()
    const contentType = options.contentType ?? 'application/octet-stream'
    const visibility = options.visibility ?? 'private'
    const metadata = encodeMetadata({
      sha256: file.sha256,
      visibility,
      createdAt,
      ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
      ...(options.metadata ? { user: options.metadata } : {}),
    })
    await this.#retry(() =>
      blob.uploadFile(file.path, {
        blobHTTPHeaders: {
          blobContentType: contentType,
          ...(options.contentDisposition
            ? { blobContentDisposition: options.contentDisposition }
            : {}),
        },
        metadata,
        blockSize: this.#options.blockSize ?? 8 * 1024 * 1024,
        concurrency: this.#options.concurrency ?? 4,
        ...(options.signal ? { abortSignal: options.signal } : {}),
      }),
    )
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

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    try {
      const res = await this.#retry(() => blob.download())
      const body = res.readableStreamBody
      if (!body) throw new NotFoundError('file')
      return Readable.toWeb(Readable.from(body)) as ReadableStream<Uint8Array>
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError('file', { cause: error })
      throw error
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.stat(key)) !== undefined
  }

  async stat(key: string): Promise<StoredFile | undefined> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    try {
      const props = await this.#retry(() => blob.getProperties())
      return this.#toStored(key, {
        size: props.contentLength,
        contentType: props.contentType,
        metadata: props.metadata,
        lastModified: props.lastModified,
      })
    } catch (error) {
      if (isNotFound(error)) return undefined
      throw error
    }
  }

  #toStored(
    key: string,
    p: {
      size?: number | undefined
      contentType?: string | undefined
      metadata?: Record<string, string> | undefined
      lastModified?: Date | undefined
    },
  ): StoredFile {
    const meta = decodeMetadata(p.metadata ?? {})
    return {
      disk: this.name,
      key,
      size: p.size ?? 0,
      contentType: p.contentType ?? 'application/octet-stream',
      sha256: meta.sha256 ?? '',
      visibility: meta.visibility ?? 'private',
      createdAt: meta.createdAt ?? (p.lastModified ?? this.#now()).toISOString(),
      ...(meta.originalName === undefined ? {} : { originalName: meta.originalName }),
    }
  }

  async delete(key: string): Promise<void> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    try {
      await this.#retry(() => blob.deleteIfExists({ deleteSnapshots: 'include' }))
    } catch (error) {
      if (!isNotFound(error)) throw error
    }
  }

  async list(
    prefix: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<FileListPage> {
    assertSafePrefix(prefix)
    const limit = Math.min(Math.max(Math.floor(options.limit ?? 100), 1), 5000)
    const page = await this.#retry(async () => {
      const iterator = this.#container
        .listBlobsFlat({ prefix: `${this.#root}${prefix}`, includeMetadata: true })
        .byPage({
          maxPageSize: limit,
          ...(options.cursor ? { continuationToken: options.cursor } : {}),
        })
      const next = await iterator.next()
      return next.done ? undefined : next.value
    })
    const items = (page?.segment.blobItems ?? []).map((b) =>
      this.#toStored(b.name.slice(this.#root.length), {
        size: b.properties.contentLength,
        contentType: b.properties.contentType,
        metadata: b.metadata,
        lastModified: b.properties.lastModified,
      }),
    )
    return {
      items,
      ...(page?.continuationToken ? { nextCursor: page.continuationToken } : {}),
    }
  }

  async url(key: string): Promise<string> {
    const stat = await this.stat(key)
    if (!stat) throw new NotFoundError('file')
    if (stat.visibility !== 'public')
      throw new Error(`"${key}" has no public URL on disk "${this.name}"`)
    const fullKey = `${this.#root}${key}`
    return this.#options.publicUrl
      ? publicObjectUrl(this.#options.publicUrl, fullKey)
      : this.#container.getBlockBlobClient(fullKey).url
  }

  async temporaryUrl(key: string, options: FilesTemporaryUrlOptions = {}): Promise<string> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    const expiresIn = clampExpiry(options.expiresInSeconds, this.#options.maxExpirySeconds ?? 3600)
    return this.#sign(blob, BlobSASPermissions.parse('r'), expiresIn, {
      ...(options.contentDisposition ? { contentDisposition: options.contentDisposition } : {}),
      ...(options.contentType ? { contentType: options.contentType } : {}),
    })
  }

  async presignUpload(key: string, options: PresignUploadOptions): Promise<DirectUploadTarget> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    if (!Number.isSafeInteger(options.contentLength) || options.contentLength < 0)
      throw new RangeError('contentLength must be a whole number of bytes')
    const expiresIn = clampExpiry(options.expiresInSeconds, this.#options.maxExpirySeconds ?? 3600)
    // Create only: the URL cannot read, list, delete, or overwrite a blob that already exists
    // (so not the verified file either). Azure SAS cannot pin the size or type, so the confirm
    // step verifies both and deletes mismatches.
    const url = await this.#sign(blob, BlobSASPermissions.parse('c'), expiresIn, {})
    const metadata = encodeMetadata({
      visibility: options.visibility ?? 'private',
      createdAt: this.#now().toISOString(),
      ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
    })
    const headers: Record<string, string> = {
      'x-ms-blob-type': 'BlockBlob',
      'content-type': options.contentType,
      'x-ms-blob-content-type': options.contentType,
    }
    for (const [k, v] of Object.entries(metadata)) headers[`x-ms-meta-${k}`] = v
    return {
      url,
      method: 'PUT',
      headers,
      expiresAt: new Date(this.#now().getTime() + expiresIn * 1000).toISOString(),
    }
  }

  async #sign(
    blob: ReturnType<ContainerClient['getBlockBlobClient']>,
    permissions: BlobSASPermissions,
    expiresIn: number,
    extra: { readonly contentDisposition?: string; readonly contentType?: string },
  ): Promise<string> {
    const now = this.#now().getTime()
    const sas = {
      permissions,
      startsOn: new Date(now - SKEW_MS),
      expiresOn: new Date(now + expiresIn * 1000),
      protocol: this.#options.allowHttp ? SASProtocol.HttpsAndHttp : SASProtocol.Https,
      ...extra,
    }
    if (this.#container.credential instanceof StorageSharedKeyCredential)
      return blob.generateSasUrl(sas)
    return blob.generateUserDelegationSasUrl(sas, await this.#userDelegationKey(now))
  }

  /** A user delegation key valid for 24 hours, refreshed once it has less than 2 hours left. */
  async #userDelegationKey(now: number): Promise<UserDelegationKey> {
    const cached = this.#delegationKey
    if (cached && cached.expires - now > 2 * 3_600_000) return cached.key
    const service = this.#options.serviceClient
    if (!service)
      throw new TypeError(
        `Disk "${this.name}": signed URLs need an account key or a serviceClient for user delegation keys`,
      )
    const expires = now + 24 * 3_600_000
    const key = await this.#retry(() =>
      service.getUserDelegationKey(new Date(now - SKEW_MS), new Date(expires)),
    )
    this.#delegationKey = { key, expires }
    return key
  }

  /** The block id of one part: same length for every part, as Azure requires. */
  #blockId(uploadId: string, partNumber: number): string {
    return Buffer.from(`${uploadId}-${String(partNumber).padStart(6, '0')}`).toString('base64')
  }

  #assertUpload(uploadId: string, partNumber?: number): void {
    if (!UPLOAD_ID.test(uploadId)) throw new RangeError('invalid resumable upload id')
    if (
      partNumber !== undefined &&
      (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > this.maxParts)
    )
      throw new RangeError(`partNumber must be a whole number from 1 to ${this.maxParts}`)
  }

  async createMultipartUpload(key: string, _options: MultipartObjectOptions): Promise<string> {
    this.#key(key)
    // Nothing exists on Azure until the first block arrives: the id only namespaces block ids,
    // so two sessions for the same key can never mix their blocks.
    return randomBytes(12).toString('hex')
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    options: { readonly contentLength: number; readonly expiresInSeconds?: number },
  ): Promise<DirectUploadTarget> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    this.#assertUpload(uploadId, partNumber)
    if (
      !Number.isSafeInteger(options.contentLength) ||
      options.contentLength < 1 ||
      options.contentLength > this.maxPartSize
    )
      throw new RangeError(`contentLength must be 1 to ${this.maxPartSize} bytes`)
    const expiresIn = clampExpiry(options.expiresInSeconds, this.#options.maxExpirySeconds ?? 3600)
    const sas = await this.#sign(blob, BlobSASPermissions.parse('c'), expiresIn, {})
    const blockId = encodeURIComponent(this.#blockId(uploadId, partNumber))
    return {
      url: `${sas}&comp=block&blockid=${blockId}`,
      method: 'PUT',
      // Not signed (a SAS can't pin it); completeMultipartUpload's caller checks every size.
      headers: { 'content-length': String(options.contentLength) },
      expiresAt: new Date(this.#now().getTime() + expiresIn * 1000).toISOString(),
    }
  }

  async listUploadedParts(key: string, uploadId: string): Promise<readonly UploadedPart[]> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    this.#assertUpload(uploadId)
    let blocks: readonly { readonly name: string; readonly size: number }[]
    try {
      const list = await this.#retry(() => blob.getBlockList('uncommitted'))
      blocks = list.uncommittedBlocks ?? []
    } catch (error) {
      if (isNotFound(error)) return [] // no block has arrived yet
      throw error
    }
    const parts: UploadedPart[] = []
    for (const block of blocks) {
      const decoded = Buffer.from(block.name, 'base64').toString('utf8')
      const match = /^([0-9a-f]{24})-([0-9]{6})$/.exec(decoded)
      if (!match || match[1] !== uploadId) continue // another session's (or a foreign) block
      parts.push({ partNumber: Number(match[2]), size: block.size, etag: block.name })
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber)
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: readonly UploadedPart[],
    options: MultipartObjectOptions,
  ): Promise<void> {
    const blob = this.#container.getBlockBlobClient(this.#key(key))
    this.#assertUpload(uploadId)
    if (parts.length === 0) throw new RangeError('completeMultipartUpload needs at least one part')
    const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
    await this.#retry(() =>
      blob.commitBlockList(
        ordered.map((p) => this.#blockId(uploadId, p.partNumber)),
        {
          blobHTTPHeaders: { blobContentType: options.contentType },
          metadata: encodeMetadata({
            visibility: options.visibility ?? 'private',
            createdAt: this.#now().toISOString(),
            ...(options.originalName === undefined ? {} : { originalName: options.originalName }),
          }),
        },
      ),
    )
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    // Azure has no call that deletes uncommitted blocks; it discards them after 7 days, and a
    // blob is never created from them unless the server commits the list. Nothing to do.
    this.#assertUpload(uploadId)
  }
}
