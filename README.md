# @strutvane/files

**File uploads that are safe by default:** cloud disks (AWS S3, Cloudflare R2, MinIO, Azure Blob), file and image fields, magic-byte type checks, image decoding with a decompression-bomb guard, EXIF/GPS stripping, virus scanning, per-tenant quotas, attachments with orphan cleanup, and presigned direct-to-cloud uploads.

Part of [Strutvane](https://github.com/vishwajit-vm/strutvane). Spec: [RFC-0002](https://github.com/vishwajit-vm/strutvane/blob/main/docs/rfcs/0002-file-storage-and-uploads.md). Status: `0.1.0-next.0`, not released yet.

## What it does for you (in plain words)

| You upload… | What happens |
|---|---|
| `invoice.pdf` that is really an `.exe` | Refused. The type comes from the file's bytes, never its name or the browser. |
| A 50 KB PNG that claims to be 50 000 × 50 000 pixels | Refused from its header, before a single pixel is decoded. |
| A phone photo with your home's GPS location inside | Stored without it. Metadata is stripped; the photo keeps its rotation. |
| An SVG with a `<script>` | Refused, even if you allowed `image/*`. Opt in explicitly, and it is always served as a download. |
| `../../etc/passwd` as a file name | Kept for display only (`passwd`). Storage keys are UUIDs the server generates. |
| A file while the virus scanner is down | Refused with a 503 (fail closed), or stored hidden until scanned — your choice. |
| A file while S3 is throttling | Retried with backoff and jitter, then a clean 503 with `Retry-After`. Nothing half-saved. |
| Tenant B guessing tenant A's file id | `404 Not Found`, never `403` (that would confirm it exists). |
| A form that never gets saved | The orphaned file is deleted by the cleanup job. |

## Install

```bash
pnpm add @strutvane/files
# then only what you use:
pnpm add @aws-sdk/client-s3 @aws-sdk/s3-request-presigner   # S3, R2, MinIO
pnpm add @azure/storage-blob @azure/identity                 # Azure Blob
pnpm add sharp                                               # images
```

## Quick start

```ts
import { createFileManager, createQuotaGuard, MemoryFileStore, MemoryQuotaCounter } from '@strutvane/files'
import { S3Disk, createS3Client } from '@strutvane/files/s3'

const s3 = new S3Disk({ bucket: process.env.S3_BUCKET!, client: createS3Client({ region: 'eu-central-1' }) })

const files = createFileManager({
  disks: { s3 },
  defaultDisk: 's3',
  store: new MemoryFileStore(),            // use SqlFileStore from '@strutvane/files/sql' in production
  quota: createQuotaGuard({ counter: new MemoryQuotaCounter(), limitFor: () => 5 * 1024 ** 3 }),
})

// 1. Store an upload (validated, stripped, scanned, quota-checked) → status "pending"
const pdf = await files.store({
  body: request.body,                      // a stream, bytes, or the framework's temp file
  tenantId: 'acme',
  resource: 'invoices',
  rules: { accept: ['application/pdf'], maxSize: '10MB' },
  clientName: 'March invoice.pdf',
})

// 2. Attach it when the record is saved (pass a transaction-bound store to commit atomically)
await files.commit({ tenantId: 'acme', resource: 'invoices', recordId: '42', field: 'pdf', fileIds: [pdf.id] })

// 3. Serve it: a signed URL valid for 5 minutes
const url = await files.temporaryUrl('acme', pdf.id)
```

### Fields (for models)

```ts
import { fileField, imageField, filesField } from '@strutvane/files'

fileField.validator({ accept: ['application/pdf'], maxSize: '10MB', required: true })
imageField.validator({ maxSize: '2MB', image: { maxWidth: 4000, maxHeight: 4000 } })
filesField.validator({ accept: ['image/*', 'application/pdf'], maxSize: '20MB', maxCount: 5 })
```

Each is a contracts `FieldType`: column per dialect, Standard Schema validator (issues carry stable codes such as `file_too_large`), JSON Schema for OpenAPI, and a UI widget name.

### Direct-to-cloud uploads

```ts
const { fileId, upload } = await files.createDirectUpload({
  tenantId: 'acme', resource: 'videos', contentType: 'video/mp4', size: 734_003_200,
})
// browser: fetch(upload.url, { method: upload.method, headers: upload.headers, body: file })
const record = await files.confirmDirectUpload({ tenantId: 'acme', fileId })
```

S3 signs the exact size and type; the confirm step re-checks size, magic bytes, image safety and the virus scan, and deletes anything that doesn't match.

### Images, scanning, SQL

```ts
import { createSharpImageProcessor, runVariantJob } from '@strutvane/files/images'
import { createClamAvScanner } from '@strutvane/files/clamav'
import { filesMigration, SqlFileStore, SqlQuotaCounter } from '@strutvane/files/sql'

createFileManager({ …, scanner: createClamAvScanner({ host: 'clamav' }), scanPolicy: 'fail-closed' })
filesMigration({ dialect: 'postgres', tenancy: true, runtimeRole: 'app_runtime' }) // tables + ADR-0007 RLS
```

The sharp processor is loaded automatically when `sharp` is installed. Variants (`createVariantJob` + `runVariantJob`) are generated on your queue, never during the request.

### Cleanup job

```ts
await files.cleanup() // unfinished uploads > 1 h, never-committed files > 24 h, deleted/quarantined > 30 days
```

Run it on a schedule. It is safe to run on several workers at once.

## Errors

| Code | Status | When |
|---|---|---|
| `VALIDATION_FAILED` with issues `file_too_large`, `file_too_small`, `file_empty`, `file_type_not_allowed`, `file_corrupt`, `image_dimensions_invalid`, `too_many_files` | 422 | A file breaks a field rule (the issue's `path` points at the file) |
| `QUOTA_EXCEEDED` | 422 | The tenant's quota would be exceeded |
| `FILE_INFECTED` | 422 | Malware found (the signature is logged, not sent) |
| `UPLOAD_INCOMPLETE` | 400 | A direct upload was confirmed before (or without) its bytes |
| `STORAGE_UNAVAILABLE` / `SCAN_UNAVAILABLE` | 503 + `Retry-After` | The provider or scanner is down |
| `NOT_FOUND` | 404 | Unknown file, another tenant's file, or a file that isn't servable |

Messages come from catalogs: `@strutvane/core`'s built-ins plus `FILES_MESSAGES_EN` from this package.

## Testing

`corepack pnpm@12.18.0 run ci` runs everything without Docker, using in-process fakes behind the real AWS and Azure SDK clients, a ClamAV-protocol server, real `sharp`, and real SQLite. `run test:integration` runs the disks against a real S3-compatible server (SeaweedFS), Azurite and PostgreSQL with RLS, in throwaway containers.

## License

MIT
