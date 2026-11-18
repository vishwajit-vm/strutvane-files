/**
 * A {@link FileRecordStore} on PostgreSQL or SQLite, plus an atomic SQL quota counter.
 *
 * - Every query is parameterised and tenant-scoped (`tenant_id IS NOT DISTINCT FROM ?`), on
 *   top of RLS when the migration enabled it.
 * - Status changes are compare-and-set (`UPDATE … WHERE status IN (…) RETURNING *`), so
 *   concurrent confirms, commits and cleanups never overwrite each other.
 * - For a commit that must land with the record, bind the store to the transaction's client:
 *   `store.withClient(tx)`.
 *
 * @module
 */
import type { QuotaCounter } from '../quota.ts'
import type {
  AttachmentFilter,
  FileAttachment,
  FileRecord,
  FileRecordPatch,
  FileRecordStore,
  FileStatus,
  StaleQuery,
} from '../records.ts'
import {
  quoteIdent,
  type SqlClient,
  type SqlValue,
  type StoreDialect,
  toDialect,
} from './client.ts'
import { DEFAULT_TABLES, type FilesTables } from './migration.ts'

/** Options for {@link SqlFileStore}. */
export interface SqlFileStoreOptions {
  readonly client: SqlClient
  readonly dialect: StoreDialect
  readonly tables?: Partial<FilesTables>
}

const COLUMNS: Readonly<Record<keyof FileRecordPatch, string>> = {
  status: 'status',
  size: 'size',
  contentType: 'content_type',
  sha256: 'sha256',
  scanStatus: 'scan_status',
  width: 'width',
  height: 'height',
  deletedAt: 'deleted_at',
  updatedAt: 'updated_at',
}

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString()

const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value))

function toRecord(row: Record<string, unknown>): FileRecord {
  return {
    id: String(row['id']),
    tenantId:
      row['tenant_id'] === null || row['tenant_id'] === undefined ? null : String(row['tenant_id']),
    disk: String(row['disk']),
    key: String(row['key']),
    size: num(row['size']),
    contentType: String(row['content_type']),
    sha256: String(row['sha256']),
    originalName: String(row['original_name']),
    visibility: row['visibility'] === 'public' ? 'public' : 'private',
    status: String(row['status']) as FileStatus,
    scanStatus: String(row['scan_status']) as FileRecord['scanStatus'],
    ...(row['width'] === null || row['width'] === undefined ? {} : { width: num(row['width']) }),
    ...(row['height'] === null || row['height'] === undefined
      ? {}
      : { height: num(row['height']) }),
    createdAt: iso(row['created_at']),
    updatedAt: iso(row['updated_at']),
    ...(row['deleted_at'] === null || row['deleted_at'] === undefined
      ? {}
      : { deletedAt: iso(row['deleted_at']) }),
    ...(row['owner_id'] === null || row['owner_id'] === undefined
      ? {}
      : { ownerId: String(row['owner_id']) }),
    ...(row['upload_id'] === null || row['upload_id'] === undefined
      ? {}
      : { upload: { id: String(row['upload_id']), partSize: num(row['upload_part_size']) } }),
  }
}

function toAttachment(row: Record<string, unknown>): FileAttachment {
  return {
    fileId: String(row['file_id']),
    tenantId:
      row['tenant_id'] === null || row['tenant_id'] === undefined ? null : String(row['tenant_id']),
    resource: String(row['resource']),
    recordId: String(row['record_id']),
    field: String(row['field']),
    position: num(row['position']),
    createdAt: iso(row['created_at']),
  }
}

/** A SQL-backed {@link FileRecordStore}. */
export class SqlFileStore implements FileRecordStore {
  readonly #options: SqlFileStoreOptions
  readonly #files: string
  readonly #attachments: string
  /** NULL-safe equality for the tenant column. */
  readonly #tenantEq: string

  constructor(options: SqlFileStoreOptions) {
    if (options.dialect !== 'postgres' && options.dialect !== 'sqlite')
      throw new RangeError(`SqlFileStore: unsupported dialect "${String(options.dialect)}"`)
    const tables = { ...DEFAULT_TABLES, ...options.tables }
    this.#options = options
    this.#files = quoteIdent(tables.files)
    this.#attachments = quoteIdent(tables.attachments)
    this.#tenantEq = options.dialect === 'postgres' ? 'IS NOT DISTINCT FROM' : 'IS'
  }

