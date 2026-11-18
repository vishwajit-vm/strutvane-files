/**
 * The file manager: one object that runs the whole upload lifecycle on top of any disks and any
 * record store (RFC-0002 §2–4).
 *
 * - {@link FileManager.store}: spool → inspect (type, size, image decode + strip) → dedupe →
 *   scan → quota → intent row → bytes → `pending`.
 * - {@link FileManager.commit} / {@link FileManager.replace} / {@link FileManager.detach}: attach
 *   files to a record inside the caller's transaction; detaching the last reference marks the
 *   file `deleted` (reference counting).
 * - {@link FileManager.createDirectUpload} / {@link FileManager.confirmDirectUpload}:
 *   presigned direct-to-cloud uploads with a server-side confirm step.
 * - {@link FileManager.open} / {@link FileManager.temporaryUrl}: tenant-checked downloads.
 * - {@link FileManager.cleanup}: the orphan job (expired uploads, never-committed files, purges).
 *
 * Every failure path leaves no half-saved state: bytes are deleted, quota is released, temp
 * files are removed, and anything a crash interrupts is found and finished by `cleanup`.
 *
 * @module
 */
import type {
  DomainEvent,
  FileBody,
  FileVisibility,
  Logger,
  StorageDisk,
} from '@strutvane/framework/contracts'
import { type Clock, NotFoundError, systemClock, uuidv7, ValidationError } from '@strutvane/framework/core'
import {
  type DirectUploadTarget,
  type FilesTemporaryUrlOptions,
  isPresigning,
  putSpooled,
} from './disk.ts'
import {
  FileInfectedError,
  fileIssue,
  ScanUnavailableError,
  UploadIncompleteError,
} from './errors.ts'
import type { ImageProcessor } from './image-processor.ts'
import { type InspectedUpload, inspectUpload } from './inspect.ts'
import { assertSafeSegment, contentDisposition, generateFileKey, sanitizeFileName } from './keys.ts'
import { ACTIVE_CONTENT } from './mime.ts'
import type { QuotaGuard } from './quota.ts'
import type { FileRecord, FileRecordStore, FileStatus } from './records.ts'
import { ensureResolved, type FileRules, type ResolvedRules } from './rules.ts'
import {
  type ScanFailurePolicy,
  type ScanVerdict,
  scanWithPolicy,
  type VirusScanner,
} from './scan.ts'
import { formatSize } from './size.ts'
import { type SpooledFile, SpoolLimitError, spool } from './spool.ts'
import { checkSize, checkType } from './validate.ts'

/** Domain event types emitted by the manager. */
export type FileEventType =
  | 'files.stored'
  | 'files.committed'
  | 'files.infected'
  | 'files.deleted'
  | 'files.purged'

/** Payload of every file event. No file contents, no client file names (they may hold PII). */
export interface FileEventPayload {
  readonly fileId: string
  readonly disk: string
  readonly key: string
  readonly size: number
  readonly contentType: string
  /** Only for `files.infected`. */
  readonly signature?: string
}

/** A file domain event. */
export type FileEvent = DomainEvent<FileEventType, FileEventPayload>

/** Options for {@link createFileManager}. */
export interface FileManagerOptions {
  /** Disks by name. */
  readonly disks: Readonly<Record<string, StorageDisk>>
  /** Disk used when a call names none. */
  readonly defaultDisk: string
  readonly store: FileRecordStore
  readonly quota?: QuotaGuard
  readonly scanner?: VirusScanner
  /** What to do when the scanner is down. Default `fail-closed`. */
  readonly scanPolicy?: ScanFailurePolicy
  /**
   * Image processor for decoding and stripping raster images. `'auto'` (default) loads the
   * `sharp` processor on first use if `sharp` is installed; without it, raster uploads fail
   * closed with a clear developer error. `false` disables image processing (raster images are
   * then refused unless a rule sets `image.stripMetadata: false`).
   */
  readonly imageProcessor?: ImageProcessor | 'auto' | false
  /** Parent directory for temp files. Default: the OS temp directory. */
  readonly tempDir?: string
  /** Reuse an identical live file of the same tenant instead of storing a copy. Default false. */
  readonly dedupe?: boolean
  readonly clock?: Clock
  /** Id generator. Default UUIDv7. */
  readonly id?: () => string
  readonly logger?: Logger
  /** Receives domain events (wire it to the core event bus). Errors are logged, never thrown. */
  readonly onEvent?: (event: FileEvent) => void | Promise<void>
}

