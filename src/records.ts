/**
 * File records and attachments: the rows behind the `files` and `file_attachments` tables.
 *
 * **Lifecycle** (RFC-0002 §4):
 *
 * ```
 *  uploading ──(bytes stored + checks passed)──► pending ──(record saved, same tx)──► committed
 *      │                                            │                                    │
 *      └── expired (client never finished) ─┐       └── expired (record never saved) ─┐   │
 *                                           ▼                                         ▼   ▼
 *                                   cleanup deletes bytes + row          deleted (last attachment
 *                                                                        removed) ─► purged after
 *  quarantined: malware found by a later scan; never served.            retention
 * ```
 *
 * The row is written *before* the bytes ("intent first"): if the process dies between the two,
 * the cleanup job still knows the key and removes the object. Bytes without a row would be
 * invisible garbage forever.
 *
 * Every store method is scoped by tenant. A lookup with the wrong tenant behaves exactly like a
 * lookup of a missing id, so callers answer 404 either way.
 *
 * @module
 */
import type { FileVisibility } from '@strutvane/framework/contracts'
import type { ScanStatus } from './scan.ts'

/** Where a file is in its lifecycle. See the module docs. */
export type FileStatus = 'uploading' | 'pending' | 'committed' | 'quarantined' | 'deleted'

/** Every status, in lifecycle order. */
export const FILE_STATUSES: readonly FileStatus[] = [
  'uploading',
  'pending',
  'committed',
  'quarantined',
  'deleted',
]

/** One stored file. */
export interface FileRecord {
  /** UUIDv7. */
  readonly id: string
  /** Owning tenant, or `null` without tenancy. */
  readonly tenantId: string | null
  readonly disk: string
  readonly key: string
  /** Size in bytes (the declared size while a direct upload is `uploading`). */
  readonly size: number
  /** Detected type (the declared type while a direct upload is `uploading`). */
  readonly contentType: string
  /** Lowercase hex SHA-256; `''` until the bytes are known. */
  readonly sha256: string
  /** Sanitised client file name, for display and downloads only. */
  readonly originalName: string
  readonly visibility: FileVisibility
  readonly status: FileStatus
  readonly scanStatus: ScanStatus
  readonly width?: number
  readonly height?: number
  readonly createdAt: string
  readonly updatedAt: string
  /** When the file was marked `deleted` (start of the retention period). */
  readonly deletedAt?: string
}

/** Fields that may change after insert. */
export type FileRecordPatch = Partial<
  Pick<
    FileRecord,
    'status' | 'size' | 'contentType' | 'sha256' | 'scanStatus' | 'width' | 'height' | 'deletedAt'
  >
> & { readonly updatedAt: string }

/** A link from a record's field to a file. Shared files have several (reference counting). */
export interface FileAttachment {
  readonly fileId: string
  readonly tenantId: string | null
  /** Resource name, e.g. `"invoices"`. */
  readonly resource: string
  /** The record's id, as a string. */
  readonly recordId: string
  /** Field name, e.g. `"attachments"`. */
  readonly field: string
  /** Order within a multi-file field. */
  readonly position: number
  readonly createdAt: string
}

/** Which attachments to select. */
export interface AttachmentFilter {
  readonly resource: string
  readonly recordId: string
  readonly field?: string
  /** Only these files. */
  readonly fileIds?: readonly string[]
}

/** Query for the cleanup job. */
export interface StaleQuery {
  readonly status: FileStatus
  /** Rows last updated before this ISO timestamp. */
  readonly before: string
  readonly limit: number
}

/** Persistence for file records. Implementations: {@link MemoryFileStore}, `SqlFileStore`. */
export interface FileRecordStore {
  insert(record: FileRecord): Promise<void>
  get(tenantId: string | null, id: string): Promise<FileRecord | undefined>
  /**
   * Compare-and-set: apply `patch` only if the row exists for this tenant and its status is one
   * of `from`. Returns the updated row, or `undefined` if nothing matched. This is what makes
   * concurrent commits, confirms and cleanups safe without locks.
   */
  update(
    tenantId: string | null,
    id: string,
    from: readonly FileStatus[],
    patch: FileRecordPatch,
  ): Promise<FileRecord | undefined>
  /** A live (pending/committed), clean or unscanned file with the same content, for dedupe. */
  findDuplicate(
    tenantId: string | null,
    sha256: string,
    size: number,
  ): Promise<FileRecord | undefined>
  /** Add attachments. Re-adding an existing (file, resource, record, field) updates its position. */
  attach(attachments: readonly FileAttachment[]): Promise<void>
  /** Remove attachments; returns the ids of the files that were detached. */
  detach(tenantId: string | null, filter: AttachmentFilter): Promise<readonly string[]>
  /** Attachments of one record (optionally one field), ordered by field then position. */
  listAttachments(
    tenantId: string | null,
    filter: AttachmentFilter,
  ): Promise<readonly FileAttachment[]>
  /** How many attachments point at a file. */
  attachmentCount(tenantId: string | null, fileId: string): Promise<number>
  /**
   * Rows in `status` last updated before `before`. `tenantId: undefined` means every tenant the
   * connection can see (under Postgres RLS: still only the current tenant).
   */
  findStale(tenantId: string | null | undefined, query: StaleQuery): Promise<readonly FileRecord[]>
  /**
   * Delete a row (and its attachments). Returns whether this call removed it, so that when two
   * cleanup workers race, exactly one releases the quota. A missing row is not an error.
   */
  remove(tenantId: string | null, id: string): Promise<boolean>
}

