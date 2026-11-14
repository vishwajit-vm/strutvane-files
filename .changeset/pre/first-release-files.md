---
"@strutvane/files": minor
---

First implementation of `@strutvane/files` (RFC-0002 layer 3): `S3Disk` (`/s3`, also R2/MinIO) and `AzureBlobDisk` (`/azure`) implementing the contracts `StorageDisk` with spooled streaming uploads, SHA-256 integrity, private-by-default visibility, short-lived signed URLs, presigned direct uploads, and retries with backoff and jitter that end in `STORAGE_UNAVAILABLE`; `fileField`, `imageField` and `filesField` field types; magic-byte type allow-lists that refuse active content and executables by default; sharp-based image decoding with a pixel cap, EXIF/GPS stripping and queued variants (`/images`); a ClamAV INSTREAM scanner (`/clamav`) with fail-closed or pending-scan policies; per-tenant quotas; the file manager with pending → committed lifecycle, reference-counted attachments, direct-upload confirmation and orphan cleanup; and SQL tables with ADR-0007 row-level security, a SQL record store and an atomic quota counter (`/sql`).