type Path = readonly (string | number)[]

/** Input for {@link FileManager.store}. */
export interface StoreInput {
  /** The bytes, or an already spooled file (the framework's `UploadedFile` temp file). */
  readonly body: FileBody | SpooledFile
  readonly tenantId: string | null
  /** Logical group for the key, e.g. `"invoices"`. */
  readonly resource: string
  readonly rules?: FileRules | ResolvedRules
  /** The client's file name: sanitised and kept for display only. */
  readonly clientName?: string
  readonly disk?: string
  /** Default `private`. */
  readonly visibility?: FileVisibility
  /** Where the file sits in the input, for validation issues. Default `[]`. */
  readonly path?: Path
  readonly signal?: AbortSignal
}

/** Input for {@link FileManager.commit} and {@link FileManager.replace}. */
export interface AttachInput {
  readonly tenantId: string | null
  readonly resource: string
  readonly recordId: string
  readonly field: string
  /** Files in display order. */
  readonly fileIds: readonly string[]
  /** A store bound to the caller's transaction, so files commit with the record. */
  readonly store?: FileRecordStore
}

/** Input for {@link FileManager.createDirectUpload}. */
export interface DirectUploadInput {
  readonly tenantId: string | null
  readonly resource: string
  /** The type the client says it will upload. Verified against the bytes on confirm. */
  readonly contentType: string
  /** The exact size the client will upload. Signed (S3) and verified on confirm. */
  readonly size: number
  readonly rules?: FileRules | ResolvedRules
  readonly clientName?: string
  readonly disk?: string
  readonly visibility?: FileVisibility
  /** Upload URL lifetime. Default 300 seconds. */
  readonly expiresInSeconds?: number
  readonly path?: Path
}

/** What the client needs to upload directly. */
export interface DirectUpload {
  readonly fileId: string
  readonly upload: DirectUploadTarget
}

/** Input for {@link FileManager.confirmDirectUpload}. */
export interface ConfirmInput {
  readonly tenantId: string | null
  readonly fileId: string
  /** Must be the same rules used to create the upload. */
  readonly rules?: FileRules | ResolvedRules
  readonly path?: Path
  readonly signal?: AbortSignal
}

/** Options for {@link FileManager.cleanup}. */
export interface CleanupOptions {
  /** Only this tenant; `undefined` = every tenant the store can see. */
  readonly tenantId?: string | null
  /** Unfinished uploads older than this are removed. Default 1 hour. */
  readonly uploadingTtlMs?: number
  /** Never-committed files older than this are removed. Default 24 hours. */
  readonly pendingTtlMs?: number
  /** Deleted and quarantined files are purged after this. Default 30 days. */
  readonly retentionMs?: number
  /** Rows per status per run. Default 100. */
  readonly limit?: number
}

/** What a cleanup run did. */
export interface CleanupReport {
  readonly removed: number
  /** Rows whose bytes could not be deleted; they are retried on the next run. */
  readonly failed: number
}

