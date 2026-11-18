// An in-process S3 for unit tests. It replaces `send` on a REAL S3Client, so presigning
// (getSignedUrl) still runs the real SDK signer offline, while every request is answered from
// memory. It verifies what real S3 verifies for our requests: x-amz-checksum-sha256 must match
// the body (BadDigest otherwise), and Content-Length must match.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'

export interface FakeObject {
  body: Buffer
  contentType?: string | undefined
  contentDisposition?: string | undefined
  metadata: Record<string, string>
  lastModified: Date
  sse?: string | undefined
}

export function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })
}

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body === undefined) return Buffer.alloc(0)
  if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body)
  const chunks: Buffer[] = []
  for await (const c of body as Readable) chunks.push(Buffer.from(c as Uint8Array))
  return Buffer.concat(chunks)
}

export interface FakeS3 {
  client: S3Client
  objects: Map<string, FakeObject>
  calls: string[]
  /** Queue failures for the next calls of a command name, e.g. `fail('PutObjectCommand', err)`. */
  fail(command: string, ...errors: unknown[]): void
  multipart: Map<string, MultipartState>
  /** What a browser does with a presigned part URL: store a part (S3 checks the signed size). */
  putPart(uploadId: string, partNumber: number, body: Buffer): void
}

export interface MultipartState {
  key: string
  parts: Map<number, Buffer>
  aborted: boolean
  completed?: boolean
}

export function createFakeS3(): FakeS3 {
  const client = new S3Client({
    region: 'eu-central-1',
    credentials: {
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
  })
  const objects = new Map<string, FakeObject>()
  const calls: string[] = []
  const failures = new Map<string, unknown[]>()
  const multipart = new Map<string, MultipartState>()
  const live = (id: string): MultipartState => {
    const m = multipart.get(id)
    if (!m || m.aborted || m.completed) throw s3Error('NoSuchUpload', 404)
    return m
  }
  let uploads = 0

  const handle = async (command: unknown): Promise<unknown> => {
    const name = (command as { constructor: { name: string } }).constructor.name
    calls.push(name)
    const queued = failures.get(name)
    if (queued && queued.length > 0) throw queued.shift()
    const input = (command as { input: Record<string, unknown> }).input
    const key = String(input['Key'] ?? '')
    if (command instanceof PutObjectCommand) {
      const body = await bodyBytes(input['Body'])
      if (input['ContentLength'] !== undefined && input['ContentLength'] !== body.length)
        throw s3Error('IncompleteBody', 400)
      if (input['IfNoneMatch'] === '*' && objects.has(key)) throw s3Error('PreconditionFailed', 412)
      const checksum = input['ChecksumSHA256']
      if (checksum && createHash('sha256').update(body).digest('base64') !== checksum)
        throw s3Error('BadDigest', 400)
      objects.set(key, {
        body,
        contentType: input['ContentType'] as string | undefined,
        contentDisposition: input['ContentDisposition'] as string | undefined,
        metadata: { ...(input['Metadata'] as Record<string, string>) },
        lastModified: new Date(),
        sse: input['ServerSideEncryption'] as string | undefined,
      })
      return { $metadata: { httpStatusCode: 200 } }
    }
    if (command instanceof GetObjectCommand) {
      const o = objects.get(key)
      if (!o) throw s3Error('NoSuchKey', 404)
      return { Body: { transformToWebStream: () => Readable.toWeb(Readable.from([o.body])) } }
    }
    if (command instanceof HeadObjectCommand) {
      const o = objects.get(key)
      if (!o) throw s3Error('NotFound', 404)
      return {
        ContentLength: o.body.length,
        ContentType: o.contentType,
        Metadata: Object.fromEntries(
          Object.entries(o.metadata).map(([k, v]) => [k.toLowerCase(), v]),
        ),
        LastModified: o.lastModified,
      }
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(key)
      return {}
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = String(input['Prefix'] ?? '')
      const max = Number(input['MaxKeys'] ?? 1000)
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = input['ContinuationToken'] ? Number(input['ContinuationToken']) : 0
      const page = all.slice(start, start + max)
      const truncated = start + max < all.length
      return {
        Contents: page.map((k) => ({ Key: k })),
        IsTruncated: truncated,
        ...(truncated ? { NextContinuationToken: String(start + max) } : {}),
      }
    }
    if (command instanceof CreateMultipartUploadCommand) {
      const id = `upload-${++uploads}`
      multipart.set(id, { key, parts: new Map(), aborted: false })
      objects.set(`__pending__/${id}`, {
        body: Buffer.alloc(0),
        contentType: input['ContentType'] as string | undefined,
        metadata: { ...(input['Metadata'] as Record<string, string>) },
        lastModified: new Date(),
      })
      return { UploadId: id }
    }
    if (command instanceof UploadPartCommand) {
      const m = live(String(input['UploadId']))
      const body = await bodyBytes(input['Body'])
      if (body.length !== input['ContentLength']) throw s3Error('IncompleteBody', 400)
      m.parts.set(Number(input['PartNumber']), body)
      return { ETag: `"etag-${input['PartNumber']}"` }
    }
    if (command instanceof ListPartsCommand) {
      const m = live(String(input['UploadId']))
      return {
        Parts: [...m.parts.entries()]
          .sort(([a], [b]) => a - b)
          .map(([n, body]) => ({ PartNumber: n, Size: body.length, ETag: `"etag-${n}"` })),
        IsTruncated: false,
      }
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const id = String(input['UploadId'])
      const m = live(id)
      const parts = (input['MultipartUpload'] as { Parts: { PartNumber: number; ETag: string }[] })
        .Parts
      for (const part of parts)
        if (!m.parts.has(part.PartNumber) || part.ETag !== `"etag-${part.PartNumber}"`)
          throw s3Error('InvalidPart', 400)
      m.completed = true
      const pending = objects.get(`__pending__/${id}`)
      objects.delete(`__pending__/${id}`)
      objects.set(m.key, {
        body: Buffer.concat(parts.map((p) => m.parts.get(p.PartNumber) ?? Buffer.alloc(0))),
        contentType: pending?.contentType,
        metadata: pending?.metadata ?? {},
        lastModified: new Date(),
      })
      return {}
    }
    if (command instanceof AbortMultipartUploadCommand) {
      const id = String(input['UploadId'])
      const m = multipart.get(id)
      if (m) m.aborted = true
      objects.delete(`__pending__/${id}`)
      return {}
    }
    throw new Error(`fake S3: unsupported command ${name}`)
  }

  // Replace only `send`; the middleware stack (used by the presigner) stays real.
  Object.defineProperty(client, 'send', { value: handle })
  return {
    client,
    objects,
    calls,
    multipart,
    putPart(uploadId, partNumber, body) {
      live(uploadId).parts.set(partNumber, body)
    },
    fail(command, ...errors) {
      failures.set(command, [...(failures.get(command) ?? []), ...errors])
    },
  }
}
