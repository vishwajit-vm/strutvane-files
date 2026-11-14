/**
 * `@strutvane/files/s3`: a `StorageDisk` for AWS S3 and S3-compatible stores (Cloudflare R2,
 * MinIO, Backblaze B2, …). Requires the optional peers `@aws-sdk/client-s3` and
 * `@aws-sdk/s3-request-presigner`.
 *
 * ```ts
 * const s3 = new S3Disk({
 *   bucket: env.S3_BUCKET,
 *   client: createS3Client({ region: env.S3_REGION }),
 * })
 * ```
 *
 * @module
 */
export { createS3Client, type S3ClientConfig } from './client.ts'
export { S3Disk, type S3DiskOptions } from './disk.ts'
