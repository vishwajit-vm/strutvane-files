import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@strutvane/framework/contracts'
import { createTestClock, NotFoundError, ValidationError } from '@strutvane/framework/core'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  FileInfectedError,
  QuotaExceededError,
  ScanUnavailableError,
  StorageUnavailableError,
  UploadIncompleteError,
} from '../src/errors.ts'
import { createFileManager, type FileEvent, type FileManagerOptions } from '../src/manager.ts'
import { createQuotaGuard, MemoryQuotaCounter } from '../src/quota.ts'
import { MemoryFileStore } from '../src/records.ts'
import type { ScanVerdict, VirusScanner } from '../src/scan.ts'
import { spool } from '../src/spool.ts'
import { containsAscii, EXE, EXIF_MARKER, jpegWithGps, PDF, png, SVG } from './helpers/fixtures.ts'
import { MemoryDisk, PresigningMemoryDisk, readAll } from './helpers/memory-disk.ts'

const PDF_RULES = { accept: ['application/pdf'], maxSize: '1KB' } as const

function scanner(verdict: () => Promise<ScanVerdict>): VirusScanner & { calls: number } {
  const s = {
    name: 'fake',
    calls: 0,
    async scan(stream: ReadableStream<Uint8Array>) {
      s.calls++
      await readAll(stream)
      return verdict()
    },
  }
  return s
}

function setup(overrides: Partial<FileManagerOptions> = {}) {
  const disk = new PresigningMemoryDisk('local')
  const other = new MemoryDisk('other')
  const store = new MemoryFileStore()
  const counter = new MemoryQuotaCounter()
  const clock = createTestClock(Date.UTC(2026, 10, 14, 12))
  const events: FileEvent[] = []
  let n = 0
  const files = createFileManager({
    disks: { local: disk, other },
    defaultDisk: 'local',
    store,
    quota: createQuotaGuard({ counter, limitFor: () => 10_000 }),
    clock,
    id: () => `0190aaaa-bbbb-7ccc-8ddd-${String(++n).padStart(12, '0')}`,
    onEvent: (e) => {
      events.push(e)
    },
    tempDir,
    ...overrides,
  })
  return { files, disk, other, store, counter, clock, events }
}

// Each test gets its own temp parent directory, so the leak check below is exact even when
// other test files run in parallel.
let tempDir = ''
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'sv-files-test-'))
})
afterEach(async () => {
  // Every path, success or failure, must leave no temp files behind.
  expect(await readdir(tempDir)).toEqual([])
  await rm(tempDir, { recursive: true, force: true })
})

