import type { StandardSchemaV1FailureResult } from '@strutvane/framework/contracts'
import { createMessages, ValidationError } from '@strutvane/framework/core'
import { describe, expect, test } from 'vitest'
import {
  FileInfectedError,
  FileRejectedError,
  fileIssue,
  QuotaExceededError,
  ScanUnavailableError,
  StorageUnavailableError,
  throwFileIssues,
  UploadIncompleteError,
} from '../src/errors.ts'
import { type FileSchemaIssue, fileField, filesField, imageField, isFileId } from '../src/fields.ts'
import { FILES_MESSAGES_EN } from '../src/messages.ts'
import { ensureResolved, resolveCount, resolveRules } from '../src/rules.ts'
import { checkDimensions, checkFile, isTypeAllowed } from '../src/validate.ts'

const ID = '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000'

async function issuesOf(
  schema: { '~standard': { validate: (v: unknown) => unknown } },
  value: unknown,
): Promise<FileSchemaIssue[]> {
  const result = (await schema['~standard'].validate(
    value,
  )) as Partial<StandardSchemaV1FailureResult>
  return (result.issues ?? []) as FileSchemaIssue[]
}

describe('resolveRules', () => {
  test('defaults: 25 MB, no empty files, anything but active content/executables', () => {
    const r = resolveRules()
    expect(r.maxSize).toBe(25 * 1024 * 1024)
    expect(r.minSize).toBe(1)
    expect(r.accept).toEqual(['*/*'])
    expect(r.allowActiveContent).toBe(false)
    expect(r.allowExecutables).toBe(false)
    expect(r.image).toEqual({ maxPixels: 40_000_000, stripMetadata: true })
    expect(ensureResolved(r)).toBe(r)
    expect(ensureResolved({ maxSize: '1MB' }).maxSize).toBe(1024 * 1024)
  })

  test('impossible rules fail at boot', () => {
    expect(() => resolveRules({ minSize: '2MB', maxSize: '1MB' })).toThrow(/minSize/)
    expect(() => resolveRules({ accept: [] })).toThrow(/at least one/)
    expect(() => resolveRules({ accept: ['pdf'] })).toThrow(/not a MIME type/)
    expect(() => resolveRules({ image: { maxPixels: 0 } })).toThrow(/maxPixels/)
    expect(() => resolveRules({ image: { minWidth: 10, maxWidth: 5 } })).toThrow(/minWidth/)
    expect(() => resolveRules({ image: { minHeight: 10, maxHeight: 5 } })).toThrow(/minHeight/)
    expect(() => resolveCount({ maxCount: 0 })).toThrow(/maxCount/)
    expect(() => resolveCount({ minCount: -1 })).toThrow(/minCount/)
    expect(() => resolveCount({ minCount: 3, maxCount: 2 })).toThrow(/minCount/)
    expect(resolveCount()).toEqual({ min: 0, max: 10 })
  })
})

describe('checks', () => {
  const rules = resolveRules({ accept: ['application/pdf', 'image/*'], maxSize: '1KB' })

  test('order: size, then type, then dimensions', () => {
    expect(checkFile({ size: 0, detectedMime: 'application/x-msdownload' }, rules, ['f'])).toEqual([
      { code: 'file_empty', path: ['f'] },
    ])
    expect(checkFile({ size: 2048, detectedMime: 'application/pdf' }, rules, [])[0]).toMatchObject({
      code: 'file_too_large',
      params: { max: '1 KB', maxBytes: 1024, size: 2048 },
    })
    expect(checkFile({ size: 10, detectedMime: 'text/plain' }, rules, [])[0]).toMatchObject({
      code: 'file_type_not_allowed',
      params: { accept: 'application/pdf, image/*', detected: 'text/plain' },
    })
    expect(checkFile({ size: 10, detectedMime: 'application/pdf' }, rules, [])).toEqual([])
  })

  test('minSize', () => {
    const r = resolveRules({ minSize: 100 })
    expect(checkFile({ size: 5, detectedMime: 'text/plain' }, r, [])[0]?.code).toBe(
      'file_too_small',
    )
    expect(
      checkFile({ size: 0, detectedMime: 'application/x-empty' }, resolveRules({ minSize: 0 }), []),
    ).toEqual([])
  })

  test('SVG/HTML and executables are refused even by */* or image/*, unless opted in', () => {
    const any = resolveRules({ accept: ['*/*'] })
    for (const t of ['image/svg+xml', 'text/html', 'application/xml', 'application/x-msdownload'])
      expect(isTypeAllowed(t, any)).toBe(false)
    expect(isTypeAllowed('image/svg+xml', resolveRules({ accept: ['image/*'] }))).toBe(false)
    expect(
      isTypeAllowed(
        'image/svg+xml',
        resolveRules({ accept: ['image/*'], allowActiveContent: true }),
      ),
    ).toBe(true)
    expect(
      isTypeAllowed('application/x-msdownload', resolveRules({ allowExecutables: true })),
    ).toBe(true)
  })

  test('dimensions and the global pixel cap', () => {
    const r = resolveRules({
      image: { minWidth: 10, maxWidth: 100, maxHeight: 100, maxPixels: 5000 },
    })
    expect(checkDimensions(50, 50, r, [])).toEqual([])
    expect(checkDimensions(5, 50, r, [])[0]?.code).toBe('image_dimensions_invalid')
    expect(checkDimensions(101, 50, r, [])[0]?.code).toBe('image_dimensions_invalid')
    expect(checkDimensions(80, 80, r, [])[0]?.params).toMatchObject({ maxPixels: 5000, width: 80 })
    expect(checkDimensions(undefined, 80, r, [])).toEqual([])
    expect(checkDimensions(10, 10, resolveRules(), [])[0]).toBeUndefined()
  })
})

