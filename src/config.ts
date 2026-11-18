/**
 * Cloud disks in `config/filesystems.ts` (RFC-0002 §5), Laravel's `s3` disk for TypeScript.
 *
 * ```ts
 * // config/filesystems.ts (the installer adds the cloud disk)
 * export default defineConfig((env) => ({
 *   default: env.string('FILESYSTEM_DISK', 'local'),
 *   disks: {
 *     local: { driver: 'local', root: 'storage/app' },
 *     s3: {
 *       driver: 's3',
 *       bucket: env.string('AWS_BUCKET', ''),
 *       region: env.string('AWS_DEFAULT_REGION', 'us-east-1'),
 *       key: env.optional('AWS_ACCESS_KEY_ID'),
 *       secret: env.optional('AWS_SECRET_ACCESS_KEY'),
 *       endpoint: env.optional('AWS_ENDPOINT'),
 *       usePathStyleEndpoint: env.boolean('AWS_USE_PATH_STYLE_ENDPOINT', false),
 *       url: env.optional('AWS_URL'),
 *     },
 *   },
 * }))
 * ```
 *
 * This module only *reads and checks* the settings; it never loads a cloud SDK, so the main
 * entry stays light. `@strutvane/files/provider` turns the result into disks.
 *
 * Failure scenarios, and how each one fails closed:
 * - **A setting of the wrong type** (a number for `bucket`, a string for `checksum`): boot stops
 *   with a {@link FilesConfigError} naming the disk and the setting. A typo must never silently
 *   change where files go.
 * - **A cloud disk with an empty bucket or container** (a fresh clone whose `.env` has no
 *   `AWS_BUCKET` yet): the disk is *registered but unconfigured*. Every call on it fails with a
 *   message that names the missing `.env` key, and the app still boots, as in Laravel, where an
 *   unused `s3` disk never blocks a local app. If that disk is the **default** disk, boot stops.
 * - **Half a static credential** (`key` without `secret`): boot stops; sending one half would
 *   fall back to an unexpected identity.
 * - **Plain-HTTP endpoints** are refused unless the host is a loopback address (MinIO, Azurite
 *   on a developer machine): credentials and signed URLs must not travel in clear text.
 *
 * @module
 */
import { StrutvaneError } from '@strutvane/framework/core'

/** The cloud drivers this package adds. `azure` is an alias of `azure-blob`. */
export const CLOUD_DRIVERS: readonly string[] = ['s3', 'azure-blob', 'azure']

/** A disk entry for an S3 or S3-compatible store (AWS, Cloudflare R2, MinIO, DigitalOcean Spaces). */
export interface S3DiskConfig {
  readonly driver: 's3'
  /** Required (`AWS_BUCKET`). Empty → the disk is unconfigured. */
  readonly bucket?: string
  /** `AWS_DEFAULT_REGION`. R2 uses `auto`. Default `us-east-1`. */
  readonly region?: string
  /** `AWS_ACCESS_KEY_ID`. Omit both key and secret to use the AWS default chain (IAM roles). */
  readonly key?: string
  /** `AWS_SECRET_ACCESS_KEY`. */
  readonly secret?: string
  /** `AWS_SESSION_TOKEN`, for temporary credentials. */
  readonly token?: string
  /** `AWS_ENDPOINT`: the custom endpoint of an S3-compatible store. Omit for AWS. */
  readonly endpoint?: string
  /** `AWS_USE_PATH_STYLE_ENDPOINT`: `https://host/bucket/key` URLs (MinIO). Default: on with an endpoint. */
  readonly usePathStyleEndpoint?: boolean
  /** `AWS_URL`: base URL for public files (a CDN). */
  readonly url?: string
  /** Folder inside the bucket every key is stored under. */
  readonly root?: string
  /** Upper bound for signed URL lifetimes, in seconds. Default 3600. */
  readonly maxExpirySeconds?: number
  readonly serverSideEncryption?: 'AES256' | 'aws:kms'
  readonly kmsKeyId?: string
  /** Send SHA-256 checksums on uploads. Default `true`. */
  readonly checksum?: boolean
  /** Make presigned uploads unable to overwrite (`If-None-Match: *`). Default `true`. */
  readonly conditionalWrites?: boolean
}

/** A disk entry for Azure Blob Storage. */
export interface AzureDiskConfig {
  readonly driver: 'azure-blob' | 'azure'
  /** Required (`AZURE_STORAGE_CONTAINER`). Empty → the disk is unconfigured. */
  readonly container?: string
  /** `AZURE_STORAGE_ACCOUNT`. */
  readonly account?: string
  /** `AZURE_STORAGE_KEY`: the account key (shared-key auth). */
  readonly key?: string
  /** `AZURE_STORAGE_CONNECTION_STRING` (Azurite, or apps that use one). */
  readonly connectionString?: string
  /** `AZURE_STORAGE_URL`: the blob endpoint. Default `https://<account>.blob.core.windows.net`. */
  readonly endpoint?: string
  /**
   * How to authenticate. Default: `connection-string` when one is set, `shared-key` when a key
   * is set, otherwise `managed-identity` (no secret at all: recommended in Azure).
   */
  readonly auth?: 'managed-identity' | 'shared-key' | 'connection-string'
  /** Base URL for public files (a CDN). */
  readonly url?: string
  readonly root?: string
  readonly maxExpirySeconds?: number
}

