// The SQL store on real PostgreSQL, with the ADR-0007 RLS policies applied and queries run as a
// non-owner runtime role inside transaction-local tenant settings.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { SqlClient } from '../../src/sql/client.ts'
import { filesMigration } from '../../src/sql/migration.ts'
import { SqlFileStore, SqlQuotaCounter } from '../../src/sql/store.ts'
import { makeRecord, storeContract, TENANT_A, TENANT_B } from '../helpers/store-contract.ts'
import { type Container, startContainer, waitFor } from './docker.ts'

// Throwaway local credentials for a throwaway container (not secrets).
const OWNER_PASSWORD = 'owner-test-pw'
const RUNTIME_PASSWORD = 'runtime-test-pw'

let postgres: Container
let owner: pg.Pool
let runtime: pg.Pool

/** A client that runs each query in its own transaction with the tenant set transaction-locally. */
function tenantClient(tenant: string | null): SqlClient {
  return {
    async query(sql, params) {
      const conn = await runtime.connect()
      try {
        await conn.query('BEGIN')
        if (tenant) await conn.query("SELECT set_config('app.tenant_id', $1, true)", [tenant])
        const result = await conn.query(sql, [...params])
        await conn.query('COMMIT')
        return { rows: result.rows, rowCount: result.rowCount }
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => {})
        throw error
      } finally {
        conn.release()
      }
    },
  }
}

beforeAll(async () => {
  postgres = await startContainer('postgres:18.7-alpine', [5432], [], {
    POSTGRES_PASSWORD: OWNER_PASSWORD,
  })
  const port = await postgres.port(5432)
  owner = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    password: OWNER_PASSWORD,
    database: 'postgres',
  })
  await waitFor(async () => (await owner.query('SELECT 1')).rowCount === 1)
  await owner.query(
    `CREATE ROLE app_runtime LOGIN PASSWORD '${RUNTIME_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
  )
  for (const sql of filesMigration({
    dialect: 'postgres',
    tenancy: true,
    runtimeRole: 'app_runtime',
  }).up)
    await owner.query(sql)
  await owner.query(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON files, file_attachments, file_quota_usage TO app_runtime',
  )
  runtime = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'app_runtime',
    password: RUNTIME_PASSWORD,
    database: 'postgres',
  })
})

afterAll(async () => {
  await runtime?.end()
  await owner?.end()
  await postgres?.stop()
})

async function truncate(): Promise<void> {
  await owner.query('TRUNCATE file_attachments, files, file_quota_usage')
}

describe('SqlFileStore on PostgreSQL (contract, no RLS filter: owner connection)', () => {
  storeContract(
    async () => {
      await truncate()
      return new SqlFileStore({
        client: { query: async (sql, params) => owner.query(sql, [...params]) },
        dialect: 'postgres',
      })
    },
    { nullTenant: false }, // tenant_id is NOT NULL with tenancy
  )
})

describe('row-level security (ADR-0007)', () => {
  test('tenant B cannot read, update, attach to or delete tenant A rows', async () => {
    await truncate()
    const a = new SqlFileStore({ client: tenantClient(TENANT_A), dialect: 'postgres' })
    const b = new SqlFileStore({ client: tenantClient(TENANT_B), dialect: 'postgres' })
    const r = makeRecord({ tenantId: TENANT_A })
    await a.insert(r)
    expect(await a.get(TENANT_A, r.id)).toBeDefined()
    // Even asking with tenant A's id, B's connection sees nothing: RLS filters below the query.
    expect(await b.get(TENANT_A, r.id)).toBeUndefined()
    expect(
      await b.update(TENANT_A, r.id, ['pending'], { status: 'committed', updatedAt: r.updatedAt }),
    ).toBeUndefined()
    expect(await b.remove(TENANT_A, r.id)).toBe(false)
    expect(
      await b.findStale(undefined, { status: 'pending', before: '9999-01-01', limit: 10 }),
    ).toEqual([])
    // WITH CHECK: B cannot insert a row for A.
    await expect(b.insert(makeRecord({ tenantId: TENANT_A }))).rejects.toThrow(/row-level security/)
  })

  test('no tenant set → zero rows (fails closed), never an error or a leak', async () => {
    await truncate()
    await new SqlFileStore({ client: tenantClient(TENANT_A), dialect: 'postgres' }).insert(
      makeRecord({ tenantId: TENANT_A }),
    )
    const unscoped = new SqlFileStore({ client: tenantClient(null), dialect: 'postgres' })
    expect(
      await unscoped.findStale(undefined, { status: 'pending', before: '9999-01-01', limit: 10 }),
    ).toEqual([])
  })

  test('quota reservations are atomic under concurrency and isolated per tenant', async () => {
    await truncate()
    const counter = new SqlQuotaCounter({ client: tenantClient(TENANT_A), dialect: 'postgres' })
    const results = await Promise.all(
      Array.from({ length: 40 }, () => counter.reserve(TENANT_A, 10, 105)),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect(await counter.usage(TENANT_A)).toBe(100)
    const other = new SqlQuotaCounter({ client: tenantClient(TENANT_B), dialect: 'postgres' })
    expect(await other.usage(TENANT_A)).toBe(0) // invisible to tenant B
  })
})