describe('fileField / imageField / filesField (FieldType)', () => {
  test('columns per dialect and widgets', () => {
    expect(fileField.column('postgres', {})).toEqual({ sqlType: 'uuid' })
    expect(fileField.column('mysql', {})).toEqual({ sqlType: 'char(36)' })
    expect(imageField.column('sqlite', {})).toEqual({ sqlType: 'text' })
    expect(filesField.column('postgres', {})).toEqual({ sqlType: 'jsonb' })
    expect(filesField.column('mysql', {})).toEqual({ sqlType: 'json' })
    expect([fileField.widget, imageField.widget, filesField.widget]).toEqual([
      'file',
      'image',
      'files',
    ])
    expect(fileField.filterOperators).toContain('isNull')
    expect(filesField.filterOperators).not.toContain('eq')
  })

  test('JSON Schema carries the rules for OpenAPI and the UI dropzone', () => {
    expect(
      fileField.jsonSchema({ accept: ['application/pdf'], maxSize: '10MB', required: true }),
    ).toEqual({
      type: 'string',
      format: 'uuid',
      'x-strutvane-file': { accept: ['application/pdf'], maxSize: 10 * 1024 * 1024, minSize: 1 },
    })
    expect(
      imageField.jsonSchema({
        image: { maxWidth: 4000, maxHeight: 3000, minWidth: 1, minHeight: 2 },
        variants: { thumb: [200, 200] },
      }),
    ).toMatchObject({
      nullable: true,
      'x-strutvane-file': {
        accept: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'],
        maxWidth: 4000,
        maxHeight: 3000,
        minWidth: 1,
        minHeight: 2,
        variants: ['thumb'],
      },
    })
    expect(filesField.jsonSchema({ maxCount: 5, minCount: 1 })).toMatchObject({
      type: 'array',
      uniqueItems: true,
      minItems: 1,
      maxItems: 5,
    })
  })

  test('single-file validator: ids, inspected uploads, required, wrong shapes', async () => {
    const v = fileField.validator({
      accept: ['application/pdf'],
      maxSize: '1KB',
      label: 'Invoice PDF',
    })
    expect(await issuesOf(v, ID)).toEqual([])
    expect(await issuesOf(v, null)).toEqual([])
    expect(await issuesOf(v, { size: 100, detectedMime: 'application/pdf' })).toEqual([])
    const [tooBig] = await issuesOf(v, { size: 5000, detectedMime: 'application/pdf' })
    expect(tooBig).toMatchObject({ code: 'file_too_large', path: [], params: { max: '1 KB' } })
    expect(tooBig?.message).toBe('Invoice PDF is larger than 1 KB.')
    const [spoofed] = await issuesOf(v, { size: 10, detectedMime: 'application/x-msdownload' })
    expect(spoofed?.code).toBe('file_type_not_allowed')
    expect(spoofed?.message).toContain('application/pdf')
    expect((await issuesOf(v, 'not-an-id'))[0]?.code).toBe('invalid_uuid')
    expect((await issuesOf(v, 42))[0]?.code).toBe('invalid_type')
    expect((await issuesOf(v, { size: '1', detectedMime: 'x' }))[0]?.code).toBe('invalid_type')
    const required = fileField.validator({ required: true })
    expect((await issuesOf(required, undefined))[0]).toMatchObject({
      code: 'required',
      message: 'The file is required.',
    })
  })

  test('imageField checks dimensions and defaults to raster image types', async () => {
    const v = imageField.validator({ image: { maxWidth: 100, maxHeight: 100 } })
    expect((await issuesOf(v, { size: 10, detectedMime: 'image/svg+xml' }))[0]?.code).toBe(
      'file_type_not_allowed',
    )
    const [dims] = await issuesOf(v, {
      size: 10,
      detectedMime: 'image/png',
      width: 500,
      height: 50,
    })
    expect(dims?.code).toBe('image_dimensions_invalid')
    expect(dims?.message).toBe('The file must be between 1x1 and 100x100 pixels.')
  })

  test('multi-file validator: counts, duplicates and per-file paths', async () => {
    const v = filesField.validator({
      accept: ['application/pdf'],
      maxCount: 2,
      label: 'Attachments',
    })
    expect(await issuesOf(v, [])).toEqual([])
    expect(await issuesOf(v, undefined)).toEqual([])
    expect(await issuesOf(v, [ID])).toEqual([])
    const [tooMany] = await issuesOf(v, [ID, ID, ID])
    expect(tooMany).toMatchObject({ code: 'too_many_files', params: { max: 2, count: 3 } })
    expect(tooMany?.message).toBe('You can upload at most 2 files for Attachments.')
    expect((await issuesOf(v, [ID, ID]))[0]?.code).toBe('invalid')
    const perFile = await issuesOf(v, [ID, { size: 5, detectedMime: 'text/plain' }])
    expect(perFile).toHaveLength(1)
    expect(perFile[0]).toMatchObject({ code: 'file_type_not_allowed', path: [1] })
    expect((await issuesOf(v, 'x'))[0]?.code).toBe('invalid_type')
    const min = filesField.validator({ minCount: 2 })
    expect((await issuesOf(min, []))[0]?.code).toBe('required')
    expect((await issuesOf(min, [ID]))[0]).toMatchObject({ code: 'too_short', params: { min: 2 } })
    expect((await issuesOf(filesField.validator({ required: true }), null))[0]?.code).toBe(
      'required',
    )
  })

  test('isFileId', () => {
    expect(isFileId(ID)).toBe(true)
    expect(isFileId('ABC')).toBe(false)
    expect(isFileId(1)).toBe(false)
  })
})

