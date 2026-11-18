import { NotFoundError } from '@strutvane/framework/core'
import { describe, expect, test } from 'vitest'
import { StorageUnavailableError, UnsafeKeyError } from '../src/errors.ts'
import { createFileManager } from '../src/manager.ts'
import { MemoryFileStore } from '../src/records.ts'
import { createS3Client } from '../src/s3/client.ts'
import { S3Disk } from '../src/s3/disk.ts'
import { spool } from '../src/spool.ts'
import { createFakeS3, s3Error } from './helpers/fake-s3.ts'
import { PDF } from './helpers/fixtures.ts'
import { readAll } from './helpers/memory-disk.ts'

const NOW = new Date('2026-11-14T12:00:00.000Z')
const fastRetry = { sleep: async () => {}, attempts: 3 }

function disk(options: Partial<ConstructorParameters<typeof S3Disk>[0]> = {}) {
  const fake = createFakeS3()
  const s3 = new S3Disk({
    bucket: 'uploads',
    client: fake.client,
    retry: fastRetry,
    now: () => NOW,
    ...options,
  })
  return { fake, s3 }
}

describe('S3Disk (in-process fake S3 behind the real SDK client)', () => {
  test('put/get/stat/exists/delete round trip with metadata and checksum', async () => {
    const { fake, s3 } = disk({ root: 'app', serverSideEncryption: 'AES256' })
    const stored = await s3.put('tenants/t1/a.pdf', PDF, {
      contentType: 'application/pdf',
      originalName: 'Ré port.pdf',
      metadata: { batch: '7' },
    })
    expect(stored).toMatchObject({
      disk: 's3',
      key: 'tenants/t1/a.pdf',
      size: PDF.length,
      visibility: 'private',
    })
    const raw = fake.objects.get('app/tenants/t1/a.pdf')
    expect(raw?.sse).toBe('AES256')
    expect(raw?.metadata).toMatchObject({
      sv_visibility: 'private',
      sv_name: 'R%C3%A9%20port.pdf',
      u_batch: '7',
    })
    expect(await readAll(await s3.get('tenants/t1/a.pdf'))).toEqual(PDF)
    expect(await s3.stat('tenants/t1/a.pdf')).toEqual({ ...stored, originalName: 'Ré port.pdf' })
    expect(await s3.exists('tenants/t1/a.pdf')).toBe(true)
    await s3.delete('tenants/t1/a.pdf')
    await s3.delete('tenants/t1/a.pdf') // idempotent
    expect(await s3.exists('tenants/t1/a.pdf')).toBe(false)
    expect(await s3.stat('tenants/t1/a.pdf')).toBeUndefined()
    await expect(s3.get('tenants/t1/a.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('the SHA-256 checksum is sent, so S3 rejects bytes corrupted in transit', async () => {
    const { fake, s3 } = disk()
    await using file = await spool(PDF)
    const corrupted = { ...file, sha256: '0'.repeat(64) }
    await expect(s3.putFile('a.pdf', corrupted)).rejects.toMatchObject({ name: 'BadDigest' })
    expect(fake.objects.size).toBe(0)
    const { s3: noChecksum } = disk({ checksum: false })
    await expect(noChecksum.putFile('a.pdf', corrupted)).resolves.toBeDefined()
  })

  test('path traversal keys are refused before any request is made', async () => {
    const { fake, s3 } = disk()
    for (const key of ['../x', '/abs', 'a/../../b', 'a\\b', ''])
      for (const call of [
        () => s3.put(key, 'x'),
        () => s3.get(key),
        () => s3.stat(key),
        () => s3.delete(key),
        () => s3.temporaryUrl(key),
      ])
        await expect(call()).rejects.toBeInstanceOf(UnsafeKeyError)
    await expect(s3.list('../')).rejects.toBeInstanceOf(UnsafeKeyError)
    expect(fake.calls).toEqual([])
    expect(() => new S3Disk({ bucket: 'b', client: fake.client, root: '../up' })).toThrow(
      UnsafeKeyError,
    )
    expect(() => new S3Disk({ bucket: '', client: fake.client })).toThrow(/bucket/)
    expect(() => new S3Disk({ bucket: 'b', client: fake.client, partSize: 1024 })).toThrow(/5 MiB/)
  })

  test('throttling (503 SlowDown) is retried with backoff, then succeeds', async () => {
    const { fake, s3 } = disk()
    fake.fail('PutObjectCommand', s3Error('SlowDown', 503), s3Error('InternalError', 500))
    await s3.put('a.txt', 'hello')
    expect(fake.calls.filter((c) => c === 'PutObjectCommand')).toHaveLength(3)
    expect(fake.objects.get('a.txt')?.body.toString()).toBe('hello')
  })

  test('provider down: retries exhausted → STORAGE_UNAVAILABLE 503 with Retry-After', async () => {
    const { fake, s3 } = disk()
    fake.fail(
      'PutObjectCommand',
      ...Array.from({ length: 3 }, () => s3Error('ServiceUnavailable', 503)),
    )
    const error = await s3.put('a.txt', 'x').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StorageUnavailableError)
    expect((error as StorageUnavailableError).headers['Retry-After']).toBeDefined()
    fake.fail(
      'HeadObjectCommand',
      ...Array.from({ length: 3 }, () => Object.assign(new Error('x'), { code: 'ECONNRESET' })),
    )
    await expect(s3.stat('a.txt')).rejects.toBeInstanceOf(StorageUnavailableError)
  })

  test('access denied is not retried and surfaces unchanged', async () => {
    const { fake, s3 } = disk()
    const denied = s3Error('AccessDenied', 403)
    fake.fail('GetObjectCommand', denied)
    await expect(s3.get('a.txt')).rejects.toBe(denied)
    fake.fail('HeadObjectCommand', denied)
    await expect(s3.stat('a.txt')).rejects.toBe(denied)
    fake.fail('DeleteObjectCommand', denied)
    await expect(s3.delete('a.txt')).rejects.toBe(denied)
    fake.fail('DeleteObjectCommand', s3Error('NoSuchKey', 404))
    await expect(s3.delete('a.txt')).resolves.toBeUndefined()
  })

  test('large files use multipart upload; a failed part aborts the upload', async () => {
    const MiB = 1024 * 1024
    const big = new Uint8Array(11 * MiB).map((_, i) => i % 251)
    const { fake, s3 } = disk({ multipartThreshold: 5 * MiB, partSize: 5 * MiB })
    const stored = await s3.put('big.bin', big)
    expect(stored.size).toBe(big.length)
    expect(fake.calls.filter((c) => c === 'UploadPartCommand')).toHaveLength(3)
    expect(new Uint8Array(fake.objects.get('big.bin')?.body ?? [])).toEqual(big)
    expect(await s3.stat('big.bin')).toMatchObject({ sha256: stored.sha256 })

    fake.fail('UploadPartCommand', s3Error('AccessDenied', 403))
    await expect(s3.put('big2.bin', big)).rejects.toMatchObject({ name: 'AccessDenied' })
    expect([...fake.multipart.values()].at(-1)?.aborted).toBe(true)
    expect(fake.objects.has('big2.bin')).toBe(false)
  })

  test('list pages through objects with metadata, inside the root only', async () => {
    const { s3 } = disk({ root: 'r' })
    for (const k of ['tenants/a/1', 'tenants/a/2', 'tenants/a/3', 'tenants/b/1']) await s3.put(k, k)
    const first = await s3.list('tenants/a/', { limit: 2 })
    expect(first.items.map((i) => i.key)).toEqual(['tenants/a/1', 'tenants/a/2'])
    expect(first.items[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const second = await s3.list('tenants/a/', {
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    })
    expect(second.items.map((i) => i.key)).toEqual(['tenants/a/3'])
    expect(second.nextCursor).toBeUndefined()
    expect((await s3.list('')).items).toHaveLength(4)
  })

  test('url(): only public files, only with a publicUrl; private files have none', async () => {
    const { s3 } = disk({ publicUrl: 'https://cdn.example.com/', root: 'app' })
    await s3.put('logo=1.png', 'x', { visibility: 'public' })
    await s3.put('secret.pdf', 'x')
    expect(await s3.url('logo=1.png')).toBe('https://cdn.example.com/app/logo%3D1.png')
    await expect(s3.url('secret.pdf')).rejects.toThrow(/no public URL/)
    await expect(s3.url('missing.png')).rejects.toBeInstanceOf(NotFoundError)
    const { s3: noCdn } = disk()
    await noCdn.put('p.png', 'x', { visibility: 'public' })
    await expect(noCdn.url('p.png')).rejects.toThrow(/no public URL/)
  })

  test('signed download URLs: 5 minutes by default, clamped to the maximum, response headers signed', async () => {
    const { s3 } = disk({ maxExpirySeconds: 900 })
    const url = new URL(await s3.temporaryUrl('tenants/t1/a.pdf'))
    expect(url.hostname).toBe('uploads.s3.eu-central-1.amazonaws.com')
    expect(url.pathname).toBe('/tenants/t1/a.pdf')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    const long = new URL(await s3.temporaryUrl('a.pdf', { expiresInSeconds: 86_400 }))
    expect(long.searchParams.get('X-Amz-Expires')).toBe('900')
    const download = new URL(
      await s3.temporaryUrl('a.pdf', {
        contentDisposition: 'attachment; filename="a.pdf"',
        contentType: 'application/pdf',
      }),
    )
    expect(download.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="a.pdf"',
    )
    expect(download.searchParams.get('response-content-type')).toBe('application/pdf')
    await expect(s3.temporaryUrl('a.pdf', { expiresInSeconds: 0 })).rejects.toThrow(RangeError)
  })

  test('presigned uploads sign Content-Type and Content-Length (no "small presign, huge upload")', async () => {
    const { s3 } = disk()
    const target = await s3.presignUpload('tenants/t1/u.pdf', {
      contentType: 'application/pdf',
      contentLength: 1234,
      visibility: 'public',
      originalName: 'u.pdf',
    })
    const url = new URL(target.url)
    expect(target.method).toBe('PUT')
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    )
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('x-amz-meta-sv_visibility')).toBe('public')
    expect(target.headers).toEqual({ 'content-type': 'application/pdf', 'content-length': '1234' })
    expect(target.expiresAt).toBe('2026-11-14T12:05:00.000Z')
    await expect(s3.presignUpload('a', { contentType: 'x/y', contentLength: -1 })).rejects.toThrow(
      RangeError,
    )
  })

  test('createS3Client configures path-style for custom endpoints and disables SDK retries', async () => {
    const minio = createS3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9000',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    })
    expect(await minio.config.forcePathStyle).toBe(true)
    expect(await minio.config.maxAttempts()).toBe(1)
    const aws = createS3Client({ region: 'eu-west-1' })
    expect(await aws.config.forcePathStyle).toBe(false)
    const explicit = createS3Client({ region: 'eu-west-1', forcePathStyle: true })
    expect(await explicit.config.forcePathStyle).toBe(true)
  })

  test('end to end through the file manager: tenant keys, putFile path, signed URLs', async () => {
    const { fake, s3 } = disk()
    const files = createFileManager({
      disks: { s3 },
      defaultDisk: 's3',
      store: new MemoryFileStore(),
    })
    const record = await files.store({ body: PDF, tenantId: 't1', resource: 'invoices' })
    expect([...fake.objects.keys()]).toEqual([record.key])
    expect(record.key.startsWith('tenants/t1/invoices/')).toBe(true)
    expect(
      new URL(await files.temporaryUrl('t1', record.id)).searchParams.get('X-Amz-Expires'),
    ).toBe('300')
    await expect(files.temporaryUrl('t2', record.id)).rejects.toBeInstanceOf(NotFoundError)
  })
})
