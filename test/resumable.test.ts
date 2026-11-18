// Resumable direct uploads (S3 multipart from the browser) through the file manager, against the
// real S3Disk on an in-process fake S3: happy path, resume after a lost part, and every attack or
// failure the protocol must survive (spoofed type, oversize, wrong-size parts, foreign tenants,
// scanner down, abandoned sessions, per-user quotas).
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTestClock, NotFoundError, ValidationError } from '@strutvane/framework/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { QuotaExceededError, ScanUnavailableError, UploadIncompleteError } from '../src/errors.ts'
import { createFileManager, type FileManagerOptions } from '../src/manager.ts'
import {
  createOwnerQuotaGuard,
  createQuotaGuard,
  MemoryOwnerQuotaCounter,
  MemoryQuotaCounter,
} from '../src/quota.ts'
import { MemoryFileStore } from '../src/records.ts'
import { S3Disk } from '../src/s3/disk.ts'
import type { ScanVerdict, VirusScanner } from '../src/scan.ts'
import { createFakeS3 } from './helpers/fake-s3.ts'
import { EXE, PDF } from './helpers/fixtures.ts'
import { MemoryDisk, readAll } from './helpers/memory-disk.ts'

const MiB = 1024 * 1024
const NOW = Date.UTC(2026, 10, 18, 12)
const RULES = { accept: ['application/pdf'], maxSize: '64MB' } as const

/** A PDF of `size` bytes: a real PDF header, then padding. */
function bigPdf(size: number): Buffer {
  const out = Buffer.alloc(size, 0x20)
  Buffer.from(PDF).copy(out)
  return out
}

let tempDir = ''
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sv-files-resumable-'))
})
afterEach(async () => {
  expect(await readdir(tempDir)).toEqual([]) // no temp file survives any path
  await rm(tempDir, { recursive: true, force: true })
})

function setup(overrides: Partial<FileManagerOptions> = {}) {
  const fake = createFakeS3()
  const s3 = new S3Disk({
    bucket: 'uploads',
    client: fake.client,
    retry: { sleep: async () => {}, attempts: 1 },
    now: () => new Date(NOW),
    tempDir,
  })
  const store = new MemoryFileStore()
  const counter = new MemoryQuotaCounter()
  const owners = new MemoryOwnerQuotaCounter()
  const clock = createTestClock(NOW)
  let n = 0
  const files = createFileManager({
    disks: { s3, local: new MemoryDisk('local') },
    defaultDisk: 's3',
    store,
    quota: createQuotaGuard({ counter, limitFor: () => 100 * MiB }),
    ownerQuota: createOwnerQuotaGuard({ counter: owners, limitFor: () => 30 * MiB }),
    imageProcessor: false,
    clock,
    id: () => `0190aaaa-bbbb-7ccc-8ddd-${String(++n).padStart(12, '0')}`,
    tempDir,
    ...overrides,
  })
  return { fake, s3, files, store, counter, owners, clock }
}

/** Do what the browser does: PUT each signed part (the fake checks the signed size). */
async function uploadParts(
  ctx: ReturnType<typeof setup>,
  fileId: string,
  body: Buffer,
  partNumbers: readonly number[],
): Promise<void> {
  const parts = await ctx.files.presignResumableParts({ tenantId: 't1', fileId, partNumbers })
  for (const part of parts) {
    const url = new URL(part.upload.url)
    const uploadId = url.searchParams.get('uploadId') ?? ''
    const start =
      (part.partNumber - 1) * ((await ctx.files.get('t1', fileId)).upload?.partSize ?? 0)
    const bytes = body.subarray(start, start + part.size)
    expect(Number(part.upload.headers['content-length'])).toBe(bytes.length)
    ctx.fake.putPart(uploadId, part.partNumber, bytes)
  }
}

const declared = (size: number) => ({
  tenantId: 't1',
  resource: 'reports',
  contentType: 'application/pdf',
  size,
  rules: RULES,
  clientName: 'Q3 report.pdf',
  ownerId: 'user-7',
})

