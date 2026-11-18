// S3Disk against a real S3-compatible server: SeaweedFS's S3 gateway (real SigV4 signatures,
// presigned URL expiry, multipart). MinIO no longer publishes public container images, so
// SeaweedFS stands in; the disk only uses the standard S3 API either way.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateBucketCommand } from '@aws-sdk/client-s3'
import { NotFoundError } from '@strutvane/framework/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createFileManager } from '../../src/manager.ts'
import { MemoryFileStore } from '../../src/records.ts'
import { createS3Client } from '../../src/s3/client.ts'
import { S3Disk } from '../../src/s3/disk.ts'
import { EXIF_MARKER, jpegWithGps, PDF } from '../helpers/fixtures.ts'
import { readAll } from '../helpers/memory-disk.ts'
import { type Container, startContainer, waitFor } from './docker.ts'

// Throwaway local credentials for a throwaway container (not secrets).
const USER = 'svtestuser'
const PASS = 'svtestpassword123'

let server: Container
let configDir = ''
let s3: S3Disk

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'sv-s3-config-'))
  await writeFile(
    join(configDir, 's3.json'),
    JSON.stringify({
      identities: [
        {
          name: 'test',
          credentials: [{ accessKey: USER, secretKey: PASS }],
          actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
        },
      ],
    }),
  )
  server = await startContainer(
    'chrislusf/seaweedfs:latest',
    [8333],
    ['server', '-s3', '-s3.config=/etc/sv/s3.json', '-dir=/data'],
    {},
    { [configDir]: '/etc/sv' },
  )
  const port = await server.port(8333)
  const endpoint = `http://127.0.0.1:${port}`
  const client = createS3Client({
    region: 'us-east-1',
    endpoint,
    credentials: { accessKeyId: USER, secretAccessKey: PASS },
  })
  await waitFor(async () => {
    await client.send(new CreateBucketCommand({ Bucket: 'uploads' }))
    return true
  }, 90_000)
  s3 = new S3Disk({
    bucket: 'uploads',
    client,
    root: 'app',
    publicUrl: 'https://cdn.test',
    multipartThreshold: 5 * 1024 * 1024,
    partSize: 5 * 1024 * 1024,
  })
})

afterAll(async () => {
  await server?.stop()
  await rm(configDir, { recursive: true, force: true })
})

describe('S3Disk on an S3-compatible server (SeaweedFS)', () => {
  test('put/get/stat/list/delete with checksum and metadata', async () => {
    const stored = await s3.put('tenants/t1/a.pdf', PDF, {
      contentType: 'application/pdf',
      originalName: 'Ré.pdf',
    })
    expect(await readAll(await s3.get('tenants/t1/a.pdf'))).toEqual(PDF)
    expect(await s3.stat('tenants/t1/a.pdf')).toMatchObject({
      sha256: stored.sha256,
      contentType: 'application/pdf',
      originalName: 'Ré.pdf',
      visibility: 'private',
    })
    expect((await s3.list('tenants/t1/')).items.map((i) => i.key)).toEqual(['tenants/t1/a.pdf'])
    expect((await s3.list('tenants/t2/')).items).toEqual([])
    await s3.delete('tenants/t1/a.pdf')
    await s3.delete('tenants/t1/a.pdf')
    await expect(s3.get('tenants/t1/a.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('multipart upload of an 11 MiB file', async () => {
    const big = new Uint8Array(11 * 1024 * 1024).map((_, i) => i % 253)
    const stored = await s3.put('big.bin', big)
    expect(await s3.stat('big.bin')).toMatchObject({ size: big.length, sha256: stored.sha256 })
    expect(await readAll(await s3.get('big.bin'))).toEqual(big)
  })

  test('signed download URLs work, and stop working after they expire', async () => {
    await s3.put('signed.txt', 'secret contents')
    const url = await s3.temporaryUrl('signed.txt', {
      expiresInSeconds: 2,
      contentDisposition: 'attachment; filename="s.txt"',
    })
    const ok = await fetch(url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('secret contents')
    expect(ok.headers.get('content-disposition')).toBe('attachment; filename="s.txt"')
    // Tampering with the signed parameters is rejected.
    const tampered = await fetch(url.replace('signed.txt', 'other.txt'))
    expect(tampered.status).toBe(403)
    await new Promise((r) => setTimeout(r, 3500))
    expect((await fetch(url)).status).toBe(403)
    // Unsigned access to a private object is refused.
    expect((await fetch(url.split('?')[0] ?? '')).status).toBe(403)
  })

  test('presigned uploads: the signed size is enforced by the server', async () => {
    const target = await s3.presignUpload('direct/ok.pdf', {
      contentType: 'application/pdf',
      contentLength: PDF.length,
    })
    const ok = await fetch(target.url, {
      method: 'PUT',
      headers: target.headers,
      body: Buffer.from(PDF),
    })
    expect(ok.status).toBe(200)
    expect(await s3.stat('direct/ok.pdf')).toMatchObject({
      size: PDF.length,
      contentType: 'application/pdf',
    })
    const bigger = new Uint8Array(PDF.length + 100)
    const rejected = await fetch(target.url, {
      method: 'PUT',
      headers: { ...target.headers, 'content-length': String(bigger.length) },
      body: bigger,
    })
    expect(rejected.status).toBe(403)
  })

  test('end to end: direct upload → confirm (image stripped) → signed URL; tenant isolation', async () => {
    const files = createFileManager({
      disks: { s3 },
      defaultDisk: 's3',
      store: new MemoryFileStore(),
    })
    const photo = await jpegWithGps()
    const { fileId, upload } = await files.createDirectUpload({
      tenantId: 't1',
      resource: 'photos',
      contentType: 'image/jpeg',
      size: photo.length,
    })
    const put = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: Buffer.from(photo),
    })
    expect(put.status).toBe(200)
    const record = await files.confirmDirectUpload({ tenantId: 't1', fileId })
    expect(record.status).toBe('pending')
    const downloaded = new Uint8Array(
      await (await fetch(await files.temporaryUrl('t1', fileId))).arrayBuffer(),
    )
    expect(Buffer.from(downloaded).includes(EXIF_MARKER)).toBe(false)
    expect(downloaded.length).toBe(record.size)
    await expect(files.temporaryUrl('t2', fileId)).rejects.toBeInstanceOf(NotFoundError)
  })
})
