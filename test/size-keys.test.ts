import { NotFoundError } from '@strutvane/core'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { UnsafeKeyError } from '../src/errors.ts'
import {
  assertSafeKey,
  assertSafePrefix,
  assertSafeSegment,
  assertTenantKey,
  contentDisposition,
  generateFileKey,
  isSafeKey,
  joinKey,
  sanitizeFileName,
  tenantPrefix,
} from '../src/keys.ts'
import { formatSize, parseSize } from '../src/size.ts'

describe('parseSize / formatSize', () => {
  test('parses binary units, case-insensitively, with optional space', () => {
    expect(parseSize('10MB')).toBe(10 * 1024 * 1024)
    expect(parseSize('512 kb')).toBe(512 * 1024)
    expect(parseSize('1.5GB')).toBe(Math.floor(1.5 * 1024 ** 3))
    expect(parseSize('7B')).toBe(7)
    expect(parseSize('1TB')).toBe(1024 ** 4)
    expect(parseSize(0)).toBe(0)
    expect(parseSize(1234)).toBe(1234)
  })

  test('rejects anything that is not a size, so a typo never disables a limit', () => {
    for (const bad of ['10', '10XB', '-1MB', 'MB', '', '1e3MB', 'ten MB'])
      expect(() => parseSize(bad)).toThrow(RangeError)
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => parseSize(bad)).toThrow(RangeError)
    expect(() => parseSize('99999999999TB')).toThrow(/too large/)
  })

  test('formats for messages', () => {
    expect(formatSize(900)).toBe('900 B')
    expect(formatSize(10 * 1024 * 1024)).toBe('10 MB')
    expect(formatSize(1.5 * 1024 ** 3)).toBe('1.5 GB')
    expect(formatSize(-1)).toBe('-1 B')
  })
})

describe('storage keys (path traversal and friends)', () => {
  test('accepts normal keys', () => {
    for (const k of ['a', 'tenants/t1/invoices/0190-abc.pdf', 'x=1/y_2/z-3.txt'])
      expect(isSafeKey(k)).toBe(true)
  })

  test.each([
    '../etc/passwd',
    'a/../../b',
    '/absolute',
    'trailing/',
    'a//b',
    '.hidden',
    'a/./b',
    'back\\slash',
    'C:\\windows',
    'nul\u0000byte',
    'new\nline',
    'tab\there',
    'space here',
    'ünïcode',
    '%2e%2e/x',
    '',
    'a'.repeat(1025),
  ])('rejects %j', (key) => {
    expect(() => assertSafeKey(key)).toThrow(UnsafeKeyError)
  })

  test('property: no accepted key can escape the root or contain separators other than /', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (key) => {
        if (!isSafeKey(key)) return
        expect(key.split('/').some((s) => s === '..' || s === '.' || s === '')).toBe(false)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point.
        expect(key).not.toMatch(/[\\\u0000-\u001f]/)
        expect(key.startsWith('/')).toBe(false)
      }),
      { numRuns: 2000 },
    )
  })

  test('prefixes and segments', () => {
    expect(() => assertSafePrefix('')).not.toThrow()
    expect(() => assertSafePrefix('tenants/a/')).not.toThrow()
    expect(() => assertSafePrefix('../')).toThrow(UnsafeKeyError)
    expect(() => assertSafeSegment('a/b', 'resource')).toThrow(/unsafe resource/)
    expect(joinKey('a', '', 'b')).toBe('a/b')
    expect(() => joinKey('a', '..')).toThrow(UnsafeKeyError)
  })

  test('generated keys come from the detected type and a UUID, never the client name', () => {
    const key = generateFileKey({
      tenantId: 't1',
      resource: 'invoices',
      contentType: 'application/pdf',
      id: () => '0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
    })
    expect(key).toBe('tenants/t1/invoices/0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000.pdf')
    expect(generateFileKey({ tenantId: null, resource: 'x', id: () => 'id1' })).toBe('shared/x/id1')
    expect(
      generateFileKey({ tenantId: null, resource: 'x', contentType: 'application/x-unknown' }),
    ).toMatch(/^shared\/x\/[0-9a-f-]{36}$/)
    expect(() => generateFileKey({ tenantId: '../t2', resource: 'x' })).toThrow(UnsafeKeyError)
    expect(() => generateFileKey({ tenantId: 't1', resource: 'a/b' })).toThrow(UnsafeKeyError)
  })

  test('tenant prefixes cannot collide (a1 vs a10)', () => {
    expect(tenantPrefix('a1')).toBe('tenants/a1/')
    expect('tenants/a10/x'.startsWith(tenantPrefix('a1'))).toBe(false)
    expect(tenantPrefix(null)).toBe('shared/')
  })

  test("a client-supplied key outside the tenant's prefix is a 404, never a 403", () => {
    expect(assertTenantKey('tenants/a/f.pdf', 'a')).toBe('tenants/a/f.pdf')
    for (const [key, tenant] of [
      ['tenants/b/f.pdf', 'a'],
      ['tenants/a10/f.pdf', 'a1'],
      ['tenants/a/../b/f.pdf', 'a'],
      ['shared/f.pdf', 'a'],
      ['tenants/a/f.pdf', null],
    ] as const) {
      expect(() => assertTenantKey(key, tenant)).toThrow(NotFoundError)
    }
  })
})

describe('client file names (display only)', () => {
  test.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['.htaccess', 'htaccess'],
    ['  ..  ', 'file'],
    [undefined, 'file'],
    ['in\u0000voice\u0007.pdf', 'invoice.pdf'],
    ['evil\u202Efdp.exe', 'evilfdp.exe'], // right-to-left override removed
    ['e\u0301te\u0301.txt', 'été.txt'], // NFC-normalised
  ])('%j → %j', (input, expected) => {
    expect(sanitizeFileName(input)).toBe(expected)
  })

  test('very long Unicode names are cut by code point, never mid-surrogate', () => {
    const name = sanitizeFileName('😀'.repeat(500))
    expect([...name]).toHaveLength(200)
    expect(name.isWellFormed()).toBe(true)
  })

  test('Content-Disposition cannot be broken by quotes or newlines and keeps Unicode', () => {
    const header = contentDisposition('attachment', 'a"b\r\nSet-Cookie: x.pdf')
    expect(header).not.toMatch(/[\r\n]/)
    expect(header).toMatch(/^attachment; filename="a_bSet-Cookie: x\.pdf"; filename\*=UTF-8''/)
    expect(contentDisposition('inline', 'résumé (1).pdf')).toBe(
      `inline; filename="r_sum_ (1).pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf`,
    )
  })
})
