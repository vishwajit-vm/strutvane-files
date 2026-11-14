/**
 * `@strutvane/files/sql`: the `files` / `file_attachments` / `file_quota_usage` tables (with
 * ADR-0007 row-level security on PostgreSQL), a SQL record store and an atomic quota counter.
 *
 * @module
 */
export {
  quoteIdent,
  type SqlClient,
  type SqliteDatabaseLike,
  type SqlValue,
  type StoreDialect,
  sqliteClient,
  toDialect,
} from './client.ts'
export {
  DEFAULT_TABLES,
  type FilesMigrationOptions,
  type FilesTables,
  filesMigration,
  type Migration,
} from './migration.ts'
export {
  SqlFileStore,
  type SqlFileStoreOptions,
  SqlQuotaCounter,
  type SqlQuotaCounterOptions,
} from './store.ts'
