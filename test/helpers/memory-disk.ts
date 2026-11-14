// A contract-only StorageDisk for tests (no putFile/presign), with failure injection. It
// mirrors @strutvane/framework's memory disk, which this package must not import.
import { createHash } from 'node:crypto'
import type {
  FileBody,
  FileListPage,
  PutOptions,
  StorageDisk,
  StoredFile,
} from '@strutvane/contracts'
import { NotFoundError } from '@strutvane/core'
import type { DirectUploadTarget, PresignUploadOptions } from '../../src/disk.ts'
import { assertSafeKey, assertSafePrefix } from '../../src/keys.ts'
import { toWebStream } from '../../src/spool.ts'

export interface MemoryObject {
  bytes: Uint8Array
  file: StoredFile
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export class MemoryDisk implements StorageDisk {
  readonly name: string
  readonly objects: Map<string, MemoryObject> = new Map()
  /** Throw this from the next N puts. */
  failPuts: { error: unknown; times: number } | undefined
  failDeletes: { error: unknown; times: number } | undefined
  puts = 0
  deletes = 0

  constructor(name = 'memory') {
    this.name = name
  }

  async put(key: string, body: FileBody, options: PutOptions = {}): Promise<StoredFile> {
    assertSafeKey(key)
    this.puts++
    const bytes = await readAll(toWebStream(body))
    if (this.failPuts && this.failPuts.times > 0) {
      this.failPuts.times--
      throw this.failPuts.error
    }
    const file: StoredFile = {
      disk: this.name,
      key,
      size: bytes.byteLength,
      contentType: options.contentType ?? 'application/octet-stream',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      visibility: options.visibility ?? 'private',
      createdAt: new Date().toISOString(),
    }
    this.objects.set(key, { bytes, file })
    return file
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    assertSafeKey(key)
    const o = this.objects.get(key)
    if (!o) throw new NotFoundError('file')
    return toWebStream(o.bytes)
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key)
  }

  async stat(key: string): Promise<StoredFile | undefined> {
    assertSafeKey(key)
    return this.objects.get(key)?.file
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key)
    this.deletes++
    if (this.failDeletes && this.failDeletes.times > 0) {
      this.failDeletes.times--
      throw this.failDeletes.error
    }
    this.objects.delete(key)
  }

  async list(prefix: string): Promise<FileListPage> {
    assertSafePrefix(prefix)
    return {
      items: [...this.objects.values()]
        .filter((o) => o.file.key.startsWith(prefix))
        .map((o) => o.file),
    }
  }

  async url(key: string): Promise<string> {
    const o = this.objects.get(key)
    if (!o) throw new NotFoundError('file')
    if (o.file.visibility !== 'public') throw new Error('private')
    return `https://cdn.test/${key}`
  }

  async temporaryUrl(
    key: string,
    options: { expiresInSeconds?: number; contentDisposition?: string } = {},
  ): Promise<string> {
    assertSafeKey(key)
    const params = new URLSearchParams({ expires: String(options.expiresInSeconds ?? 300) })
    if (options.contentDisposition) params.set('disposition', options.contentDisposition)
    return `https://signed.test/${key}?${params}`
  }
}

/** A memory disk that can presign uploads; tests "upload" by writing to `objects` directly. */
export class PresigningMemoryDisk extends MemoryDisk {
  presigned: { key: string; options: PresignUploadOptions }[] = []
  failPresign: unknown

  async presignUpload(key: string, options: PresignUploadOptions): Promise<DirectUploadTarget> {
    assertSafeKey(key)
    if (this.failPresign) throw this.failPresign
    this.presigned.push({ key, options })
    return {
      url: `https://upload.test/${key}`,
      method: 'PUT',
      headers: { 'content-type': options.contentType },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }
  }

  /** Simulate the browser's PUT to the presigned URL. */
  async simulateUpload(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await super.put(key, bytes, { contentType })
  }
}