/** The file manager. See the module docs. */
export interface FileManager {
  store(input: StoreInput): Promise<FileRecord>
  commit(input: AttachInput): Promise<readonly FileRecord[]>
  replace(input: AttachInput): Promise<readonly FileRecord[]>
  detach(input: {
    readonly tenantId: string | null
    readonly resource: string
    readonly recordId: string
    readonly field?: string
    readonly store?: FileRecordStore
  }): Promise<readonly string[]>
  get(tenantId: string | null, fileId: string): Promise<FileRecord>
  open(
    tenantId: string | null,
    fileId: string,
  ): Promise<{
    readonly record: FileRecord
    readonly stream: ReadableStream<Uint8Array>
  }>
  temporaryUrl(
    tenantId: string | null,
    fileId: string,
    options?: { readonly expiresInSeconds?: number; readonly download?: boolean },
  ): Promise<string>
  createDirectUpload(input: DirectUploadInput): Promise<DirectUpload>
  confirmDirectUpload(input: ConfirmInput): Promise<FileRecord>
  scanStored(tenantId: string | null, fileId: string): Promise<FileRecord>
  markScanned(tenantId: string | null, fileId: string, verdict: ScanVerdict): Promise<FileRecord>
  cleanup(options?: CleanupOptions): Promise<CleanupReport>
}

const SILENT: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => SILENT,
  isLevelEnabled: () => false,
  flush: async () => {},
}

const HOUR = 3_600_000
/** An `updatedAt` that is older than any retention period. */
const EXPIRED = new Date(0).toISOString()
const SERVABLE_STATUS: ReadonlySet<FileStatus> = new Set(['pending', 'committed'])

function isSpooled(body: FileBody | SpooledFile): body is SpooledFile {
  return typeof body === 'object' && body !== null && 'sha256' in body && 'path' in body
}

function errorFields(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error ? { err: { name: error.name, message: error.message } } : {}
}