describe('errors and messages', () => {
  test('operation errors carry RFC-0002 codes, statuses and Retry-After', () => {
    const storage = new StorageUnavailableError('s3', { retryAfterSeconds: 7.2 })
    expect([storage.code, storage.status, storage.headers['Retry-After']]).toEqual([
      'storage_unavailable',
      503,
      '8',
    ])
    const scan = new ScanUnavailableError({ cause: new Error('down') })
    expect([scan.code, scan.status, scan.headers['Retry-After']]).toEqual([
      'scan_unavailable',
      503,
      '30',
    ])
    const infected = new FileInfectedError('Eicar-Signature')
    expect([infected.code, infected.status, infected.signature]).toEqual([
      'file_infected',
      422,
      'Eicar-Signature',
    ])
    expect(infected.params).toEqual({}) // the signature is not sent to the client
    const quota = new QuotaExceededError({ limit: 100, used: 90, requested: 20 })
    expect(quota.params).toEqual({
      limit: 100,
      used: 90,
      requested: 20,
      available: 10,
      scope: 'tenant',
    })
    expect(new UploadIncompleteError().status).toBe(400)
    expect(new FileRejectedError('file_too_large', { max: '1 KB' }).status).toBe(422)
    expect(new FileRejectedError('file_empty').params).toEqual({})
    expect(() => throwFileIssues([fileIssue('file_empty', ['a'])])).toThrow(ValidationError)
  })

  test('the package catalog renders every added key', () => {
    const messages = createMessages({ package: [FILES_MESSAGES_EN] })
    expect(messages.format('validation.file_too_small', { attribute: 'Logo', min: '1 KB' })).toBe(
      'Logo must be at least 1 KB.',
    )
    expect(
      messages.format('errors.quota_exceeded.detail', { requested: 5, available: 1, limit: 10 }),
    ).toContain('5 bytes')
    for (const key of Object.keys(FILES_MESSAGES_EN.messages)) expect(messages.has(key)).toBe(true)
  })
})
