// Type-level tests: the public API satisfies the contracts, and misuse fails to compile.
import type { FieldType, StorageDisk } from '@strutvane/contracts'
import { describe, expectTypeOf, test } from 'vitest'
import type { AzureBlobDisk } from '../src/azure/disk.ts'
import type { PresigningDisk, SpoolAwareDisk } from '../src/disk.ts'
import {
  type ByteSize,
  type FileFieldOptions,
  type FileRecord,
  type FileValue,
  fileField,
  filesField,
  imageField,
  parseSize,
} from '../src/index.ts'
import type { S3Disk } from '../src/s3/disk.ts'

describe('contracts', () => {
  test('cloud disks are StorageDisks with the optional capabilities', () => {
    expectTypeOf<S3Disk>().toExtend<StorageDisk>()
    expectTypeOf<S3Disk>().toExtend<SpoolAwareDisk & PresigningDisk>()
    expectTypeOf<AzureBlobDisk>().toExtend<StorageDisk>()
    expectTypeOf<AzureBlobDisk>().toExtend<SpoolAwareDisk & PresigningDisk>()
  })

  test('fields are FieldTypes', () => {
    expectTypeOf(fileField).toExtend<FieldType<FileValue | null, FileFieldOptions>>()
    expectTypeOf(imageField).toExtend<FieldType<FileValue | null, FileFieldOptions>>()
    expectTypeOf(filesField).toExtend<FieldType<readonly FileValue[], never>>()
  })
})

describe('misuse fails to compile', () => {
  test('sizes', () => {
    const ok: ByteSize = '10MB'
    const ok2: ByteSize = '1.5 GB'
    // @ts-expect-error "XB" is not a unit
    const bad: ByteSize = '10XB'
    void [ok, ok2, bad, parseSize]
  })

  test('field options', () => {
    fileField.validator({ accept: ['application/pdf'], maxSize: '10MB' })
    // @ts-expect-error maxSize must be a ByteSize
    fileField.validator({ maxSize: 'big' })
    // @ts-expect-error maxCount belongs to filesField
    fileField.validator({ maxCount: 3 })
    filesField.validator({ maxCount: 3 })
  })

  test('records are read-only and statuses are closed', () => {
    const r = {} as FileRecord
    // @ts-expect-error records are immutable
    r.status = 'committed'
    // @ts-expect-error "archived" is not a FileStatus
    const s: FileRecord['status'] = 'archived'
    void s
  })
})