/** Create a {@link FileManager}. */
export function createFileManager(options: FileManagerOptions): FileManager {
  const clock = options.clock ?? systemClock
  const newId = options.id ?? uuidv7
  const log = (options.logger ?? SILENT).child({ module: 'files' })
  const scanPolicy = options.scanPolicy ?? 'fail-closed'
  const baseStore = options.store
  const nowIso = (): string => new Date(clock.now()).toISOString()
  if (!options.disks[options.defaultDisk])
    throw new RangeError(`defaultDisk "${options.defaultDisk}" is not among the configured disks`)

  let processor: Promise<ImageProcessor | undefined> | undefined
  const imageProcessor = (): Promise<ImageProcessor | undefined> => {
    const configured = options.imageProcessor ?? 'auto'
    if (configured === false) return Promise.resolve(undefined)
    if (configured !== 'auto') return Promise.resolve(configured)
    processor ??= import('./images/sharp-processor.ts').then(
      (m) => m.createSharpImageProcessor(),
      () => undefined, // sharp not installed: inspection fails closed for raster images
    )
    return processor
  }

  const diskFor = (name: string | undefined): StorageDisk => {
    const disk = options.disks[name ?? options.defaultDisk]
    if (!disk) throw new RangeError(`Unknown disk "${name}"`)
    return disk
  }

  const emit = async (
    type: FileEventType,
    record: FileRecord,
    extra: { signature?: string } = {},
  ) => {
    if (!options.onEvent) return
    const event: FileEvent = {
      id: newId(),
      type,
      version: 1,
      occurredAt: nowIso(),
      idempotencyKey: `${type}:${record.id}`,
      ...(record.tenantId === null ? {} : { tenantId: record.tenantId }),
      payload: {
        fileId: record.id,
        disk: record.disk,
        key: record.key,
        size: record.size,
        contentType: record.contentType,
        ...(extra.signature === undefined ? {} : { signature: extra.signature }),
      },
    }
    try {
      await options.onEvent(event)
    } catch (error) {
      log.error('file event handler failed', { type, fileId: record.id, ...errorFields(error) })
    }
  }

  /** Best-effort removal of bytes + row + quota after a failed upload. */
  const rollback = async (record: FileRecord, releaseQuota: () => Promise<void>): Promise<void> => {
    const disk = options.disks[record.disk]
    try {
      await disk?.delete(record.key)
      await baseStore.remove(record.tenantId, record.id)
      await releaseQuota()
    } catch (error) {
      // The row stays `uploading`; the cleanup job finishes the job (and releases the quota).
      log.warn('rollback after failed upload incomplete; cleanup will retry', {
        fileId: record.id,
        ...errorFields(error),
      })
    }
  }

  const servable = async (tenantId: string | null, fileId: string): Promise<FileRecord> => {
    const record = await baseStore.get(tenantId, fileId)
    if (
      !record ||
      !SERVABLE_STATUS.has(record.status) ||
      (record.scanStatus !== 'clean' && record.scanStatus !== 'not-scanned')
    )
      throw new NotFoundError('file')
    return record
  }

  const inspect = async (
    file: SpooledFile,
    rules: ResolvedRules,
    path: Path,
  ): Promise<InspectedUpload> =>
    inspectUpload(file, rules, {
      path,
      imageProcessor: await imageProcessor(),
      ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
    })

  const scan = (file: SpooledFile, signal: AbortSignal | undefined) =>
    scanWithPolicy(options.scanner, () => file.stream(), scanPolicy, signal ? { signal } : {})

  const putOptions = (record: Pick<FileRecord, 'contentType' | 'visibility' | 'originalName'>) => ({
    contentType: record.contentType,
    visibility: record.visibility,
    originalName: record.originalName,
    ...(ACTIVE_CONTENT.has(record.contentType)
      ? { contentDisposition: contentDisposition('attachment', record.originalName) }
      : {}),
  })

  const reserve = async (tenantId: string | null, bytes: number): Promise<() => Promise<void>> =>
    options.quota ? options.quota.reserve(tenantId, bytes) : async () => {}

  const releaseBytes = async (tenantId: string | null, bytes: number): Promise<void> => {
    if (options.quota && bytes > 0) await options.quota.release(tenantId, bytes)
  }

  const commitInto = async (store: FileRecordStore, input: AttachInput): Promise<FileRecord[]> => {
    const committed: FileRecord[] = []
    const now = nowIso()
    for (const fileId of input.fileIds) {
      const updated = await store.update(input.tenantId, fileId, ['pending', 'committed'], {
        status: 'committed',
        updatedAt: now,
      })
      if (!updated) {
        const existing = await store.get(input.tenantId, fileId)
        if (existing?.status === 'uploading') throw new UploadIncompleteError()
        throw new NotFoundError('file')
      }
      committed.push(updated)
    }
    await store.attach(
      committed.map((file, position) => ({
        fileId: file.id,
        tenantId: input.tenantId,
        resource: input.resource,
        recordId: input.recordId,
        field: input.field,
        position,
        createdAt: now,
      })),
    )
    for (const file of committed) await emit('files.committed', file)
    return committed
  }

  const markDeletedIfOrphan = async (
    store: FileRecordStore,
    tenantId: string | null,
    fileIds: readonly string[],
  ): Promise<string[]> => {
    const deleted: string[] = []
    const now = nowIso()
    for (const id of fileIds) {
      if ((await store.attachmentCount(tenantId, id)) > 0) continue // still shared
      const row = await store.update(tenantId, id, ['committed'], {
        status: 'deleted',
        deletedAt: now,
        updatedAt: now,
      })
      if (row) {
        deleted.push(id)
        await emit('files.deleted', row)
      }
    }
    return deleted
  }

  const manager: FileManager = {
    async store(input) {
      const rules = ensureResolved(input.rules)
      const path = input.path ?? []
      assertSafeSegment(input.resource, 'resource')
      const disk = diskFor(input.disk)
      let spooled: SpooledFile
      let ownSpool = false
      if (isSpooled(input.body)) spooled = input.body
      else {
        try {
          spooled = await spool(input.body, {
            maxBytes: rules.maxSize,
            ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
            ...(input.signal ? { signal: input.signal } : {}),
          })
        } catch (error) {
          if (error instanceof SpoolLimitError)
            throw new ValidationError([
              fileIssue('file_too_large', path, {
                max: formatSize(rules.maxSize),
                maxBytes: rules.maxSize,
              }),
            ])
          throw error
        }
        ownSpool = true
      }
      try {
        await using inspected = await inspect(spooled, rules, path)
        const file = inspected.file
        if (options.dedupe) {
          const duplicate = await baseStore.findDuplicate(input.tenantId, file.sha256, file.size)
          if (duplicate) return duplicate
        }
        const scanStatus = await scan(file, input.signal).catch((error: unknown) => {
          if (error instanceof FileInfectedError)
            log.warn('upload rejected: malware detected', {
              tenantId: input.tenantId,
              resource: input.resource,
              signature: error.signature,
            })
          throw error
        })
        const release = await reserve(input.tenantId, file.size)
        const now = nowIso()
        const record: FileRecord = {
          id: newId(),
          tenantId: input.tenantId,
          disk: disk.name,
          key: generateFileKey({
            tenantId: input.tenantId,
            resource: input.resource,
            contentType: inspected.detectedMime,
            id: newId,
          }),
          size: file.size,
          contentType: inspected.detectedMime,
          sha256: file.sha256,
          originalName: sanitizeFileName(input.clientName),
          visibility: input.visibility ?? 'private',
          status: 'uploading',
          scanStatus,
          ...(inspected.width === undefined ? {} : { width: inspected.width }),
          ...(inspected.height === undefined ? {} : { height: inspected.height }),
          createdAt: now,
          updatedAt: now,
        }
        try {
          await baseStore.insert(record)
        } catch (error) {
          await release()
          throw error
        }
        try {
          input.signal?.throwIfAborted()
          await putSpooled(disk, record.key, file, {
            ...putOptions(record),
            ...(input.signal ? { signal: input.signal } : {}),
          })
          const stored = await baseStore.update(record.tenantId, record.id, ['uploading'], {
            status: 'pending',
            updatedAt: nowIso(),
          })
          if (!stored) throw new Error(`file ${record.id} changed state during upload`)
          await emit('files.stored', stored)
          return stored
        } catch (error) {
          await rollback(record, release)
          throw error
        }
      } finally {
        if (ownSpool) await spooled.dispose()
      }
    },

    commit(input) {
      return commitInto(input.store ?? baseStore, input)
    },

    async replace(input) {
      const store = input.store ?? baseStore
      const current = await store.listAttachments(input.tenantId, {
        resource: input.resource,
        recordId: input.recordId,
        field: input.field,
      })
      const keep = new Set(input.fileIds)
      const dropped = current.filter((a) => !keep.has(a.fileId)).map((a) => a.fileId)
      const committed = await commitInto(store, input)
      if (dropped.length > 0) {
        await store.detach(input.tenantId, {
          resource: input.resource,
          recordId: input.recordId,
          field: input.field,
          fileIds: dropped,
        })
        await markDeletedIfOrphan(store, input.tenantId, dropped)
      }
      return committed
    },

    async detach(input) {
      const store = input.store ?? baseStore
      const ids = await store.detach(input.tenantId, {
        resource: input.resource,
        recordId: input.recordId,
        ...(input.field === undefined ? {} : { field: input.field }),
      })
      return markDeletedIfOrphan(store, input.tenantId, ids)
    },

    async get(tenantId, fileId) {
      const record = await baseStore.get(tenantId, fileId)
      if (!record) throw new NotFoundError('file')
      return record
    },

    async open(tenantId, fileId) {
      const record = await servable(tenantId, fileId)
      return { record, stream: await diskFor(record.disk).get(record.key) }
    },

    async temporaryUrl(tenantId, fileId, opts = {}) {
      const record = await servable(tenantId, fileId)
      const forceDownload = opts.download === true || ACTIVE_CONTENT.has(record.contentType)
      const urlOptions: FilesTemporaryUrlOptions = {
        ...(opts.expiresInSeconds === undefined ? {} : { expiresInSeconds: opts.expiresInSeconds }),
        contentType: record.contentType,
        contentDisposition: contentDisposition(
          forceDownload ? 'attachment' : 'inline',
          record.originalName,
        ),
      }
      return diskFor(record.disk).temporaryUrl(record.key, urlOptions)
    },

    async createDirectUpload(input) {
      const rules = ensureResolved(input.rules)
      const path = input.path ?? []
      assertSafeSegment(input.resource, 'resource')
      if (!Number.isSafeInteger(input.size) || input.size < 0)
        throw new RangeError('size must be a whole number of bytes')
      const issues = [...checkSize(input.size, rules, path)]
      if (issues.length === 0) issues.push(...checkType(input.contentType, rules, path))
      if (issues.length > 0) throw new ValidationError(issues)
      const disk = diskFor(input.disk)
      if (!isPresigning(disk))
        throw new TypeError(`Disk "${disk.name}" does not support direct uploads`)
      const release = await reserve(input.tenantId, input.size)
      const now = nowIso()
      const record: FileRecord = {
        id: newId(),
        tenantId: input.tenantId,
        disk: disk.name,
        key: generateFileKey({
          tenantId: input.tenantId,
          resource: input.resource,
          contentType: input.contentType,
          id: newId,
        }),
        size: input.size,
        contentType: input.contentType.toLowerCase(),
        sha256: '',
        originalName: sanitizeFileName(input.clientName),
        visibility: input.visibility ?? 'private',
        status: 'uploading',
        scanStatus: 'not-scanned',
        createdAt: now,
        updatedAt: now,
      }
      try {
        await baseStore.insert(record)
      } catch (error) {
        await release()
        throw error
      }
      try {
        const upload = await disk.presignUpload(record.key, {
          contentType: record.contentType,
          contentLength: record.size,
          visibility: record.visibility,
          originalName: record.originalName,
          ...(input.expiresInSeconds === undefined
            ? {}
            : { expiresInSeconds: input.expiresInSeconds }),
        })
        return { fileId: record.id, upload }
      } catch (error) {
        await rollback(record, release)
        throw error
      }
    },

    async confirmDirectUpload(input) {
      const rules = ensureResolved(input.rules)
      const path = input.path ?? []
      const record = await baseStore.get(input.tenantId, input.fileId)
      if (!record) throw new NotFoundError('file')
      if (record.status === 'pending' || record.status === 'committed') return record // idempotent
      if (record.status !== 'uploading') throw new NotFoundError('file')
      const disk = diskFor(record.disk)
      const reject = async (error: unknown): Promise<never> => {
        await rollback(record, () => releaseBytes(record.tenantId, record.size))
        throw error
      }
      const stat = await disk.stat(record.key)
      if (!stat) throw new UploadIncompleteError() // the client may still retry the PUT
      if (stat.size !== record.size) {
        if (stat.size > rules.maxSize)
          return reject(new ValidationError(checkSize(stat.size, rules, path)))
        return reject(new UploadIncompleteError())
      }
      let spooled: SpooledFile
      try {
        spooled = await spool(await disk.get(record.key), {
          maxBytes: rules.maxSize,
          ...(options.tempDir === undefined ? {} : { tempDir: options.tempDir }),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      } catch (error) {
        if (error instanceof SpoolLimitError)
          return reject(new ValidationError(checkSize(rules.maxSize + 1, rules, path)))
        throw error
      }
      try {
        let inspected: InspectedUpload
        try {
          inspected = await inspect(spooled, rules, path)
        } catch (error) {
          if (error instanceof ValidationError) return await reject(error)
          throw error
        }
        await using _inspected = inspected
        if (inspected.detectedMime !== record.contentType)
          // The bytes are not what the client declared (and what the URL was signed for).
          return await reject(
            new ValidationError([
              fileIssue('file_type_not_allowed', path, {
                accept: rules.accept.join(', '),
                detected: inspected.detectedMime,
              }),
            ]),
          )
        let scanStatus: Awaited<ReturnType<typeof scan>>
        try {
          scanStatus = await scan(inspected.file, input.signal)
        } catch (error) {
          if (error instanceof ScanUnavailableError) throw error // retryable: keep the upload
          return await reject(error)
        }
        const file = inspected.file
        // Quota was reserved for the declared size; re-encoding may change it slightly.
        const delta = file.size - record.size
        if (delta > 0) {
          try {
            await reserve(record.tenantId, delta)
          } catch (error) {
            return await reject(error)
          }
        }
        let updated: FileRecord | undefined
        try {
          if (inspected.sanitized) await putSpooled(disk, record.key, file, putOptions(record))
          updated = await baseStore.update(record.tenantId, record.id, ['uploading'], {
            status: 'pending',
            size: file.size,
            sha256: file.sha256,
            scanStatus,
            ...(inspected.width === undefined ? {} : { width: inspected.width }),
            ...(inspected.height === undefined ? {} : { height: inspected.height }),
            updatedAt: nowIso(),
          })
        } catch (error) {
          // Storage down: the upload stays `uploading`, so the client can confirm again.
          if (delta > 0) await releaseBytes(record.tenantId, delta)
          throw error
        }
        if (!updated) {
          if (delta > 0) await releaseBytes(record.tenantId, delta)
          throw new NotFoundError('file') // cleaned up while we were confirming
        }
        if (delta < 0) await releaseBytes(record.tenantId, -delta)
        await emit('files.stored', updated)
        return updated
      } finally {
        await spooled.dispose()
      }
    },

    async scanStored(tenantId, fileId) {
      const record = await baseStore.get(tenantId, fileId)
      if (!record || !SERVABLE_STATUS.has(record.status)) throw new NotFoundError('file')
      if (!options.scanner) throw new ScanUnavailableError()
      let verdict: ScanVerdict
      try {
        verdict = await options.scanner.scan(await diskFor(record.disk).get(record.key))
      } catch (error) {
        throw error instanceof ScanUnavailableError
          ? error
          : new ScanUnavailableError({ cause: error })
      }
      return manager.markScanned(tenantId, fileId, verdict)
    },

    async markScanned(tenantId, fileId, verdict) {
      const now = nowIso()
      const updated =
        verdict.status === 'clean'
          ? await baseStore.update(tenantId, fileId, ['pending', 'committed'], {
              scanStatus: 'clean',
              updatedAt: now,
            })
          : await baseStore.update(tenantId, fileId, ['pending', 'committed', 'deleted'], {
              status: 'quarantined',
              scanStatus: 'infected',
              updatedAt: now,
            })
      if (!updated) throw new NotFoundError('file')
      if (verdict.status === 'infected') {
        log.warn('stored file quarantined: malware detected', { fileId, tenantId })
        await emit('files.infected', updated, { signature: verdict.signature })
      }
      return updated
    },

    async cleanup(opts = {}) {
      const now = clock.now()
      const limit = opts.limit ?? 100
      const plan: readonly [FileStatus, number][] = [
        ['uploading', opts.uploadingTtlMs ?? HOUR],
        ['pending', opts.pendingTtlMs ?? 24 * HOUR],
        ['deleted', opts.retentionMs ?? 30 * 24 * HOUR],
        ['quarantined', opts.retentionMs ?? 30 * 24 * HOUR],
      ]
      let removed = 0
      let failed = 0
      for (const [status, ttl] of plan) {
        const before = new Date(now - ttl).toISOString()
        const rows = await baseStore.findStale(opts.tenantId, { status, before, limit })
        for (const row of rows) {
          // Claim live rows first, so a confirm or commit racing with us wins or loses cleanly.
          if (status === 'uploading' || status === 'pending') {
            const claimed = await baseStore.update(row.tenantId, row.id, [status], {
              status: 'deleted',
              deletedAt: new Date(now).toISOString(),
              // Already past retention: if deleting the bytes fails below, the next run's
              // `deleted` pass retries at once instead of waiting 30 days.
              updatedAt: EXPIRED,
            })
            if (!claimed) continue
          } else if ((await baseStore.attachmentCount(row.tenantId, row.id)) > 0) continue
          try {
            await diskFor(row.disk).delete(row.key)
          } catch (error) {
            failed++
            log.warn('cleanup could not delete file bytes; will retry', {
              fileId: row.id,
              ...errorFields(error),
            })
            continue
          }
          if (await baseStore.remove(row.tenantId, row.id)) {
            removed++
            await releaseBytes(row.tenantId, row.size)
            await emit('files.purged', row)
          }
        }
      }
      return { removed, failed }
    },
  }
  return manager
}