  /** The same store on another client, e.g. the transaction that saves the record. */
  withClient(client: SqlClient): SqlFileStore {
    return new SqlFileStore({ ...this.#options, client })
  }

  #query(sql: string, params: readonly SqlValue[]) {
    return this.#options.client.query(toDialect(sql, this.#options.dialect), params)
  }

  async insert(r: FileRecord): Promise<void> {
    await this.#query(
      `INSERT INTO ${this.#files} (id, tenant_id, disk, key, size, content_type, sha256, original_name, visibility, status, scan_status, width, height, created_at, updated_at, deleted_at, owner_id, upload_id, upload_part_size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.id,
        r.tenantId,
        r.disk,
        r.key,
        r.size,
        r.contentType,
        r.sha256,
        r.originalName,
        r.visibility,
        r.status,
        r.scanStatus,
        r.width ?? null,
        r.height ?? null,
        r.createdAt,
        r.updatedAt,
        r.deletedAt ?? null,
        r.ownerId ?? null,
        r.upload?.id ?? null,
        r.upload?.partSize ?? null,
      ],
    )
  }

  async get(tenantId: string | null, id: string): Promise<FileRecord | undefined> {
    const { rows } = await this.#query(
      `SELECT * FROM ${this.#files} WHERE id = ? AND tenant_id ${this.#tenantEq} ?`,
      [id, tenantId],
    )
    return rows[0] ? toRecord(rows[0]) : undefined
  }

  async update(
    tenantId: string | null,
    id: string,
    from: readonly FileStatus[],
    patch: FileRecordPatch,
  ): Promise<FileRecord | undefined> {
    if (from.length === 0) return undefined
    const sets: string[] = []
    const params: SqlValue[] = []
    for (const [field, value] of Object.entries(patch) as [keyof FileRecordPatch, unknown][]) {
      if (value === undefined) continue
      sets.push(`${COLUMNS[field]} = ?`)
      params.push(value as SqlValue)
    }
    const { rows } = await this.#query(
      `UPDATE ${this.#files} SET ${sets.join(', ')}
       WHERE id = ? AND tenant_id ${this.#tenantEq} ? AND status IN (${from.map(() => '?').join(', ')})
       RETURNING *`,
      [...params, id, tenantId, ...from],
    )
    return rows[0] ? toRecord(rows[0]) : undefined
  }