describe('store: the happy path', () => {
  test('stores a validated file as pending under a tenant key, with quota and an event', async () => {
    const { files, disk, counter, events } = setup()
    const record = await files.store({
      body: PDF,
      tenantId: 't1',
      resource: 'invoices',
      rules: PDF_RULES,
      clientName: '../../Invoice "March".pdf',
    })
    expect(record).toMatchObject({
      tenantId: 't1',
      disk: 'local',
      status: 'pending',
      scanStatus: 'not-scanned',
      contentType: 'application/pdf',
      size: PDF.length,
      visibility: 'private',
      originalName: 'Invoice "March".pdf',
    })
    expect(record.key).toMatch(/^tenants\/t1\/invoices\/0190aaaa-[0-9a-f-]+\.pdf$/)
    expect(record.key).not.toContain('Invoice')
    expect(await readAll(await disk.get(record.key))).toEqual(PDF)
    expect(await counter.usage('t1')).toBe(PDF.length)
    expect(events.map((e) => e.type)).toEqual(['files.stored'])
    expect(events[0]).toMatchObject({ tenantId: 't1', version: 1, payload: { fileId: record.id } })
    expect(JSON.stringify(events[0])).not.toContain('March') // no client names in events
  })

  test('accepts an already spooled file (the framework temp file) without copying or deleting it', async () => {
    const { files } = setup()
    await using spooled = await spool(PDF)
    const record = await files.store({
      body: spooled,
      tenantId: null,
      resource: 'docs',
      rules: PDF_RULES,
    })
    expect(record.key.startsWith('shared/docs/')).toBe(true)
    expect(record.sha256).toBe(spooled.sha256)
  })

  test('images are stripped of GPS before they reach storage', async () => {
    const { files, disk } = setup()
    const record = await files.store({
      body: await jpegWithGps(),
      tenantId: 't1',
      resource: 'photos',
    })
    const stored = await readAll(await disk.get(record.key))
    expect(containsAscii(stored, EXIF_MARKER)).toBe(false)
    expect((await sharp(stored).metadata()).exif).toBeUndefined()
    expect([record.width, record.height]).toEqual([20, 40])
  })

  test('without sharp (imageProcessor: false) raster images fail closed', async () => {
    const { files, disk } = setup({ imageProcessor: false })
    await expect(files.store({ body: await png(), tenantId: 't1', resource: 'x' })).rejects.toThrow(
      /sharp/,
    )
    expect(disk.objects.size).toBe(0)
  })

  test('active content (opted in) is stored as an attachment download', async () => {
    const { files } = setup()
    const record = await files.store({
      body: SVG,
      tenantId: 't1',
      resource: 'logos',
      rules: { accept: ['image/svg+xml'], allowActiveContent: true },
      clientName: 'logo.svg',
    })
    const url = new URL(await files.temporaryUrl('t1', record.id))
    expect(url.searchParams.get('disposition')).toMatch(/^attachment; filename="logo.svg"/)
  })
})