describe('resumable uploads: the happy path', () => {
  test('create → signed part URLs → parts → complete → pending, with quota and integrity', async () => {
    const ctx = setup()
    const body = bigPdf(11 * MiB + 123)
    const created = await ctx.files.createResumableUpload(declared(body.length))
    expect(created).toEqual({ fileId: created.fileId, partSize: 8 * MiB, partCount: 2 })
    // Quota is reserved for the declared size before any byte arrives, for tenant and owner.
    expect(await ctx.counter.usage('t1')).toBe(body.length)
    expect(await ctx.owners.usage('t1', 'user-7')).toBe(body.length)

    const parts = await ctx.files.presignResumableParts({
      tenantId: 't1',
      fileId: created.fileId,
      partNumbers: [1, 2],
    })
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
      [1, 8 * MiB],
      [2, 3 * MiB + 123],
    ])
    for (const part of parts) {
      const url = new URL(part.upload.url)
      expect(part.upload.method).toBe('PUT')
      expect(url.searchParams.get('partNumber')).toBe(String(part.partNumber))
      // The exact size is signed: S3 refuses a bigger (or smaller) part.
      expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toContain('content-length')
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    }
    await uploadParts(ctx, created.fileId, body, [1, 2])
    const status = await ctx.files.resumableUploadStatus('t1', created.fileId)
    expect(status.uploadedParts).toEqual([1, 2])
    expect(status.missingParts).toEqual([])

    const record = await ctx.files.completeResumableUpload({
      tenantId: 't1',
      fileId: created.fileId,
      rules: RULES,
    })
    expect(record.status).toBe('pending')
    expect(record.size).toBe(body.length)
    expect(record.ownerId).toBe('user-7')
    expect(record.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(record.key).toMatch(/^tenants\/t1\/reports\/[0-9a-f-]{36}\.pdf$/)
    const stored = Buffer.from(await readAll(await ctx.s3.get(record.key)))
    expect(stored.equals(body)).toBe(true)
    // Idempotent: a retried completion returns the same record.
    expect(
      await ctx.files.completeResumableUpload({ tenantId: 't1', fileId: record.id, rules: RULES }),
    ).toEqual(record)
    expect(await ctx.counter.usage('t1')).toBe(body.length)
  })

  test('a small file is one part; the part size never drops below the disk minimum', async () => {
    const ctx = setup({ resumable: { partSize: 1024 } })
    const body = bigPdf(6 * MiB)
    const created = await ctx.files.createResumableUpload(declared(body.length))
    expect(created.partSize).toBe(5 * MiB) // S3's minimum wins over the configured 1 KiB
    expect(created.partCount).toBe(2)
    await uploadParts(ctx, created.fileId, body, [1, 2])
    const record = await ctx.files.completeResumableUpload({
      tenantId: 't1',
      fileId: created.fileId,
      rules: RULES,
    })
    expect(record.size).toBe(body.length)
  })
})

describe('resumable uploads: resuming', () => {
  test('a lost part is reported missing, completion waits for it, then succeeds', async () => {
    const ctx = setup()
    const body = bigPdf(17 * MiB)
    const { fileId } = await ctx.files.createResumableUpload(declared(body.length))
    await uploadParts(ctx, fileId, body, [1, 3])
    expect(await ctx.files.resumableUploadStatus('t1', fileId)).toMatchObject({
      uploadedParts: [1, 3],
      missingParts: [2],
    })
    await expect(
      ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES }),
    ).rejects.toBeInstanceOf(UploadIncompleteError)
    expect((await ctx.files.get('t1', fileId)).status).toBe('uploading') // still resumable
    await uploadParts(ctx, fileId, body, [2])
    const record = await ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES })
    expect(record.status).toBe('pending')
  })

  test('a part of the wrong size counts as missing and is never committed', async () => {
    const ctx = setup()
    const body = bigPdf(9 * MiB)
    const { fileId } = await ctx.files.createResumableUpload(declared(body.length))
    await uploadParts(ctx, fileId, body, [1])
    // A client that bypassed the signed size (possible on Azure, where a SAS can't pin it).
    const record = await ctx.files.get('t1', fileId)
    ctx.fake.putPart(record.upload?.id ?? '', 2, Buffer.alloc(5 * MiB))
    expect((await ctx.files.resumableUploadStatus('t1', fileId)).missingParts).toEqual([2])
    await expect(
      ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES }),
    ).rejects.toBeInstanceOf(UploadIncompleteError)
  })

  test('scanner down at completion: retryable; the next completion skips re-assembly', async () => {
    let up = false
    const scanner: VirusScanner = {
      name: 'flaky',
      async scan(stream: ReadableStream<Uint8Array>): Promise<ScanVerdict> {
        await readAll(stream)
        if (!up) throw new ScanUnavailableError()
        return { status: 'clean' }
      },
    }
    const ctx = setup({ scanner })
    const body = bigPdf(6 * MiB)
    const { fileId } = await ctx.files.createResumableUpload(declared(body.length))
    await uploadParts(ctx, fileId, body, [1])
    await expect(
      ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES }),
    ).rejects.toBeInstanceOf(ScanUnavailableError)
    expect((await ctx.files.get('t1', fileId)).status).toBe('uploading')
    up = true
    const record = await ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES })
    expect(record.scanStatus).toBe('clean')
    expect(ctx.fake.calls.filter((c) => c === 'CompleteMultipartUploadCommand')).toHaveLength(1)
  })
})