/** A cloud disk entry. */
export type CloudDiskConfig = S3DiskConfig | AzureDiskConfig

/** What the provider needs to build one S3 disk. */
export interface PlannedS3Disk {
  readonly name: string
  readonly driver: 's3'
  readonly bucket: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle?: boolean
  readonly credentials?: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
  readonly publicUrl?: string
  readonly root?: string
  readonly maxExpirySeconds?: number
  readonly serverSideEncryption?: 'AES256' | 'aws:kms'
  readonly kmsKeyId?: string
  readonly checksum?: boolean
  readonly conditionalWrites?: boolean
}

/** What the provider needs to build one Azure disk. */
export interface PlannedAzureDisk {
  readonly name: string
  readonly driver: 'azure-blob'
  readonly container: string
  readonly auth:
    | { readonly kind: 'managed-identity'; readonly account?: string; readonly endpoint?: string }
    | {
        readonly kind: 'shared-key'
        readonly account: string
        readonly key: string
        readonly endpoint?: string
      }
    | { readonly kind: 'connection-string'; readonly connectionString: string }
  readonly publicUrl?: string
  readonly root?: string
  readonly maxExpirySeconds?: number
  /** True when the endpoint is a loopback `http://` URL (Azurite). */
  readonly allowHttp?: boolean
}

/** A cloud disk that is named in the config but can't be used yet. */
export interface UnconfiguredDisk {
  readonly name: string
  readonly driver: 's3' | 'azure-blob'
  readonly unconfigured: true
  /** The `.env` keys to set, e.g. `['AWS_BUCKET']`. */
  readonly missing: readonly string[]
}

/** One cloud disk from the config. */
export type PlannedCloudDisk = PlannedS3Disk | PlannedAzureDisk | UnconfiguredDisk

/**
 * A setting in `config/filesystems.ts` is invalid. Thrown at boot (fail closed) with the disk and
 * the setting in the message.
 */
export class FilesConfigError extends StrutvaneError {
  constructor(message: string) {
    super('invalid_config', { status: 500, params: { detail: message } })
    this.message = `config/filesystems.ts: ${message}`
  }
}

type Entry = Readonly<Record<string, unknown>>

/** Is this a driver this package provides? */
export function isCloudDriver(driver: unknown): boolean {
  return typeof driver === 'string' && CLOUD_DRIVERS.includes(driver)
}

