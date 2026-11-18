import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { TokenCredential } from '@azure/identity'
import {
  type BlobServiceClient,
  ContainerClient,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from '@azure/storage-blob'
import { NotFoundError } from '@strutvane/framework/core'
import { describe, expect, test, vi } from 'vitest'
import { AzureBlobDisk } from '../src/azure/disk.ts'
import { createAzureBlobDisk } from '../src/azure/factory.ts'
import { StorageUnavailableError, UnsafeKeyError } from '../src/errors.ts'
import { PDF } from './helpers/fixtures.ts'
import { readAll } from './helpers/memory-disk.ts'

// Azurite's published development account (not a secret).
const ACCOUNT = 'devstoreaccount1'
const KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='
const NOW = new Date('2026-11-14T12:00:00.000Z')

interface FakeBlob {
  body: Buffer
  contentType?: string | undefined
  contentDisposition?: string | undefined
  metadata: Record<string, string>
  lastModified: Date
}

const restError = (status: number, code: string) =>
  Object.assign(new Error(code), { name: 'RestError', statusCode: status, code })

/**
 * A real ContainerClient (so SAS generation is the real SDK code, offline) whose network
 * methods are answered from memory.
 */
function fakeContainer(credential: StorageSharedKeyCredential | TokenCredential) {
  const real = new ContainerClient(
    `https://${ACCOUNT}.blob.core.windows.net/files`,
    credential as StorageSharedKeyCredential,
  )
  const blobs = new Map<string, FakeBlob>()
  /** Uncommitted blocks per blob name (what Put Block with a part URL leaves behind). */
  const blocks = new Map<string, Map<string, Buffer>>()
  const failures: unknown[] = []
  const takeFailure = () => {
    const f = failures.shift()
    if (f) throw f
  }
  const container = Object.create(real) as ContainerClient
  Object.defineProperty(container, 'getBlockBlobClient', {
    value: (name: string) => {
      const blob = real.getBlockBlobClient(name)
      return Object.assign(Object.create(blob), {
        async uploadFile(
          path: string,
          options: {
            blobHTTPHeaders?: { blobContentType?: string; blobContentDisposition?: string }
            metadata?: Record<string, string>
          },
        ) {
          takeFailure()
          blobs.set(name, {
            body: await readFile(path),
            contentType: options.blobHTTPHeaders?.blobContentType,
            contentDisposition: options.blobHTTPHeaders?.blobContentDisposition,
            metadata: { ...options.metadata },
            lastModified: NOW,
          })
          return {}
        },
        async download() {
          takeFailure()
          const b = blobs.get(name)
          if (!b) throw restError(404, 'BlobNotFound')
          return { readableStreamBody: Readable.from([b.body]) }
        },
        async getProperties() {
          takeFailure()
          const b = blobs.get(name)
          if (!b) throw restError(404, 'BlobNotFound')
          return {
            contentLength: b.body.length,
            contentType: b.contentType,
            metadata: b.metadata,
            lastModified: b.lastModified,
          }
        },
        async deleteIfExists() {
          takeFailure()
          return { succeeded: blobs.delete(name) }
        },
        async getBlockList(kind: string) {
          takeFailure()
          expect(kind).toBe('uncommitted')
          const staged = blocks.get(name)
          if (!staged && !blobs.has(name)) throw restError(404, 'BlobNotFound')
          return {
            uncommittedBlocks: [...(staged ?? new Map()).entries()].map(([id, body]) => ({
              name: id,
              size: body.length,
            })),
          }
        },
        async commitBlockList(
          ids: string[],
          options: {
            blobHTTPHeaders?: { blobContentType?: string }
            metadata?: Record<string, string>
          },
        ) {
          takeFailure()
          const staged = blocks.get(name) ?? new Map<string, Buffer>()
          const parts = ids.map((id) => {
            const body = staged.get(id)
            if (!body) throw restError(400, 'InvalidBlockList')
            return body
          })
          blobs.set(name, {
            body: Buffer.concat(parts),
            contentType: options.blobHTTPHeaders?.blobContentType,
            metadata: { ...options.metadata },
            lastModified: NOW,
          })
          blocks.delete(name) // committing discards every other uncommitted block
          return {}
        },
      })
    },
  })
  Object.defineProperty(container, 'listBlobsFlat', {
    value: (options: { prefix: string }) => ({
      byPage: (page: { maxPageSize: number; continuationToken?: string }) => {
        const all = [...blobs.keys()].filter((k) => k.startsWith(options.prefix)).sort()
        const start = page.continuationToken ? Number(page.continuationToken) : 0
        const names = all.slice(start, start + page.maxPageSize)
        const next = start + page.maxPageSize < all.length ? String(start + page.maxPageSize) : ''
        return (async function* () {
          takeFailure()
          yield {
            continuationToken: next,
            segment: {
              blobItems: names.map((n) => {
                const b = blobs.get(n) as FakeBlob
                return {
                  name: n,
                  metadata: b.metadata,
                  properties: {
                    contentLength: b.body.length,
                    contentType: b.contentType,
                    lastModified: b.lastModified,
                  },
                }
              }),
            },
          }
        })()
      },
    }),
  })
  /** What the browser's part PUT does. */
  const stageBlock = (name: string, blockId: string, body: Buffer) => {
    const staged = blocks.get(name) ?? new Map<string, Buffer>()
    staged.set(blockId, body)
    blocks.set(name, staged)
  }
  return { container, blobs, blocks, failures, stageBlock }
}

const fastRetry = { sleep: async () => {}, attempts: 3 }

function sharedKeyDisk(options: Partial<ConstructorParameters<typeof AzureBlobDisk>[0]> = {}) {
  const fake = fakeContainer(new StorageSharedKeyCredential(ACCOUNT, KEY))
  const disk = new AzureBlobDisk({
    container: fake.container,
    retry: fastRetry,
    now: () => NOW,
    ...options,
  })
  return { ...fake, disk }
}

describe('AzureBlobDisk (in-memory blobs behind the real SDK client)', () => {
  test('put/get/stat/exists/delete round trip with metadata', async () => {
    const { disk, blobs } = sharedKeyDisk({ root: 'app' })
    const stored = await disk.put('tenants/t1/a.pdf', PDF, {
      contentType: 'application/pdf',
      originalName: 'Ré.pdf',
      contentDisposition: 'attachment',
    })
    expect(stored).toMatchObject({ disk: 'azure', size: PDF.length, visibility: 'private' })
    const raw = blobs.get('app/tenants/t1/a.pdf')
    expect(raw?.metadata).toMatchObject({ sv_visibility: 'private', sv_name: 'R%C3%A9.pdf' })
    expect(raw?.contentDisposition).toBe('attachment')
    expect(await readAll(await disk.get('tenants/t1/a.pdf'))).toEqual(PDF)
    expect(await disk.stat('tenants/t1/a.pdf')).toEqual({ ...stored, originalName: 'Ré.pdf' })
    expect(await disk.exists('tenants/t1/a.pdf')).toBe(true)
    await disk.delete('tenants/t1/a.pdf')
    await disk.delete('tenants/t1/a.pdf')
    expect(await disk.stat('tenants/t1/a.pdf')).toBeUndefined()
    await expect(disk.get('tenants/t1/a.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('unsafe keys are refused before any request', async () => {
    const { disk } = sharedKeyDisk()
    for (const key of ['../x', '/a', 'a\\b']) {
      await expect(disk.put(key, 'x')).rejects.toBeInstanceOf(UnsafeKeyError)
      await expect(disk.temporaryUrl(key)).rejects.toBeInstanceOf(UnsafeKeyError)
    }
    await expect(disk.list('..')).rejects.toBeInstanceOf(UnsafeKeyError)
    expect(() => sharedKeyDisk({ root: '../x' })).toThrow(UnsafeKeyError)
  })

  test('throttling (503 ServerBusy) is retried; exhausted → STORAGE_UNAVAILABLE', async () => {
    const { disk, failures, blobs } = sharedKeyDisk()
    failures.push(restError(503, 'ServerBusy'))
    await disk.put('a.txt', 'x')
    expect(blobs.has('a.txt')).toBe(true)
    failures.push(
      restError(500, 'InternalError'),
      restError(503, 'ServerBusy'),
      restError(503, 'ServerBusy'),
    )
    await expect(disk.stat('a.txt')).rejects.toBeInstanceOf(StorageUnavailableError)
    const denied = restError(403, 'AuthorizationFailure')
    failures.push(denied)
    await expect(disk.get('a.txt')).rejects.toBe(denied)
    failures.push(denied)
    await expect(disk.delete('a.txt')).rejects.toBe(denied)
    failures.push(restError(404, 'ContainerNotFound'))
    await expect(disk.delete('a.txt')).resolves.toBeUndefined()
  })

  test('list pages with metadata, inside the root', async () => {
    const { disk } = sharedKeyDisk({ root: 'r' })
    for (const k of ['p/1', 'p/2', 'p/3', 'q/1']) await disk.put(k, k)
    const first = await disk.list('p/', { limit: 2 })
    expect(first.items.map((i) => i.key)).toEqual(['p/1', 'p/2'])
    expect(first.items[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    const second = await disk.list('p/', first.nextCursor ? { cursor: first.nextCursor } : {})
    expect(second.items.map((i) => i.key)).toEqual(['p/3'])
    expect(second.nextCursor).toBeUndefined()
  })

  test('url(): public files only, CDN or blob URL', async () => {
    const { disk } = sharedKeyDisk({ publicUrl: 'https://cdn.example.com' })
    await disk.put('pub.png', 'x', { visibility: 'public' })
    await disk.put('priv.pdf', 'x')
    expect(await disk.url('pub.png')).toBe('https://cdn.example.com/pub.png')
    await expect(disk.url('priv.pdf')).rejects.toThrow(/no public URL/)
    await expect(disk.url('missing')).rejects.toBeInstanceOf(NotFoundError)
    const { disk: noCdn } = sharedKeyDisk()
    await noCdn.put('pub.png', 'x', { visibility: 'public' })
    expect(await noCdn.url('pub.png')).toBe(
      `https://${ACCOUNT}.blob.core.windows.net/files/pub.png`,
    )
  })

  test('SAS download URLs: read-only, HTTPS-only, 5 minutes by default, clamped, with skew start', async () => {
    const { disk } = sharedKeyDisk({ maxExpirySeconds: 600 })
    const url = new URL(
      await disk.temporaryUrl('tenants/t1/a.pdf', {
        contentDisposition: 'attachment; filename="a.pdf"',
        contentType: 'application/pdf',
      }),
    )
    expect(url.pathname).toBe('/files/tenants/t1/a.pdf')
    expect(url.searchParams.get('sp')).toBe('r')
    expect(url.searchParams.get('spr')).toBe('https')
    expect(url.searchParams.get('se')).toBe('2026-11-14T12:05:00Z')
    expect(url.searchParams.get('st')).toBe('2026-11-14T11:55:00Z')
    expect(url.searchParams.get('rscd')).toBe('attachment; filename="a.pdf"')
    expect(url.searchParams.get('rsct')).toBe('application/pdf')
    expect(url.searchParams.get('sig')).toBeTruthy()
    const long = new URL(await disk.temporaryUrl('a.pdf', { expiresInSeconds: 99_999 }))
    expect(long.searchParams.get('se')).toBe('2026-11-14T12:10:00Z')
    const { disk: local } = sharedKeyDisk({ allowHttp: true })
    expect(new URL(await local.temporaryUrl('a.pdf')).searchParams.get('spr')).toBe('https,http')
  })

  test('presigned uploads: create only (no overwrite), required headers, metadata as headers', async () => {
    const { disk } = sharedKeyDisk()
    const target = await disk.presignUpload('tenants/t1/u.pdf', {
      contentType: 'application/pdf',
      contentLength: 10,
      originalName: 'u.pdf',
    })
    const url = new URL(target.url)
    expect(url.searchParams.get('sp')).toBe('c')
    expect(target.headers).toMatchObject({
      'x-ms-blob-type': 'BlockBlob',
      'content-type': 'application/pdf',
      'x-ms-meta-sv_visibility': 'private',
      'x-ms-meta-sv_name': 'u.pdf',
    })
    expect(target.expiresAt).toBe('2026-11-14T12:05:00.000Z')
    await expect(
      disk.presignUpload('a', { contentType: 'x/y', contentLength: 1.5 }),
    ).rejects.toThrow(RangeError)
  })

  test('managed identity: SAS signed with a cached user delegation key', async () => {
    const token: TokenCredential = {
      getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }),
    }
    const fake = fakeContainer(token)
    const key: UserDelegationKey = {
      signedObjectId: 'oid',
      signedTenantId: 'tid',
      signedStartsOn: NOW,
      signedExpiresOn: new Date(NOW.getTime() + 86_400_000),
      signedService: 'b',
      signedVersion: '2025-01-05',
      value: Buffer.from('k'.repeat(32)).toString('base64'),
    }
    const getUserDelegationKey = vi.fn(async () => key)
    const serviceClient = { getUserDelegationKey } as unknown as BlobServiceClient
    let now = NOW
    const disk = new AzureBlobDisk({
      container: fake.container,
      serviceClient,
      now: () => now,
      retry: fastRetry,
    })
    const url = new URL(await disk.temporaryUrl('a.pdf'))
    expect(url.searchParams.get('skoid')).toBe('oid')
    expect(url.searchParams.get('sp')).toBe('r')
    await disk.temporaryUrl('b.pdf')
    expect(getUserDelegationKey).toHaveBeenCalledTimes(1) // cached
    now = new Date(NOW.getTime() + 23 * 3_600_000) // < 2 h left: refreshed
    await disk.temporaryUrl('c.pdf')
    expect(getUserDelegationKey).toHaveBeenCalledTimes(2)
    const noService = new AzureBlobDisk({ container: fake.container })
    await expect(noService.temporaryUrl('a.pdf')).rejects.toThrow(/serviceClient/)
  })

  test('createAzureBlobDisk: connection string, account key and managed identity', async () => {
    const fromConn = await createAzureBlobDisk({
      containerName: 'files',
      auth: {
        connectionString: `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:10000/${ACCOUNT};`,
      },
      allowHttp: true,
      now: () => NOW,
    })
    expect(new URL(await fromConn.temporaryUrl('a.txt')).host).toBe('127.0.0.1:10000')
    const fromKey = await createAzureBlobDisk({
      account: ACCOUNT,
      containerName: 'files',
      auth: { accountKey: KEY },
      name: 'az',
    })
    expect(fromKey.name).toBe('az')
    expect(new URL(await fromKey.temporaryUrl('a.txt')).host).toBe(
      `${ACCOUNT}.blob.core.windows.net`,
    )
    const mi = await createAzureBlobDisk({
      account: 'acct',
      containerName: 'files',
      auth: 'managed-identity',
    })
    expect(mi).toBeInstanceOf(AzureBlobDisk)
    await expect(
      createAzureBlobDisk({ containerName: 'f', auth: 'managed-identity' }),
    ).rejects.toThrow(/account/)
    await expect(
      createAzureBlobDisk({ containerName: 'f', auth: { accountKey: KEY } }),
    ).rejects.toThrow(/account/)
  })

  test('resumable uploads: create-only block SAS per part, size-checked listing, commit', async () => {
    const { disk, blobs, stageBlock } = sharedKeyDisk({ root: 'app' })
    const key = 'tenants/t1/big.pdf'
    const uploadId = await disk.createMultipartUpload(key, { contentType: 'application/pdf' })
    expect(uploadId).toMatch(/^[0-9a-f]{24}$/)
    expect(await disk.listUploadedParts(key, uploadId)).toEqual([]) // nothing staged yet
    const target = await disk.presignUploadPart(key, uploadId, 2, { contentLength: 3 })
    const url = new URL(target.url)
    expect(url.pathname).toBe('/files/app/tenants/t1/big.pdf')
    expect(url.searchParams.get('sp')).toBe('c') // cannot overwrite a committed blob
    expect(url.searchParams.get('comp')).toBe('block')
    expect(url.searchParams.get('spr')).toBe('https')
    const blockId = url.searchParams.get('blockid') ?? ''
    expect(Buffer.from(blockId, 'base64').toString()).toBe(`${uploadId}-000002`)
    expect(target.headers).toEqual({ 'content-length': '3' })

    const first = (await disk.presignUploadPart(key, uploadId, 1, { contentLength: 4 })).url
    stageBlock(`app/${key}`, new URL(first).searchParams.get('blockid') ?? '', Buffer.from('%PDF'))
    stageBlock(`app/${key}`, blockId, Buffer.from('-1.'))
    // A block from another session for the same blob is ignored, never committed.
    stageBlock(
      `app/${key}`,
      Buffer.from(`${'f'.repeat(24)}-000001`).toString('base64'),
      Buffer.from('evil'),
    )
    stageBlock(`app/${key}`, Buffer.from('not-ours').toString('base64'), Buffer.from('x'))
    const parts = await disk.listUploadedParts(key, uploadId)
    expect(parts.map((p) => [p.partNumber, p.size])).toEqual([
      [1, 4],
      [2, 3],
    ])
    await disk.completeMultipartUpload(key, uploadId, parts, {
      contentType: 'application/pdf',
      visibility: 'public',
      originalName: 'big.pdf',
    })
    expect(blobs.get(`app/${key}`)?.body.toString()).toBe('%PDF-1.')
    expect(await disk.stat(key)).toMatchObject({
      size: 7,
      contentType: 'application/pdf',
      visibility: 'public',
    })
    await disk.abortMultipartUpload(key, uploadId) // a no-op on Azure, but must not throw
  })

  test('resumable uploads: hostile ids and part numbers are refused before any request', async () => {
    const { disk } = sharedKeyDisk()
    const key = 'tenants/t1/big.pdf'
    for (const id of ['', 'ABC', '../x', 'f'.repeat(25)]) {
      await expect(disk.listUploadedParts(key, id)).rejects.toBeInstanceOf(RangeError)
      await expect(disk.presignUploadPart(key, id, 1, { contentLength: 1 })).rejects.toBeInstanceOf(
        RangeError,
      )
    }
    const id = await disk.createMultipartUpload(key, { contentType: 'application/pdf' })
    for (const n of [0, -1, 1.5, 50_001])
      await expect(disk.presignUploadPart(key, id, n, { contentLength: 1 })).rejects.toBeInstanceOf(
        RangeError,
      )
    for (const size of [0, 4000 * 1024 * 1024 + 1])
      await expect(
        disk.presignUploadPart(key, id, 1, { contentLength: size }),
      ).rejects.toBeInstanceOf(RangeError)
    await expect(
      disk.completeMultipartUpload(key, id, [], { contentType: 'x/y' }),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(disk.createMultipartUpload('../x', { contentType: 'x/y' })).rejects.toBeInstanceOf(
      UnsafeKeyError,
    )
  })
})
