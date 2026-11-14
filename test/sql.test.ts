// The SQL store and quota counter against a REAL engine: Node's built-in SQLite (no mocks for
// SQL). PostgreSQL, including RLS, runs in the integration suite.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { createFileManager } from '../src/manager.ts'
import { createQuotaGuard } from '../src/quota.ts'
import { MemoryFileStore } from '../src/records.ts'
import { quoteIdent, sqliteClient, toDialect } from '../src/sql/client.ts'
import { filesMigration } from '../src/sql/migration.ts'
import { SqlFileStore, SqlQuotaCounter } from '../src/sql/store.ts'
import { PDF } from './helpers/fixtures.ts'
import { MemoryDisk } from './helpers/memory-disk.ts'
import { storeContract } from './helpers/store-contract.ts'

function sqlite(tables?: { files: string; attachments: string; quota: string }) {
  const db = new DatabaseSync(':memory:')
  for (const sql of filesMigration({ dialect: 'sqlite', ...(tables ? { tables } : {}) }).up)
    db.exec(sql)
  return { db, client: sqliteClient(db) }
}

describe('MemoryFileStore (contract)', () => {
  storeContract(async () => new MemoryFileStore())
})

describe('SqlFileStore on SQLite (contract)', () => {
  storeContract(async () => new SqlFileStore({ client: sqlite().client, dialect: 'sqlite' }))
})

describe('SqlFileStore on SQLite with custom table names (contract)', () => {
  const tables = { files: 'app_files', attachments: 'app_file_links', quota: 'app_quota' }
  storeContract(
    async () => new SqlFileStore({ client: sqlite(tables).client, dialect: 'sqlite', tables }),
  )
})

describe('migration', () => {
  test('down drops everything up created', () => {
    const { db } = sqlite()
    for (const sql of filesMigration({ dialect: 'sqlite' }).down) db.exec(sql)
    const left = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    expect(left).toEqual([])
  })

  test('postgres + tenancy adds ADR-0007 RLS: RESTRICTIVE + FORCE + USING/WITH CHECK + NULLIF', () => {
    const { up } = filesMigration({
      dialect: 'postgres',
      tenancy: true,
      runtimeRole: 'app_runtime',
    })
    const sql = up.join(';\n')
    for (const table of ['files', 'file_attachments', 'file_quota_usage']) {
      expect(sql).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
      expect(sql).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
    }
    expect(
      sql.match(
        /AS RESTRICTIVE FOR ALL USING \((tenant_id|tenant_key) = NULLIF\(current_setting\('app.tenant_id', true\), ''\)::uuid\) WITH CHECK/g,
      ),
    ).toHaveLength(3)
    expect(sql).toContain('AS PERMISSIVE FOR ALL TO "app_runtime"')
    expect(sql).toContain('tenant_id uuid NOT NULL')
    const plain = filesMigration({ dialect: 'postgres' }).up.join(';')
    expect(plain).not.toContain('ROW LEVEL SECURITY')
    expect(plain).toContain('tenant_id uuid NULL')
  })

  test('identifiers are validated', () => {
    expect(() =>
      filesMigration({ dialect: 'sqlite', tables: { files: 'files; DROP TABLE x' } }),
    ).toThrow(/identifier/)
    expect(() => quoteIdent('Robert"); --')).toThrow()
    expect(toDialect('a = ? AND b = ?', 'postgres')).toBe('a = $1 AND b = $2')
    expect(toDialect('a = ?', 'sqlite')).toBe('a = ?')
    expect(
      () => new SqlFileStore({ client: sqlite().client, dialect: 'mysql' as 'sqlite' }),
    ).toThrow(/unsupported/)
  })

  test('the database enforces status, visibility and size constraints', () => {
    const { db } = sqlite()
    const insert = (status: string, size: number) =>
      db
        .prepare(
          `INSERT INTO files (id, tenant_id, disk, key, size, content_type, sha256, original_name, visibility, status, scan_status, created_at, updated_at)
           VALUES (?, NULL, 'd', ?, ?, 'x/y', '', 'n', 'private', ?, 'clean', 'now', 'now')`,
        )
        .run(`id-${status}-${size}`, `k-${status}-${size}`, size, status)
    expect(() => insert('bogus', 1)).toThrow(/CHECK/)
    expect(() => insert('pending', -1)).toThrow(/CHECK/)
    insert('pending', 1)
    expect(() => insert('pending', 1)).toThrow(/UNIQUE/) // same (disk, key)
  })
})

describe('SqlQuotaCounter on SQLite', () => {
  test('atomic reserve, refusal with current usage, release never below zero', async () => {
    const counter = new SqlQuotaCounter({ client: sqlite().client, dialect: 'sqlite' })
    expect(await counter.usage('t')).toBe(0)
    expect(await counter.reserve('t', 60, 100)).toEqual({ ok: true, used: 60 })
    expect(await counter.reserve('t', 50, 100)).toEqual({ ok: false, used: 60 })
    expect(await counter.reserve('t', 40, 100)).toEqual({ ok: true, used: 100 })
    await counter.release('t', 30)
    expect(await counter.usage('t')).toBe(70)
    await counter.release('t', 1000)
    expect(await counter.usage('t')).toBe(0)
    const results = await Promise.all(
      Array.from({ length: 20 }, () => counter.reserve('u', 10, 55)),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(5)
    expect(await counter.usage('u')).toBe(50)
  })
})

describe('the file manager on SQLite (real engine end to end)', () => {
  test('store → commit (in a transaction-bound store) → detach → cleanup', async () => {
    const { client } = sqlite()
    const store = new SqlFileStore({ client, dialect: 'sqlite' })
    const disk = new MemoryDisk('local')
    const counter = new SqlQuotaCounter({ client, dialect: 'sqlite' })
    let now = Date.UTC(2026, 10, 14)
    const files = createFileManager({
      disks: { local: disk },
      defaultDisk: 'local',
      store,
      quota: createQuotaGuard({ counter, limitFor: () => 10_000 }),
      clock: { now: () => now },
    })
    const tenant = '11111111-1111-4111-8111-111111111111'
    const f = await files.store({ body: PDF, tenantId: tenant, resource: 'invoices' })
    expect(await counter.usage(tenant)).toBe(PDF.length)
    await files.commit({
      tenantId: tenant,
      resource: 'invoices',
      recordId: '1',
      field: 'pdf',
      fileIds: [f.id],
      store: store.withClient(client),
    })
    expect((await files.get(tenant, f.id)).status).toBe('committed')
    await files.detach({ tenantId: tenant, resource: 'invoices', recordId: '1' })
    now += 31 * 24 * 3_600_000
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
    expect(disk.objects.size).toBe(0)
    expect(await counter.usage(tenant)).toBe(0)
  })
})