function text(entry: Entry, name: string, key: string): string | undefined {
  const value = entry[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string')
    throw new FilesConfigError(`disk "${name}": ${key} must be a string`)
  return value
}

function flag(entry: Entry, name: string, key: string): boolean | undefined {
  const value = entry[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean')
    throw new FilesConfigError(`disk "${name}": ${key} must be true or false`)
  return value
}

function seconds(entry: Entry, name: string, key: string): number | undefined {
  const value = entry[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 604_800)
    throw new FilesConfigError(`disk "${name}": ${key} must be a whole number of seconds (1-604800)`)
  return value
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** An endpoint must be https, or http on a loopback host (local emulators). */
function endpoint(entry: Entry, name: string, key: string): string | undefined {
  const value = text(entry, name, key)
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new FilesConfigError(`disk "${name}": ${key} must be a URL (got an invalid value)`)
  }
  if (url.protocol === 'https:') return value
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return value
  throw new FilesConfigError(
    `disk "${name}": ${key} must use https (plain http is allowed only for localhost emulators)`,
  )
}

function optional<K extends string, V>(key: K, value: V | undefined): { readonly [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V }
}

function planS3(name: string, entry: Entry): PlannedCloudDisk {
  const bucket = text(entry, name, 'bucket')
  const key = text(entry, name, 'key')
  const secret = text(entry, name, 'secret')
  const token = text(entry, name, 'token')
  if ((key === undefined) !== (secret === undefined))
    throw new FilesConfigError(
      `disk "${name}": set both key and secret (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY), or neither to use the AWS default credential chain`,
    )
  const sse = text(entry, name, 'serverSideEncryption')
  if (sse !== undefined && sse !== 'AES256' && sse !== 'aws:kms')
    throw new FilesConfigError(`disk "${name}": serverSideEncryption must be "AES256" or "aws:kms"`)
  const url = endpoint(entry, name, 'url')
  const custom = endpoint(entry, name, 'endpoint')
  const root = text(entry, name, 'root')
  const pathStyle = flag(entry, name, 'usePathStyleEndpoint')
  const checksum = flag(entry, name, 'checksum')
  const conditionalWrites = flag(entry, name, 'conditionalWrites')
  const maxExpirySeconds = seconds(entry, name, 'maxExpirySeconds')
  const kmsKeyId = text(entry, name, 'kmsKeyId')
  const region = text(entry, name, 'region') ?? 'us-east-1'
  if (bucket === undefined) return { name, driver: 's3', unconfigured: true, missing: ['AWS_BUCKET'] }
  return {
    name,
    driver: 's3',
    bucket,
    region,
    ...optional('endpoint', custom),
    ...optional('forcePathStyle', pathStyle),
    ...(key !== undefined && secret !== undefined
      ? {
          credentials: {
            accessKeyId: key,
            secretAccessKey: secret,
            ...optional('sessionToken', token),
          },
        }
      : {}),
    ...optional('publicUrl', url),
    ...optional('root', root),
    ...optional('maxExpirySeconds', maxExpirySeconds),
    ...optional('serverSideEncryption', sse as 'AES256' | 'aws:kms' | undefined),
    ...optional('kmsKeyId', kmsKeyId),
    ...optional('checksum', checksum),
    ...optional('conditionalWrites', conditionalWrites),
  }
}

function planAzure(name: string, entry: Entry): PlannedCloudDisk {
  const container = text(entry, name, 'container')
  const account = text(entry, name, 'account')
  const key = text(entry, name, 'key')
  const connectionString = text(entry, name, 'connectionString')
  const custom = endpoint(entry, name, 'endpoint')
  const url = endpoint(entry, name, 'url')
  const root = text(entry, name, 'root')
  const maxExpirySeconds = seconds(entry, name, 'maxExpirySeconds')
  const requested = text(entry, name, 'auth')
  if (
    requested !== undefined &&
    requested !== 'managed-identity' &&
    requested !== 'shared-key' &&
    requested !== 'connection-string'
  )
    throw new FilesConfigError(
      `disk "${name}": auth must be "managed-identity", "shared-key" or "connection-string"`,
    )
  const kind =
    requested ??
    (connectionString !== undefined
      ? 'connection-string'
      : key !== undefined
        ? 'shared-key'
        : 'managed-identity')
  const missing: string[] = []
  if (container === undefined) missing.push('AZURE_STORAGE_CONTAINER')
  if (kind === 'connection-string' && connectionString === undefined)
    missing.push('AZURE_STORAGE_CONNECTION_STRING')
  if (kind === 'shared-key') {
    if (account === undefined) missing.push('AZURE_STORAGE_ACCOUNT')
    if (key === undefined) missing.push('AZURE_STORAGE_KEY')
  }
  if (kind === 'managed-identity' && account === undefined && custom === undefined)
    missing.push('AZURE_STORAGE_ACCOUNT')
  if (missing.length > 0 || container === undefined)
    return { name, driver: 'azure-blob', unconfigured: true, missing }
  const auth: PlannedAzureDisk['auth'] =
    kind === 'connection-string'
      ? { kind, connectionString: connectionString ?? '' }
      : kind === 'shared-key'
        ? { kind, account: account ?? '', key: key ?? '', ...optional('endpoint', custom) }
        : { kind, ...optional('account', account), ...optional('endpoint', custom) }
  const local =
    (custom !== undefined && custom.startsWith('http:')) ||
    (connectionString !== undefined && /BlobEndpoint=http:\/\//i.test(connectionString))
  return {
    name,
    driver: 'azure-blob',
    container,
    auth,
    ...optional('publicUrl', url),
    ...optional('root', root),
    ...optional('maxExpirySeconds', maxExpirySeconds),
    ...(local ? { allowHttp: true } : {}),
  }
}

/**
 * Read the cloud disks out of `config/filesystems.ts`'s `disks` map, checking every setting.
 * Disks with other drivers (`local`, `memory`) are skipped: the framework builds those.
 *
 * @throws FilesConfigError for an invalid setting (see the module docs)
 * @example
 * planCloudDisks({ s3: { driver: 's3', bucket: 'uploads', region: 'eu-central-1' } })
 * // → [{ name: 's3', driver: 's3', bucket: 'uploads', region: 'eu-central-1' }]
 */
export function planCloudDisks(disks: unknown): readonly PlannedCloudDisk[] {
  if (disks === undefined || disks === null) return []
  if (typeof disks !== 'object' || Array.isArray(disks))
    throw new FilesConfigError('disks must map disk names to { driver, … }')
  const planned: PlannedCloudDisk[] = []
  for (const [name, value] of Object.entries(disks)) {
    if (typeof value !== 'object' || value === null)
      throw new FilesConfigError(`disk "${name}" must be an object with a driver`)
    const entry = value as Entry
    if (!isCloudDriver(entry['driver'])) continue
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name))
      throw new FilesConfigError(
        `disk name "${name.slice(0, 64)}" must be lowercase letters, digits, - or _`,
      )
    planned.push(entry['driver'] === 's3' ? planS3(name, entry) : planAzure(name, entry))
  }
  return planned
}

/** Whether a planned disk is unconfigured (missing `.env` values). */
export function isUnconfigured(disk: PlannedCloudDisk): disk is UnconfiguredDisk {
  return 'unconfigured' in disk
}
