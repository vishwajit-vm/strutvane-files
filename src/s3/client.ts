/**
 * Building an `S3Client` from plain configuration (the values the installer puts in `.env`).
 *
 * @module
 */
import { S3Client } from '@aws-sdk/client-s3'

/** S3 connection settings. Credentials are optional: without them the AWS default chain is used. */
export interface S3ClientConfig {
  /** e.g. `eu-central-1`. R2 uses `auto`. */
  readonly region: string
  /** Custom endpoint for S3-compatible stores (R2, MinIO). Omit for AWS. */
  readonly endpoint?: string
  /** Path-style URLs (`https://host/bucket/key`), required by MinIO. Default: `true` with an endpoint. */
  readonly forcePathStyle?: boolean
  /**
   * Static credentials. Prefer the default chain (IAM roles, IRSA, SSO) in production: no
   * long-lived secret to leak. Never log these values.
   */
  readonly credentials?: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
  /** SDK-level attempts. Default 1: `S3Disk` retries with its own backoff and error mapping. */
  readonly maxAttempts?: number
}

/**
 * Create an `S3Client` suited to `S3Disk`:
 * - SDK retries off (the disk retries, so attempts don't multiply);
 * - checksums only when required, so presigned upload URLs don't demand a checksum header the
 *   browser cannot compute (the disk sends its own SHA-256 on server-side uploads).
 */
export function createS3Client(config: S3ClientConfig): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint
      ? { endpoint: config.endpoint, forcePathStyle: config.forcePathStyle ?? true }
      : config.forcePathStyle === undefined
        ? {}
        : { forcePathStyle: config.forcePathStyle }),
    ...(config.credentials ? { credentials: { ...config.credentials } } : {}),
    maxAttempts: config.maxAttempts ?? 1,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
}