  async findDuplicate(
    tenantId: string | null,
    sha256: string,
    size: number,
  ): Promise<FileRecord | undefined> {
    const { rows } = await this.#query(
      `SELECT * FROM ${this.#files}
       WHERE tenant_id ${this.#tenantEq} ? AND sha256 = ? AND size = ?
         AND status IN ('pending', 'committed') AND scan_status IN ('clean', 'not-scanned')
       ORDER BY created_at LIMIT 1`,
      [tenantId, sha256, size],
    )
    return rows[0] ? toRecord(rows[0]) : undefined
  }

  async attach(attachments: readonly FileAttachment[]): Promise<void> {
    for (const a of attachments) {
      await this.#query(
        `INSERT INTO ${this.#attachments} (file_id, tenant_id, resource, record_id, field, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (file_id, resource, record_id, field) DO UPDATE SET position = excluded.position`,
        [a.fileId, a.tenantId, a.resource, a.recordId, a.field, a.position, a.createdAt],
      )
    }
  }

  #filter(tenantId: string | null, f: AttachmentFilter): { where: string; params: SqlValue[] } {
    const parts = [`tenant_id ${this.#tenantEq} ?`, 'resource = ?', 'record_id = ?']
    const params: SqlValue[] = [tenantId, f.resource, f.recordId]
    if (f.field !== undefined) {
      parts.push('field = ?')
      params.push(f.field)
    }
    if (f.fileIds !== undefined) {
      if (f.fileIds.length === 0) parts.push('1 = 0')
      else {
        parts.push(`file_id IN (${f.fileIds.map(() => '?').join(', ')})`)
        params.push(...f.fileIds)
      }
    }
    return { where: parts.join(' AND '), params }
  }

  async detach(tenantId: string | null, filter: AttachmentFilter): Promise<readonly string[]> {
    const { where, params } = this.#filter(tenantId, filter)
    const { rows } = await this.#query(
      `DELETE FROM ${this.#attachments} WHERE ${where} RETURNING file_id`,
      params,
    )
    return [...new Set(rows.map((r) => String(r['file_id'])))]
  }

  async listAttachments(
    tenantId: string | null,
    filter: AttachmentFilter,
  ): Promise<readonly FileAttachment[]> {
    const { where, params } = this.#filter(tenantId, filter)
    const { rows } = await this.#query(
      `SELECT * FROM ${this.#attachments} WHERE ${where} ORDER BY field, position`,
      params,
    )
    return rows.map(toAttachment)
  }

  async attachmentCount(tenantId: string | null, fileId: string): Promise<number> {
    const { rows } = await this.#query(
      `SELECT COUNT(*) AS n FROM ${this.#attachments} WHERE file_id = ? AND tenant_id ${this.#tenantEq} ?`,
      [fileId, tenantId],
    )
    return num(rows[0]?.['n'] ?? 0)
  }

  async findStale(
    tenantId: string | null | undefined,
    query: StaleQuery,
  ): Promise<readonly FileRecord[]> {
    const tenant = tenantId === undefined ? '' : `tenant_id ${this.#tenantEq} ? AND `
    const { rows } = await this.#query(
      `SELECT * FROM ${this.#files} WHERE ${tenant}status = ? AND updated_at < ?
       ORDER BY updated_at LIMIT ?`,
      [...(tenantId === undefined ? [] : [tenantId]), query.status, query.before, query.limit],
    )
    return rows.map(toRecord)
  }

  async remove(tenantId: string | null, id: string): Promise<boolean> {
    // Explicit, because SQLite only cascades with `PRAGMA foreign_keys = ON`.
    await this.#query(
      `DELETE FROM ${this.#attachments} WHERE file_id = ? AND tenant_id ${this.#tenantEq} ?`,
      [id, tenantId],
    )
    const result = await this.#query(
      `DELETE FROM ${this.#files} WHERE id = ? AND tenant_id ${this.#tenantEq} ?`,
      [id, tenantId],
    )
    return (result.rowCount ?? 0) > 0
  }
}

/** Options for {@link SqlQuotaCounter}. */
export interface SqlQuotaCounterOptions {
  readonly client: SqlClient
  readonly dialect: StoreDialect
  readonly table?: string
}

/**
 * A {@link QuotaCounter} on SQL. `reserve` is one conditional `UPDATE … WHERE used + n <= limit`:
 * the row lock makes check-and-increment atomic, so concurrent uploads cannot overshoot.
 */
export class SqlQuotaCounter implements QuotaCounter {
  readonly #options: SqlQuotaCounterOptions
  readonly #table: string

  constructor(options: SqlQuotaCounterOptions) {
    this.#options = options
    this.#table = quoteIdent(options.table ?? DEFAULT_TABLES.quota)
  }

  #query(sql: string, params: readonly SqlValue[]) {
    return this.#options.client.query(toDialect(sql, this.#options.dialect), params)
  }

  async usage(tenantKey: string): Promise<number> {
    const { rows } = await this.#query(
      `SELECT used_bytes FROM ${this.#table} WHERE tenant_key = ?`,
      [tenantKey],
    )
    return num(rows[0]?.['used_bytes'] ?? 0)
  }

  async reserve(
    tenantKey: string,
    bytes: number,
    limit: number,
  ): Promise<{ readonly ok: boolean; readonly used: number }> {
    await this.#query(
      `INSERT INTO ${this.#table} (tenant_key, used_bytes) VALUES (?, 0) ON CONFLICT (tenant_key) DO NOTHING`,
      [tenantKey],
    )
    const { rows } = await this.#query(
      `UPDATE ${this.#table} SET used_bytes = used_bytes + ?
       WHERE tenant_key = ? AND used_bytes + ? <= ? RETURNING used_bytes`,
      [bytes, tenantKey, bytes, limit],
    )
    if (rows[0]) return { ok: true, used: num(rows[0]['used_bytes']) }
    return { ok: false, used: await this.usage(tenantKey) }
  }

  async release(tenantKey: string, bytes: number): Promise<void> {
    await this.#query(
      `UPDATE ${this.#table} SET used_bytes = CASE WHEN used_bytes > ? THEN used_bytes - ? ELSE 0 END
       WHERE tenant_key = ?`,
      [bytes, bytes, tenantKey],
    )
  }
}
