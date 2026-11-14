// One behavioural suite for every FileRecordStore (memory, SQLite, PostgreSQL), so they cannot
// drift apart.
import { expect, test } from 'vitest'
import type { FileRecord, FileRecordStore } from '../../src/records.ts'

let seq = 0
export function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  seq++
  const id = `0190aaaa-bbbb-7ccc-8ddd-${String(seq).padStart(12, '0')}`
  return {
    id,
    tenantId: '11111111-1111-4111-8111-111111111111',
    disk: 'local',
    key: `tenants/t/r/${id}.pdf`,
    size: 100,
    contentType: 'application/pdf',
    sha256: 'a'.repeat(64),
    originalName: 'été.pdf',
    visibility: 'private',
    status: 'pending',
    scanStatus: 'not-scanned',
    createdAt: '2026-11-14T10:00:00.000Z',
    updatedAt: '2026-11-14T10:00:00.000Z',
    ...overrides,
  }
}

export const TENANT_A = '11111111-1111-4111-8111-111111111111'
export const TENANT_B = '22222222-2222-4222-8222-222222222222'

/** Register the contract tests. `fresh` returns an empty store (and may set up tenancy). */
export function storeContract(
  fresh: () => Promise<FileRecordStore>,
  options: { nullTenant?: boolean } = {},
): void {
  test('insert/get round-trips every field; other tenants see nothing', async () => {
    const store = await fresh()
    const r = makeRecord({
      width: 20,
      height: 40,
      deletedAt: '2026-11-14T11:00:00.000Z',
      visibility: 'public',
    })
    await store.insert(r)
    expect(await store.get(TENANT_A, r.id)).toEqual(r)
    expect(await store.get(TENANT_B, r.id)).toBeUndefined()
    expect(await store.get(TENANT_A, '0190aaaa-bbbb-7ccc-8ddd-ffffffffffff')).toBeUndefined()
  })

  if (options.nullTenant !== false)
    test('null tenant (no tenancy) is its own scope', async () => {
      const store = await fresh()
      const r = makeRecord({ tenantId: null })
      await store.insert(r)
      expect((await store.get(null, r.id))?.tenantId).toBeNull()
      expect(await store.get(TENANT_A, r.id)).toBeUndefined()
    })

  test('update is compare-and-set on status and tenant', async () => {
    const store = await fresh()
    const r = makeRecord({ status: 'uploading', sha256: '' })
    await store.insert(r)
    const patch = {
      status: 'pending' as const,
      sha256: 'b'.repeat(64),
      size: 7,
      updatedAt: '2026-11-14T10:05:00.000Z',
    }
    expect(await store.update(TENANT_B, r.id, ['uploading'], patch)).toBeUndefined()
    expect(await store.update(TENANT_A, r.id, ['committed'], patch)).toBeUndefined()
    expect(await store.update(TENANT_A, r.id, [], patch)).toBeUndefined()
    const updated = await store.update(TENANT_A, r.id, ['uploading'], patch)
    expect(updated).toMatchObject({ status: 'pending', size: 7, sha256: 'b'.repeat(64) })
    expect(await store.update(TENANT_A, r.id, ['uploading'], patch)).toBeUndefined() // lost the race
  })

  test('findDuplicate only returns live, clean files of the same tenant', async () => {
    const store = await fresh()
    const sha = 'c'.repeat(64)
    await store.insert(makeRecord({ sha256: sha, status: 'quarantined', scanStatus: 'infected' }))
    await store.insert(makeRecord({ sha256: sha, tenantId: TENANT_B }))
    expect(await store.findDuplicate(TENANT_A, sha, 100)).toBeUndefined()
    const live = makeRecord({ sha256: sha, status: 'committed', scanStatus: 'clean' })
    await store.insert(live)
    expect((await store.findDuplicate(TENANT_A, sha, 100))?.id).toBe(live.id)
    expect(await store.findDuplicate(TENANT_A, sha, 101)).toBeUndefined()
  })

  test('attachments: upsert, ordered listing, counting, detaching (tenant-scoped)', async () => {
    const store = await fresh()
    const a = makeRecord()
    const b = makeRecord()
    await store.insert(a)
    await store.insert(b)
    const base = {
      tenantId: TENANT_A,
      resource: 'invoices',
      recordId: '42',
      createdAt: '2026-11-14T10:00:00.000Z',
    }
    await store.attach([
      { ...base, fileId: a.id, field: 'files', position: 1 },
      { ...base, fileId: b.id, field: 'files', position: 0 },
      { ...base, fileId: a.id, field: 'cover', position: 0 },
    ])
    await store.attach([{ ...base, fileId: a.id, field: 'files', position: 5 }]) // upsert
    const list = await store.listAttachments(TENANT_A, { resource: 'invoices', recordId: '42' })
    expect(list.map((x) => [x.field, x.fileId, x.position])).toEqual([
      ['cover', a.id, 0],
      ['files', b.id, 0],
      ['files', a.id, 5],
    ])
    expect(await store.listAttachments(TENANT_B, { resource: 'invoices', recordId: '42' })).toEqual(
      [],
    )
    expect(await store.attachmentCount(TENANT_A, a.id)).toBe(2)
    expect(await store.attachmentCount(TENANT_B, a.id)).toBe(0)
    expect(
      await store.detach(TENANT_A, {
        resource: 'invoices',
        recordId: '42',
        field: 'files',
        fileIds: [],
      }),
    ).toEqual([])
    expect(await store.detach(TENANT_B, { resource: 'invoices', recordId: '42' })).toEqual([])
    expect(
      await store.detach(TENANT_A, {
        resource: 'invoices',
        recordId: '42',
        field: 'files',
        fileIds: [b.id],
      }),
    ).toEqual([b.id])
    expect(
      [...(await store.detach(TENANT_A, { resource: 'invoices', recordId: '42' }))].sort(),
    ).toEqual([a.id])
    expect(await store.attachmentCount(TENANT_A, a.id)).toBe(0)
  })

  test('findStale: by status and age, oldest first, limited, optionally tenant-scoped', async () => {
    const store = await fresh()
    const old1 = makeRecord({ updatedAt: '2026-11-01T00:00:00.000Z' })
    const old2 = makeRecord({ updatedAt: '2026-11-02T00:00:00.000Z' })
    const recent = makeRecord({ updatedAt: '2026-11-14T00:00:00.000Z' })
    const other = makeRecord({ updatedAt: '2026-11-01T00:00:00.000Z', status: 'committed' })
    for (const r of [old2, old1, recent, other]) await store.insert(r)
    const q = { status: 'pending' as const, before: '2026-11-10T00:00:00.000Z', limit: 10 }
    expect((await store.findStale(TENANT_A, q)).map((r) => r.id)).toEqual([old1.id, old2.id])
    expect((await store.findStale(undefined, { ...q, limit: 1 })).map((r) => r.id)).toEqual([
      old1.id,
    ])
    expect(await store.findStale(TENANT_B, q)).toEqual([])
  })

  test('remove: deletes the row and its attachments; true exactly once', async () => {
    const store = await fresh()
    const r = makeRecord()
    await store.insert(r)
    await store.attach([
      {
        fileId: r.id,
        tenantId: TENANT_A,
        resource: 'x',
        recordId: '1',
        field: 'f',
        position: 0,
        createdAt: r.createdAt,
      },
    ])
    expect(await store.remove(TENANT_B, r.id)).toBe(false)
    expect(await store.remove(TENANT_A, r.id)).toBe(true)
    expect(await store.remove(TENANT_A, r.id)).toBe(false)
    expect(await store.attachmentCount(TENANT_A, r.id)).toBe(0)
  })
}