describe('store: every rejection leaves nothing behind', () => {
  test('too large: stops reading at the limit; no row, no bytes, no quota', async () => {
    const { files, disk, store, counter } = setup()
    let pulled = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(512))
      },
    })
    const error = await files
      .store({ body, tenantId: 't1', resource: 'x', rules: PDF_RULES, path: ['pdf'] })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ValidationError)
    expect((error as ValidationError).issues[0]).toMatchObject({
      code: 'file_too_large',
      path: ['pdf'],
    })
    expect(pulled).toBeLessThan(5)
    expect(disk.objects.size).toBe(0)
    expect(
      await store.findStale(undefined, { status: 'uploading', before: '9999', limit: 10 }),
    ).toEqual([])
    expect(await counter.usage('t1')).toBe(0)
  })

  test('magic-byte spoofing: a renamed .exe is refused', async () => {
    const { files, disk } = setup()
    const error = await files
      .store({
        body: EXE,
        tenantId: 't1',
        resource: 'x',
        rules: PDF_RULES,
        clientName: 'invoice.pdf',
      })
      .catch((e: unknown) => e)
    expect((error as ValidationError).issues[0]?.code).toBe('file_type_not_allowed')
    expect(disk.objects.size).toBe(0)
  })

  test('quota exceeded: refused before any bytes are written', async () => {
    const { files, disk } = setup({
      quota: createQuotaGuard({ counter: new MemoryQuotaCounter(), limitFor: () => 10 }),
    })
    await expect(
      files.store({ body: PDF, tenantId: 't1', resource: 'x', rules: PDF_RULES }),
    ).rejects.toBeInstanceOf(QuotaExceededError)
    expect(disk.puts).toBe(0)
  })

  test('virus found: FILE_INFECTED, never stored, logged with the signature', async () => {
    const warn = vi.fn()
    const logger = { warn, child: () => logger, error: vi.fn(), info: vi.fn() } as unknown as Logger
    const s = scanner(async () => ({ status: 'infected', signature: 'Eicar-Test' }))
    const { files, disk } = setup({ scanner: s, logger })
    await expect(files.store({ body: PDF, tenantId: 't1', resource: 'x' })).rejects.toBeInstanceOf(
      FileInfectedError,
    )
    expect(disk.objects.size).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      'upload rejected: malware detected',
      expect.objectContaining({ signature: 'Eicar-Test' }),
    )
  })

  test('scanner down: fail closed by default (503), nothing stored', async () => {
    const s = scanner(async () => {
      throw new Error('ECONNREFUSED')
    })
    const { files, disk, counter } = setup({ scanner: s })
    await expect(files.store({ body: PDF, tenantId: 't1', resource: 'x' })).rejects.toBeInstanceOf(
      ScanUnavailableError,
    )
    expect(disk.objects.size).toBe(0)
    expect(await counter.usage('t1')).toBe(0)
  })

  test('scanner down with pending-scan: stored but hidden until a scan marks it clean', async () => {
    let up = false
    const s = scanner(async () => {
      if (!up) throw new Error('down')
      return { status: 'clean' }
    })
    const { files } = setup({ scanner: s, scanPolicy: 'pending-scan' })
    const record = await files.store({ body: PDF, tenantId: 't1', resource: 'x' })
    expect(record.scanStatus).toBe('pending-scan')
    await expect(files.open('t1', record.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(files.temporaryUrl('t1', record.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(files.scanStored('t1', record.id)).rejects.toBeInstanceOf(ScanUnavailableError)
    up = true
    expect((await files.scanStored('t1', record.id)).scanStatus).toBe('clean')
    const { stream } = await files.open('t1', record.id)
    expect(await readAll(stream)).toEqual(PDF)
  })

  test('a later scan that finds malware quarantines the file and emits an event', async () => {
    const { files, events } = setup()
    const record = await files.store({ body: PDF, tenantId: 't1', resource: 'x' })
    const q = await files.markScanned('t1', record.id, {
      status: 'infected',
      signature: 'Late.Sig',
    })
    expect(q).toMatchObject({ status: 'quarantined', scanStatus: 'infected' })
    await expect(files.open('t1', record.id)).rejects.toBeInstanceOf(NotFoundError)
    expect(events.at(-1)).toMatchObject({
      type: 'files.infected',
      payload: { signature: 'Late.Sig' },
    })
    await expect(files.markScanned('t2', record.id, { status: 'clean' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('storage down: STORAGE_UNAVAILABLE; row removed, quota released, temp files gone', async () => {
    const { files, disk, store, counter } = setup()
    disk.failPuts = { error: new StorageUnavailableError('local'), times: 1 }
    await expect(files.store({ body: PDF, tenantId: 't1', resource: 'x' })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    )
    expect(
      await store.findStale(undefined, { status: 'uploading', before: '9999', limit: 10 }),
    ).toEqual([])
    expect(await counter.usage('t1')).toBe(0)
  })

  test('storage down AND rollback fails: the row stays "uploading" for the cleanup job', async () => {
    const { files, disk, store, counter, clock } = setup()
    disk.failPuts = { error: new Error('boom'), times: 1 }
    disk.failDeletes = { error: new Error('still down'), times: 1 }
    await expect(files.store({ body: PDF, tenantId: 't1', resource: 'x' })).rejects.toThrow('boom')
    const stuck = await store.findStale(undefined, {
      status: 'uploading',
      before: '9999',
      limit: 10,
    })
    expect(stuck).toHaveLength(1)
    clock.advance(2 * 3_600_000)
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
    expect(await counter.usage('t1')).toBe(0)
  })

  test('the record insert fails: quota released, nothing stored', async () => {
    const { files, store, disk, counter } = setup()
    vi.spyOn(store, 'insert').mockRejectedValueOnce(new Error('db down'))
    await expect(files.store({ body: PDF, tenantId: 't1', resource: 'x' })).rejects.toThrow(
      'db down',
    )
    expect(disk.objects.size).toBe(0)
    expect(await counter.usage('t1')).toBe(0)
  })

  test('client disconnects mid-upload: aborted, nothing stored', async () => {
    const { files, disk } = setup()
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        controller.abort(new Error('client disconnected'))
        c.enqueue(new Uint8Array(10))
      },
    })
    await expect(
      files.store({ body, tenantId: 't1', resource: 'x', signal: controller.signal }),
    ).rejects.toThrow('client disconnected')
    expect(disk.objects.size).toBe(0)
  })

  test('bad configuration fails fast', () => {
    expect(() => setup({ defaultDisk: 'nope' })).toThrow(/defaultDisk/)
  })

  test('unknown disk and unsafe resource names are programming errors', async () => {
    const { files } = setup()
    await expect(
      files.store({ body: PDF, tenantId: 't1', resource: 'x', disk: 'nope' }),
    ).rejects.toThrow(/Unknown disk/)
    await expect(files.store({ body: PDF, tenantId: 't1', resource: '../x' })).rejects.toThrow(
      /unsafe resource/,
    )
  })
})

describe('commit, replace, detach (attachments + reference counting)', () => {
  test('commit attaches pending files in order; foreign or unknown ids are 404', async () => {
    const { files, store, events } = setup()
    const a = await files.store({ body: PDF, tenantId: 't1', resource: 'invoices' })
    const b = await files.store({ body: 'hello', tenantId: 't1', resource: 'invoices' })
    const committed = await files.commit({
      tenantId: 't1',
      resource: 'invoices',
      recordId: '42',
      field: 'attachments',
      fileIds: [b.id, a.id],
    })
    expect(committed.map((f) => f.status)).toEqual(['committed', 'committed'])
    const attached = await store.listAttachments('t1', { resource: 'invoices', recordId: '42' })
    expect(attached.map((x) => [x.fileId, x.position])).toEqual([
      [b.id, 0],
      [a.id, 1],
    ])
    expect(events.filter((e) => e.type === 'files.committed')).toHaveLength(2)
    // Tenant B cannot attach tenant A's file, and cannot tell it exists.
    await expect(
      files.commit({
        tenantId: 't2',
        resource: 'invoices',
        recordId: '1',
        field: 'f',
        fileIds: [a.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      files.commit({
        tenantId: 't1',
        resource: 'invoices',
        recordId: '1',
        field: 'f',
        fileIds: ['0190aaaa-bbbb-7ccc-8ddd-999999999999'],
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('detaching the last reference marks the file deleted; shared files survive', async () => {
    const { files } = setup()
    const f = await files.store({ body: PDF, tenantId: 't1', resource: 'docs' })
    await files.commit({
      tenantId: 't1',
      resource: 'docs',
      recordId: '1',
      field: 'f',
      fileIds: [f.id],
    })
    await files.commit({
      tenantId: 't1',
      resource: 'docs',
      recordId: '2',
      field: 'f',
      fileIds: [f.id],
    })
    expect(await files.detach({ tenantId: 't1', resource: 'docs', recordId: '1' })).toEqual([])
    expect((await files.get('t1', f.id)).status).toBe('committed')
    expect(
      await files.detach({ tenantId: 't1', resource: 'docs', recordId: '2', field: 'f' }),
    ).toEqual([f.id])
    const deleted = await files.get('t1', f.id)
    expect(deleted.status).toBe('deleted')
    expect(deleted.deletedAt).toBeDefined()
    await expect(files.open('t1', f.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('replace keeps, adds and drops files of one field', async () => {
    const { files, store } = setup()
    const [a, b, c] = [
      await files.store({ body: 'a', tenantId: 't1', resource: 'r' }),
      await files.store({ body: 'b', tenantId: 't1', resource: 'r' }),
      await files.store({ body: 'c', tenantId: 't1', resource: 'r' }),
    ]
    const target = { tenantId: 't1', resource: 'r', recordId: '7', field: 'files' }
    await files.replace({ ...target, fileIds: [a.id, b.id] })
    await files.replace({ ...target, fileIds: [c.id, a.id] })
    const list = await store.listAttachments('t1', { resource: 'r', recordId: '7', field: 'files' })
    expect(list.map((x) => x.fileId)).toEqual([c.id, a.id])
    expect((await files.get('t1', b.id)).status).toBe('deleted')
  })

  test('committing an unconfirmed direct upload says UPLOAD_INCOMPLETE', async () => {
    const { files } = setup()
    const { fileId } = await files.createDirectUpload({
      tenantId: 't1',
      resource: 'r',
      contentType: 'application/pdf',
      size: PDF.length,
    })
    await expect(
      files.commit({ tenantId: 't1', resource: 'r', recordId: '1', field: 'f', fileIds: [fileId] }),
    ).rejects.toBeInstanceOf(UploadIncompleteError)
  })
})

describe('downloads: tenant isolation and signed URLs', () => {
  test("tenant B gets 404 for tenant A's file on every path", async () => {
    const { files } = setup()
    const f = await files.store({ body: PDF, tenantId: 'a', resource: 'r' })
    for (const call of [
      () => files.get('b', f.id),
      () => files.open('b', f.id),
      () => files.temporaryUrl('b', f.id),
      () => files.get(null, f.id),
      () => files.scanStored('b', f.id),
    ])
      await expect(call()).rejects.toBeInstanceOf(NotFoundError)
  })

  test('signed URLs default to 5 minutes, inline for safe types, attachment on request', async () => {
    const { files } = setup()
    const f = await files.store({ body: PDF, tenantId: 'a', resource: 'r', clientName: 'q1.pdf' })
    const inline = new URL(await files.temporaryUrl('a', f.id))
    expect(inline.searchParams.get('expires')).toBe('300')
    expect(inline.searchParams.get('disposition')).toMatch(/^inline; filename="q1.pdf"/)
    const download = new URL(
      await files.temporaryUrl('a', f.id, { download: true, expiresInSeconds: 60 }),
    )
    expect(download.searchParams.get('expires')).toBe('60')
    expect(download.searchParams.get('disposition')).toMatch(/^attachment;/)
  })
})

describe('dedupe', () => {
  test('identical content of the same tenant is stored once', async () => {
    const { files, disk } = setup({ dedupe: true })
    const a = await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    const b = await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    const c = await files.store({ body: PDF, tenantId: 't2', resource: 'r' })
    expect(b.id).toBe(a.id)
    expect(c.id).not.toBe(a.id)
    expect(disk.objects.size).toBe(2)
  })
})

describe('direct (presigned) uploads with confirm', () => {
  const declared = {
    tenantId: 't1',
    resource: 'docs',
    contentType: 'application/pdf',
    size: PDF.length,
    rules: PDF_RULES,
    clientName: 'a.pdf',
  }

  test('happy path: presign → client PUT → confirm → pending → commit', async () => {
    const { files, disk, counter } = setup()
    const { fileId, upload } = await files.createDirectUpload(declared)
    expect(upload.method).toBe('PUT')
    expect(disk.presigned[0]?.options).toMatchObject({
      contentType: 'application/pdf',
      contentLength: PDF.length,
      visibility: 'private',
      originalName: 'a.pdf',
    })
    expect(await counter.usage('t1')).toBe(PDF.length) // reserved up front
    const key = disk.presigned[0]?.key ?? ''
    await disk.simulateUpload(key, PDF, 'application/pdf')
    const confirmed = await files.confirmDirectUpload({ tenantId: 't1', fileId, rules: PDF_RULES })
    expect(confirmed).toMatchObject({
      status: 'pending',
      size: PDF.length,
      contentType: 'application/pdf',
    })
    expect(confirmed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await files.confirmDirectUpload({ tenantId: 't1', fileId })).id).toBe(fileId) // idempotent
    await files.commit({
      tenantId: 't1',
      resource: 'docs',
      recordId: '1',
      field: 'f',
      fileIds: [fileId],
    })
  })

  test('declared size or type outside the rules is refused before presigning', async () => {
    const { files, disk } = setup()
    const tooBig = await files
      .createDirectUpload({ ...declared, size: 10_000 })
      .catch((e: unknown) => e)
    expect((tooBig as ValidationError).issues[0]?.code).toBe('file_too_large')
    const wrongType = await files
      .createDirectUpload({ ...declared, contentType: 'text/html' })
      .catch((e: unknown) => e)
    expect((wrongType as ValidationError).issues[0]?.code).toBe('file_type_not_allowed')
    expect(disk.presigned).toHaveLength(0)
    await expect(files.createDirectUpload({ ...declared, size: -1 })).rejects.toThrow(RangeError)
    await expect(files.createDirectUpload({ ...declared, disk: 'other' })).rejects.toThrow(
      /direct uploads/,
    )
  })

  test('confirm before the object exists: UPLOAD_INCOMPLETE, and the upload stays retryable', async () => {
    const { files, disk } = setup()
    const { fileId } = await files.createDirectUpload(declared)
    await expect(
      files.confirmDirectUpload({ tenantId: 't1', fileId, rules: PDF_RULES }),
    ).rejects.toBeInstanceOf(UploadIncompleteError)
    await disk.simulateUpload(disk.presigned[0]?.key ?? '', PDF, 'application/pdf')
    expect(
      (await files.confirmDirectUpload({ tenantId: 't1', fileId, rules: PDF_RULES })).status,
    ).toBe('pending')
  })

  test('uploaded bytes differ from the declaration: deleted, row removed, quota released', async () => {
    for (const [bytes, expected] of [
      [
        EXE.slice(0, PDF.length).length === PDF.length
          ? EXE
          : new Uint8Array([...EXE, ...new Uint8Array(PDF.length - EXE.length)]),
        'file_type_not_allowed',
      ],
      [new Uint8Array(5000), 'file_too_large'],
      [PDF.slice(0, 10), 'UPLOAD_INCOMPLETE'],
    ] as const) {
      const { files, disk, store, counter } = setup()
      const { fileId } = await files.createDirectUpload(declared)
      const key = disk.presigned[0]?.key ?? ''
      await disk.simulateUpload(key, bytes, 'application/pdf')
      const error = await files
        .confirmDirectUpload({ tenantId: 't1', fileId, rules: PDF_RULES })
        .catch((e: unknown) => e)
      if (expected === 'UPLOAD_INCOMPLETE') expect(error).toBeInstanceOf(UploadIncompleteError)
      else expect((error as ValidationError).issues[0]?.code).toBe(expected)
      expect(disk.objects.has(key)).toBe(false)
      expect(await store.get('t1', fileId)).toBeUndefined()
      expect(await counter.usage('t1')).toBe(0)
    }
  })

  test('declared PDF but bytes are a valid PNG: refused (type mismatch with the signed declaration)', async () => {
    const { files, disk } = setup()
    const image = await png(4, 4)
    const { fileId } = await files.createDirectUpload({
      ...declared,
      size: image.length,
      rules: { accept: ['application/pdf', 'image/*'] },
    })
    await disk.simulateUpload(disk.presigned[0]?.key ?? '', image, 'application/pdf')
    const error = await files
      .confirmDirectUpload({
        tenantId: 't1',
        fileId,
        rules: { accept: ['application/pdf', 'image/*'] },
      })
      .catch((e: unknown) => e)
    expect((error as ValidationError).issues[0]?.code).toBe('file_type_not_allowed')
  })

  test('direct-uploaded images are sanitised and re-stored; quota follows the new size', async () => {
    const { files, disk, counter } = setup()
    const photo = await jpegWithGps()
    const { fileId } = await files.createDirectUpload({
      tenantId: 't1',
      resource: 'p',
      contentType: 'image/jpeg',
      size: photo.length,
    })
    const key = disk.presigned[0]?.key ?? ''
    await disk.simulateUpload(key, photo, 'image/jpeg')
    const record = await files.confirmDirectUpload({ tenantId: 't1', fileId })
    const stored = await readAll(await disk.get(key))
    expect(containsAscii(stored, EXIF_MARKER)).toBe(false)
    expect(record.size).toBe(stored.length)
    expect(await counter.usage('t1')).toBe(stored.length)
  })

  test('virus in a direct upload: deleted; scanner down: kept for a retry', async () => {
    let mode: 'infected' | 'down' = 'infected'
    const s = scanner(async () => {
      if (mode === 'down') throw new Error('down')
      return { status: 'infected', signature: 'X' }
    })
    const { files, disk } = setup({ scanner: s })
    const first = await files.createDirectUpload(declared)
    await disk.simulateUpload(disk.presigned[0]?.key ?? '', PDF, 'application/pdf')
    await expect(
      files.confirmDirectUpload({ tenantId: 't1', fileId: first.fileId, rules: PDF_RULES }),
    ).rejects.toBeInstanceOf(FileInfectedError)
    expect(disk.objects.size).toBe(0)
    mode = 'down'
    const second = await files.createDirectUpload(declared)
    await disk.simulateUpload(disk.presigned[1]?.key ?? '', PDF, 'application/pdf')
    await expect(
      files.confirmDirectUpload({ tenantId: 't1', fileId: second.fileId, rules: PDF_RULES }),
    ).rejects.toBeInstanceOf(ScanUnavailableError)
    expect(disk.objects.size).toBe(1)
  })

  test("confirm is tenant-scoped: tenant B cannot confirm tenant A's upload", async () => {
    const { files } = setup()
    const { fileId } = await files.createDirectUpload(declared)
    await expect(files.confirmDirectUpload({ tenantId: 't2', fileId })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('presign failure rolls back the row and the quota', async () => {
    const { files, disk, store, counter } = setup()
    disk.failPresign = new Error('signer down')
    await expect(files.createDirectUpload(declared)).rejects.toThrow('signer down')
    expect(
      await store.findStale(undefined, { status: 'uploading', before: '9999', limit: 5 }),
    ).toEqual([])
    expect(await counter.usage('t1')).toBe(0)
  })

  test('a quarantined file cannot be confirmed', async () => {
    const { files, store } = setup()
    const f = await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    await store.update('t1', f.id, ['pending'], { status: 'quarantined', updatedAt: 'x' })
    await expect(
      files.confirmDirectUpload({ tenantId: 't1', fileId: f.id }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('cleanup (the orphan job)', () => {
  test('removes expired uploads, never-committed files and purged files; releases quota', async () => {
    const { files, disk, counter, clock, events } = setup()
    const pending = await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    const committed = await files.store({ body: 'keep me', tenantId: 't1', resource: 'r' })
    await files.commit({
      tenantId: 't1',
      resource: 'r',
      recordId: '1',
      field: 'f',
      fileIds: [committed.id],
    })
    const upload = await files.createDirectUpload({
      tenantId: 't1',
      resource: 'r',
      contentType: 'application/pdf',
      size: 3,
    })
    expect(await counter.usage('t1')).toBe(PDF.length + 7 + 3)

    clock.advance(30 * 60_000) // 30 min: nothing is old enough
    expect(await files.cleanup()).toEqual({ removed: 0, failed: 0 })

    clock.advance(60 * 60_000) // 1.5 h: the unfinished upload expires
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
    await expect(files.get('t1', upload.fileId)).rejects.toBeInstanceOf(NotFoundError)

    clock.advance(24 * 3_600_000) // a day later: the never-committed file goes
    expect(await files.cleanup({ tenantId: 't1' })).toEqual({ removed: 1, failed: 0 })
    expect(disk.objects.has(pending.key)).toBe(false)
    expect((await files.get('t1', committed.id)).status).toBe('committed') // untouched

    await files.detach({ tenantId: 't1', resource: 'r', recordId: '1' })
    expect(await files.cleanup()).toEqual({ removed: 0, failed: 0 }) // still in retention
    clock.advance(31 * 24 * 3_600_000)
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
    expect(disk.objects.size).toBe(0)
    expect(await counter.usage('t1')).toBe(0)
    expect(events.filter((e) => e.type === 'files.purged')).toHaveLength(3)
  })

  test('a failed byte deletion keeps the row for the next run', async () => {
    const { files, disk, clock } = setup()
    await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    clock.advance(25 * 3_600_000)
    // Fails in the pending pass and again in the same run's retry (deleted pass)...
    disk.failDeletes = { error: new Error('throttled'), times: 2 }
    expect(await files.cleanup()).toEqual({ removed: 0, failed: 2 })
    // ...and succeeds on the next run, without waiting for the retention period.
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
  })

  test('two workers racing: exactly one removes each row and releases the quota once', async () => {
    const { files, counter, clock } = setup()
    await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    await files.store({ body: 'x', tenantId: 't1', resource: 'r' })
    clock.advance(25 * 3_600_000)
    const [a, b] = await Promise.all([files.cleanup(), files.cleanup()])
    expect((a?.removed ?? 0) + (b?.removed ?? 0)).toBe(2)
    expect(await counter.usage('t1')).toBe(0)
  })

  test('quarantined files are purged after retention; re-attached deleted files are kept', async () => {
    const { files, store, clock } = setup()
    const bad = await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    await files.markScanned('t1', bad.id, { status: 'infected', signature: 'S' })
    const shared = await files.store({ body: 'shared', tenantId: 't1', resource: 'r' })
    await files.commit({
      tenantId: 't1',
      resource: 'r',
      recordId: '1',
      field: 'f',
      fileIds: [shared.id],
    })
    await store.update('t1', shared.id, ['committed'], {
      status: 'deleted',
      updatedAt: new Date(0).toISOString(),
    })
    clock.advance(31 * 24 * 3_600_000)
    expect(await files.cleanup()).toEqual({ removed: 1, failed: 0 })
    expect((await store.get('t1', shared.id))?.status).toBe('deleted') // still attached: kept
  })

  test('a confirm racing the cleanup: whoever claims the row first wins cleanly', async () => {
    const { files, disk, store, clock } = setup()
    const { fileId } = await files.createDirectUpload({
      tenantId: 't1',
      resource: 'r',
      contentType: 'application/pdf',
      size: PDF.length,
    })
    await disk.simulateUpload(disk.presigned[0]?.key ?? '', PDF, 'application/pdf')
    clock.advance(2 * 3_600_000)
    // The cleanup claims the row between the confirm's checks and its final update.
    const update = store.update.bind(store)
    vi.spyOn(store, 'update').mockImplementationOnce(async (...args) => {
      await files.cleanup()
      return update(...args)
    })
    await expect(files.confirmDirectUpload({ tenantId: 't1', fileId })).rejects.toBeInstanceOf(
      NotFoundError,
    )
    expect(await store.get('t1', fileId)).toBeUndefined()
  })
})

describe('events and logging never break uploads', () => {
  test('a throwing event handler is logged, not thrown', async () => {
    const error = vi.fn()
    const logger = { error, warn: vi.fn(), child: () => logger } as unknown as Logger
    const { files } = setup({
      logger,
      onEvent: () => {
        throw new Error('bus down')
      },
    })
    await files.store({ body: PDF, tenantId: 't1', resource: 'r' })
    expect(error).toHaveBeenCalledWith(
      'file event handler failed',
      expect.objectContaining({ type: 'files.stored' }),
    )
  })

  test('works without quota, scanner, events or logger', async () => {
    const disk = new MemoryDisk('m')
    const files = createFileManager({
      disks: { m: disk },
      defaultDisk: 'm',
      store: new MemoryFileStore(),
      tempDir,
    })
    const f = await files.store({
      body: PDF,
      tenantId: null,
      resource: 'r',
      disk: 'm',
      visibility: 'public',
    })
    expect(f.visibility).toBe('public')
    await expect(files.scanStored(null, f.id)).rejects.toBeInstanceOf(ScanUnavailableError)
    expect(join('a', 'b')).toBeTruthy()
  })
})