describe('resumable uploads: attacks and limits', () => {
  test('declared size over the limit: refused before a provider session exists', async () => {
    const ctx = setup()
    await expect(
      ctx.files.createResumableUpload({ ...declared(65 * MiB), rules: RULES }),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(ctx.fake.multipart.size).toBe(0)
    expect(await ctx.counter.usage('t1')).toBe(0)
  })

  test('a declared type outside the allow-list is refused up front', async () => {
    const ctx = setup()
    await expect(
      ctx.files.createResumableUpload({ ...declared(6 * MiB), contentType: 'text/html' }),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  test('content-type spoofing: an executable declared as PDF is rejected and everything rolls back', async () => {
    const ctx = setup()
    const body = Buffer.alloc(6 * MiB)
    Buffer.from(EXE).copy(body)
    const { fileId } = await ctx.files.createResumableUpload(declared(body.length))
    await uploadParts(ctx, fileId, body, [1])
    await expect(
      ctx.files.completeResumableUpload({ tenantId: 't1', fileId, rules: RULES }),
    ).rejects.toBeInstanceOf(ValidationError)
    await expect(ctx.files.get('t1', fileId)).rejects.toBeInstanceOf(NotFoundError)
    expect([...ctx.fake.objects.keys()].filter((k) => k.startsWith('tenants/'))).toEqual([])
    expect(await ctx.counter.usage('t1')).toBe(0)
    expect(await ctx.owners.usage('t1', 'user-7')).toBe(0)
  })

  test('part numbers outside the plan, or too many at once, are refused', async () => {
    const ctx = setup({ resumable: { maxPartsPerRequest: 2 } })
    const { fileId, partCount } = await ctx.files.createResumableUpload(declared(17 * MiB))
    for (const partNumbers of [[0], [partCount + 1], [1.5], [], [1, 2, 3]])
      await expect(
        ctx.files.presignResumableParts({ tenantId: 't1', fileId, partNumbers }),
      ).rejects.toBeInstanceOf(RangeError)
  })

  test("another tenant can't sign, inspect, complete or abort the upload (404, never 403)", async () => {
    const ctx = setup()
    const { fileId } = await ctx.files.createResumableUpload(declared(6 * MiB))
    await expect(
      ctx.files.presignResumableParts({ tenantId: 't2', fileId, partNumbers: [1] }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(ctx.files.resumableUploadStatus('t2', fileId)).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(
      ctx.files.completeResumableUpload({ tenantId: 't2', fileId, rules: RULES }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(ctx.files.abortResumableUpload('t2', fileId)).rejects.toBeInstanceOf(NotFoundError)
    await expect(ctx.files.resumableUploadStatus('t1', 'nope')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('per-user quota: refused for the user, and the tenant reservation is given back', async () => {
    const ctx = setup()
    await ctx.files.createResumableUpload(declared(20 * MiB))
    await expect(ctx.files.createResumableUpload(declared(20 * MiB))).rejects.toBeInstanceOf(
      QuotaExceededError,
    )
    expect(await ctx.counter.usage('t1')).toBe(20 * MiB)
    // Another user of the same tenant still has room.
    await ctx.files.createResumableUpload({ ...declared(20 * MiB), ownerId: 'user-8' })
  })

  test('an invalid owner id is refused before any quota is reserved', async () => {
    const ctx = setup()
    await expect(
      ctx.files.createResumableUpload({ ...declared(6 * MiB), ownerId: 'bad\u0000id' }),
    ).rejects.toBeInstanceOf(RangeError)
    expect(await ctx.counter.usage('t1')).toBe(0)
  })

  test('a disk without multipart support says so', async () => {
    const ctx = setup()
    await expect(
      ctx.files.createResumableUpload({ ...declared(6 * MiB), disk: 'local' }),
    ).rejects.toThrow('does not support resumable uploads')
  })

  test('a provider failure while opening the session leaves no row and no quota', async () => {
    const ctx = setup()
    ctx.fake.fail('CreateMultipartUploadCommand', new Error('boom'))
    await expect(ctx.files.createResumableUpload(declared(6 * MiB))).rejects.toThrow()
    expect(await ctx.counter.usage('t1')).toBe(0)
  })
})

describe('resumable uploads: abort and cleanup', () => {
  test('abort discards the parts, the row and the quota; a second abort is a 404', async () => {
    const ctx = setup()
    const body = bigPdf(6 * MiB)
    const { fileId } = await ctx.files.createResumableUpload(declared(body.length))
    await uploadParts(ctx, fileId, body, [1])
    const uploadId = (await ctx.files.get('t1', fileId)).upload?.id ?? ''
    await ctx.files.abortResumableUpload('t1', fileId)
    expect(ctx.fake.multipart.get(uploadId)?.aborted).toBe(true)
    await expect(ctx.files.get('t1', fileId)).rejects.toBeInstanceOf(NotFoundError)
    expect(await ctx.counter.usage('t1')).toBe(0)
    expect(await ctx.owners.usage('t1', 'user-7')).toBe(0)
    await expect(ctx.files.abortResumableUpload('t1', fileId)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('the cleanup job aborts abandoned sessions (their parts are billed until then)', async () => {
    const ctx = setup()
    const { fileId } = await ctx.files.createResumableUpload(declared(6 * MiB))
    const uploadId = (await ctx.files.get('t1', fileId)).upload?.id ?? ''
    ctx.clock.advance(2 * 3_600_000)
    const report = await ctx.files.cleanup()
    expect(report.removed).toBe(1)
    expect(ctx.fake.multipart.get(uploadId)?.aborted).toBe(true)
    expect(await ctx.counter.usage('t1')).toBe(0)
    expect(await ctx.owners.usage('t1', 'user-7')).toBe(0)
  })
})
