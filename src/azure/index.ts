/**
 * `@strutvane/files/azure`: a `StorageDisk` for Azure Blob Storage. Requires the optional peer
 * `@azure/storage-blob` (and `@azure/identity` for managed identity).
 *
 * ```ts
 * const azure = await createAzureBlobDisk({
 *   account: env.AZURE_STORAGE_ACCOUNT,
 *   containerName: env.AZURE_STORAGE_CONTAINER,
 *   auth: 'managed-identity',
 * })
 * ```
 *
 * @module
 */
export { AzureBlobDisk, type AzureBlobDiskOptions } from './disk.ts'
export { type AzureAuth, type AzureBlobDiskConfig, createAzureBlobDisk } from './factory.ts'