const sameTenant = (a: string | null, b: string | null): boolean => a === b

/** An in-memory {@link FileRecordStore} for tests and prototypes. */
export class MemoryFileStore implements FileRecordStore {
  readonly #files = new Map<string, FileRecord>()
  #attachments: FileAttachment[] = []

  async insert(record: FileRecord): Promise<void> {
    if (this.#files.has(record.id)) throw new Error(`duplicate file id ${record.id}`)
    this.#files.set(record.id, Object.freeze({ ...record }))
  }

  // Every method reads and writes synchronously (no `await` in between), which is what makes
  // compare-and-set atomic here, just like a single SQL statement.
  #get(tenantId: string | null, id: string): FileRecord | undefined {
    const row = this.#files.get(id)
    return row && sameTenant(row.tenantId, tenantId) ? row : undefined
  }

  async get(tenantId: string | null, id: string): Promise<FileRecord | undefined> {
    return this.#get(tenantId, id)
  }

  async update(
    tenantId: string | null,
    id: string,
    from: readonly FileStatus[],
    patch: FileRecordPatch,
  ): Promise<FileRecord | undefined> {
    const row = this.#get(tenantId, id)
    if (!row || !from.includes(row.status)) return undefined
    const next: Record<string, unknown> = { ...row, ...patch }
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
    const updated = Object.freeze(next) as unknown as FileRecord
    this.#files.set(id, updated)
    return updated
  }

  async findDuplicate(
    tenantId: string | null,
    sha256: string,
    size: number,
  ): Promise<FileRecord | undefined> {
    for (const row of this.#files.values()) {
      if (
        sameTenant(row.tenantId, tenantId) &&
        row.sha256 === sha256 &&
        row.size === size &&
        (row.status === 'pending' || row.status === 'committed') &&
        (row.scanStatus === 'clean' || row.scanStatus === 'not-scanned')
      )
        return row
    }
    return undefined
  }

  async attach(attachments: readonly FileAttachment[]): Promise<void> {
    for (const a of attachments) {
      const i = this.#attachments.findIndex((b) => sameAttachment(a, b))
      if (i >= 0) this.#attachments[i] = { ...a }
      else this.#attachments.push({ ...a })
    }
  }

  async detach(tenantId: string | null, filter: AttachmentFilter): Promise<readonly string[]> {
    const removed = this.#attachments.filter((a) => matches(a, tenantId, filter))
    this.#attachments = this.#attachments.filter((a) => !matches(a, tenantId, filter))
    return [...new Set(removed.map((a) => a.fileId))]
  }

  async listAttachments(
    tenantId: string | null,
    filter: AttachmentFilter,
  ): Promise<readonly FileAttachment[]> {
    return this.#attachments
      .filter((a) => matches(a, tenantId, filter))
      .sort((a, b) => a.field.localeCompare(b.field) || a.position - b.position)
  }

  async attachmentCount(tenantId: string | null, fileId: string): Promise<number> {
    return this.#attachments.filter((a) => a.fileId === fileId && sameTenant(a.tenantId, tenantId))
      .length
  }

  async findStale(
    tenantId: string | null | undefined,
    query: StaleQuery,
  ): Promise<readonly FileRecord[]> {
    return [...this.#files.values()]
      .filter(
        (r) =>
          (tenantId === undefined || sameTenant(r.tenantId, tenantId)) &&
          r.status === query.status &&
          r.updatedAt < query.before,
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, query.limit)
  }

  async remove(tenantId: string | null, id: string): Promise<boolean> {
    const row = this.#get(tenantId, id)
    if (!row) return false
    this.#files.delete(id)
    this.#attachments = this.#attachments.filter((a) => a.fileId !== id)
    return true
  }
}

function sameAttachment(a: FileAttachment, b: FileAttachment): boolean {
  return (
    a.fileId === b.fileId &&
    a.tenantId === b.tenantId &&
    a.resource === b.resource &&
    a.recordId === b.recordId &&
    a.field === b.field
  )
}

function matches(a: FileAttachment, tenantId: string | null, f: AttachmentFilter): boolean {
  return (
    sameTenant(a.tenantId, tenantId) &&
    a.resource === f.resource &&
    a.recordId === f.recordId &&
    (f.field === undefined || a.field === f.field) &&
    (f.fileIds === undefined || f.fileIds.includes(a.fileId))
  )
}
