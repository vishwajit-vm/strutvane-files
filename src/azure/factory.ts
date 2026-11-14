/**
 * Building an {@link AzureBlobDisk} from plain configuration (the values the installer puts in
 * `.env`: `AZURE_STORAGE_ACCOUNT`, `AZURE_STORAGE_CONTAINER`).
 *
 * @module
 */
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob'
import { AzureBlobDisk, type AzureBlobDiskOptions } from './disk.ts'

/** How to authenticate. Prefer `managed-identity`: no secret exists to leak. */
export type AzureAuth =
  /** `DefaultAzureCredential` (managed identity in Azure, developer sign-in locally). */
  | 'managed-identity'
  /** An account key. Keep it in a secret store, never in code or `.env.example`. */
  | { readonly accountKey: string }
  /** A connection string (handy for Azurite). */
  | { readonly connectionString: string }

/** Settings for {@link createAzureBlobDisk}. */
export interface AzureBlobDiskConfig
  extends Omit<AzureBlobDiskOptions, 'container' | 'serviceClient'> {
  /** Storage account name. Not needed with a connection string. */
  readonly account?: string
  readonly containerName: string
  readonly auth: AzureAuth
  /** Custom endpoint, e.g. Azurite's `http://127.0.0.1:10000/devstoreaccount1`. */
  readonly endpoint?: string
}

/**
 * Create an Azure Blob disk. SDK retries are turned off because the disk retries with its own
 * backoff and maps exhausted retries to `STORAGE_UNAVAILABLE`.
 */
export async function createAzureBlobDisk(config: AzureBlobDiskConfig): Promise<AzureBlobDisk> {
  const pipeline = { retryOptions: { maxTries: 1 } }
  let service: BlobServiceClient
  if (config.auth === 'managed-identity') {
    if (!config.account && !config.endpoint) throw new TypeError('account or endpoint is required')
    // Loaded lazily: @azure/identity is only needed for this mode.
    const { DefaultAzureCredential } = await import('@azure/identity')
    service = new BlobServiceClient(
      config.endpoint ?? `https://${config.account}.blob.core.windows.net`,
      new DefaultAzureCredential(),
      pipeline,
    )
  } else if ('connectionString' in config.auth) {
    service = BlobServiceClient.fromConnectionString(config.auth.connectionString, pipeline)
  } else {
    if (!config.account) throw new TypeError('account is required with an account key')
    service = new BlobServiceClient(
      config.endpoint ?? `https://${config.account}.blob.core.windows.net`,
      new StorageSharedKeyCredential(config.account, config.auth.accountKey),
      pipeline,
    )
  }
  const { account: _a, containerName, auth: _auth, endpoint: _e, ...rest } = config
  return new AzureBlobDisk({
    ...rest,
    container: service.getContainerClient(containerName),
    serviceClient: service,
  })
}
