/**
 * DDL for the `files`, `file_attachments` and `file_quota_usage` tables.
 *
 * With `tenancy: true` on PostgreSQL, every table gets the row-level security policies required
 * by ADR-0007: a RESTRICTIVE tenant policy (with `ENABLE` + `FORCE`, `USING` + `WITH CHECK`)
 * reading `NULLIF(current_setting('app.tenant_id', true), '')::uuid`, plus a PERMISSIVE access
 * policy (restrictive policies only narrow access, so one permissive policy must exist). Tenant
 * A then cannot read, change or insert tenant B's file rows even with a bug in a query.
 *
 * @module
 */
import { quoteIdent, type StoreDialect } from './client.ts'

/** Table names. */
export interface FilesTables {
  readonly files: string
  readonly attachments: string
  readonly quota: string
}

/** Default table names. */
export const DEFAULT_TABLES: FilesTables = Object.freeze({
  files: 'files',
  attachments: 'file_attachments',
  quota: 'file_quota_usage',
})

/** Options for {@link filesMigration}. */
export interface FilesMigrationOptions {
  readonly dialect: StoreDialect
  /** Tenant-scoped rows (`tenant_id uuid NOT NULL`) and, on PostgreSQL, RLS. Default `false`. */
  readonly tenancy?: boolean
  readonly tables?: Partial<FilesTables>
  /** Limit the permissive RLS policy to this runtime role (recommended). Default: every role. */
  readonly runtimeRole?: string
}

/** Up and down statements, to run in order inside one transaction. */
export interface Migration {
  readonly up: readonly string[]
  readonly down: readonly string[]
}

const TENANT_EXPR = "NULLIF(current_setting('app.tenant_id', true), '')::uuid"

/** Build the migration. */
export function filesMigration(options: FilesMigrationOptions): Migration {
  const t = { ...DEFAULT_TABLES, ...options.tables }
  const files = quoteIdent(t.files)
  const attachments = quoteIdent(t.attachments)
  const quota = quoteIdent(t.quota)
  const pg = options.dialect === 'postgres'
  const tenancy = options.tenancy ?? false
  const uuid = pg ? 'uuid' : 'text'
  const ts = pg ? 'timestamptz' : 'text'
  const big = pg ? 'bigint' : 'integer'
  const tenantCol = `tenant_id ${uuid}${tenancy ? ' NOT NULL' : ' NULL'}`
  const idx = (name: string): string => quoteIdent(`${t.files}_${name}`.slice(0, 63))

  const up = [
    `CREATE TABLE ${files} (
  id ${uuid} PRIMARY KEY,
  ${tenantCol},
  disk varchar(64) NOT NULL,
  key varchar(1024) NOT NULL,
  size ${big} NOT NULL CHECK (size >= 0),
  content_type varchar(255) NOT NULL,
  sha256 varchar(64) NOT NULL DEFAULT '',
  original_name varchar(800) NOT NULL,
  visibility varchar(16) NOT NULL CHECK (visibility IN ('private', 'public')),
  status varchar(16) NOT NULL CHECK (status IN ('uploading', 'pending', 'committed', 'quarantined', 'deleted')),
  scan_status varchar(16) NOT NULL CHECK (scan_status IN ('clean', 'pending-scan', 'infected', 'not-scanned')),
  width integer NULL,
  height integer NULL,
  created_at ${ts} NOT NULL,
  updated_at ${ts} NOT NULL,
  deleted_at ${ts} NULL
)`,
    `CREATE UNIQUE INDEX ${idx('disk_key_uq')} ON ${files} (disk, key)`,
    `CREATE INDEX ${idx('status_updated_idx')} ON ${files} (tenant_id, status, updated_at)`,
    `CREATE INDEX ${idx('sha256_idx')} ON ${files} (tenant_id, sha256, size)`,
    `CREATE TABLE ${attachments} (
  file_id ${uuid} NOT NULL REFERENCES ${files} (id) ON DELETE CASCADE,
  ${tenantCol},
  resource varchar(128) NOT NULL,
  record_id varchar(255) NOT NULL,
  field varchar(128) NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  created_at ${ts} NOT NULL,
  PRIMARY KEY (file_id, resource, record_id, field)
)`,
    `CREATE INDEX ${quoteIdent(`${t.attachments}_record_idx`.slice(0, 63))} ON ${attachments} (tenant_id, resource, record_id, field, position)`,
    `CREATE TABLE ${quota} (
  tenant_key ${tenancy && pg ? 'uuid' : 'varchar(64)'} PRIMARY KEY,
  used_bytes ${big} NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
)`,
  ]
  if (pg && tenancy) {
    const role = options.runtimeRole ? ` TO ${quoteIdent(options.runtimeRole)}` : ''
    for (const [table, column] of [
      [t.files, 'tenant_id'],
      [t.attachments, 'tenant_id'],
      [t.quota, 'tenant_key'],
    ] as const) {
      const q = quoteIdent(table)
      up.push(
        `ALTER TABLE ${q} ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE ${q} FORCE ROW LEVEL SECURITY`,
        `CREATE POLICY ${quoteIdent(`${table}_tenant_isolation`.slice(0, 63))} ON ${q} AS RESTRICTIVE FOR ALL USING (${column} = ${TENANT_EXPR}) WITH CHECK (${column} = ${TENANT_EXPR})`,
        `CREATE POLICY ${quoteIdent(`${table}_access`.slice(0, 63))} ON ${q} AS PERMISSIVE FOR ALL${role} USING (true) WITH CHECK (true)`,
      )
    }
  }
  const down = [
    `DROP TABLE IF EXISTS ${quota}`,
    `DROP TABLE IF EXISTS ${attachments}`,
    `DROP TABLE IF EXISTS ${files}`,
  ]
  return { up, down }
}
