// AzureBlobDisk against Azurite (the official Azure Storage emulator).
import { BlobServiceClient } from '@azure/storage-blob'
import { NotFoundError } from '@strutvane/core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import type { AzureBlobDisk } from '../../src/azure/disk.ts'
import { createAzureBlobDisk } from '../../src/azure/factory.ts'
import { createFileManager } from '../../src/manager.ts'
import { MemoryFileStore } from '../../src/records.ts'
import { PDF } from '../helpers/fixtures.ts'
import { readAll } from '../helpers/memory-disk.ts'
import { type Container, startContainer, waitFor } from './docker.ts'

// Azurite's published development account (documented by Microsoft; not a secret).
const ACCOUNT = 'devstoreaccount1'
const KEY =
  'Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=='

let azurite: Container
let disk: AzureBlobDisk

beforeAll(async () => {
  azurite = await startContainer(
    'mcr.microsoft.com/azure-storage/azurite:latest',
    [10000],
    ['azurite-blob', '--blobHost', '0.0.0.0', '--skipApiVersionCheck', '--loose'],
  )
  const port = await azurite.port(10000)
  const connectionString = `DefaultEndpointsProtocol=http;AccountName=${ACCOUNT};AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:${port}/${ACCOUNT};`
  const service = BlobServiceClient.fromConnectionString(connectionString)
  await waitFor(async () => {
    await service.getContainerClient('files').createIfNotExists()
    return true
  })
  disk = await createAzureBlobDisk({
    containerName: 'files',
    auth: { connectionString },
    allowHttp: true,
  })
})

afterAll(async () => {
  await azurite?.stop()
})

describe('AzureBlobDisk on Azurite', () => {
  test('put/get/stat/list/delete with metadata', async () => {
    const stored = await disk.put('tenants/t1/a.pdf', PDF, {
      contentType: 'application/pdf',
      originalName: 'Ré.pdf',
    })
    expect(await readAll(await disk.get('tenants/t1/a.pdf'))).toEqual(PDF)
    expect(await disk.stat('tenants/t1/a.pdf')).toMatchObject({
      sha256: stored.sha256,
      originalName: 'Ré.pdf',
      size: PDF.length,
    })
    expect((await disk.list('tenants/t1/')).items.map((i) => i.key)).toEqual(['tenants/t1/a.pdf'])
    await disk.delete('tenants/t1/a.pdf')
    await disk.delete('tenants/t1/a.pdf')
    await expect(disk.get('tenants/t1/a.pdf')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('SAS download URLs work, are read-only, and expire', async () => {
    await disk.put('sas.txt', 'hello azure')
    const url = await disk.temporaryUrl('sas.txt', { expiresInSeconds: 2 })
    const ok = await fetch(url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('hello azure')
    const write = await fetch(url, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob' },
      body: 'overwrite',
    })
    expect(write.status).toBe(403)
    await new Promise((r) => setTimeout(r, 3500))
    expect((await fetch(url)).status).toBe(403)
  })

  test('direct upload → confirm; a size mismatch is caught on confirm and deleted', async () => {
    const files = createFileManager({
      disks: { azure: disk },
      defaultDisk: 'azure',
      store: new MemoryFileStore(),
    })
    const declared = {
      tenantId: 't1',
      resource: 'docs',
      contentType: 'application/pdf',
      size: PDF.length,
      rules: { accept: ['application/pdf'] },
    }
    const good = await files.createDirectUpload(declared)
    expect(
      (
        await fetch(good.upload.url, {
          method: 'PUT',
          headers: good.upload.headers,
          body: Buffer.from(PDF),
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await files.confirmDirectUpload({
          tenantId: 't1',
          fileId: good.fileId,
          rules: declared.rules,
        })
      ).status,
    ).toBe('pending')

    const bad = await files.createDirectUpload(declared)
    const lie = new Uint8Array([...PDF, ...new Uint8Array(50)]) // Azure SAS cannot pin the size
    expect(
      (
        await fetch(bad.upload.url, {
          method: 'PUT',
          headers: bad.upload.headers,
          body: Buffer.from(lie),
        })
      ).status,
    ).toBe(201)
    await expect(
      files.confirmDirectUpload({ tenantId: 't1', fileId: bad.fileId, rules: declared.rules }),
    ).rejects.toBeDefined()
    expect((await disk.list('tenants/t1/docs/')).items).toHaveLength(1)
  })
})
