import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { baseMime, detectMime, extensionFor, mimeMatches } from '../src/mime.ts'
import { EXE, HTML, jpegWithGps, PDF, png, SVG } from './helpers/fixtures.ts'

const bytes = (...parts: (number[] | string)[]): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)),
  )

const zipEntry = (name: string): Uint8Array => {
  const header = new Uint8Array(30 + name.length + 40)
  header.set([0x50, 0x4b, 0x03, 0x04])
  header.set(new TextEncoder().encode(name), 30)
  header.set(new TextEncoder().encode('word/document.xml'), 30 + name.length + 5)
  return header
}

describe('detectMime (magic bytes, never names)', () => {
  test('real files', async () => {
    expect(detectMime(PDF)).toBe('application/pdf')
    expect(detectMime(await png())).toBe('image/png')
    expect(detectMime(await jpegWithGps())).toBe('image/jpeg')
    expect(detectMime(EXE)).toBe('application/x-msdownload')
    expect(detectMime(SVG)).toBe('image/svg+xml')
    expect(detectMime(HTML)).toBe('text/html')
  })

  test.each([
    [bytes('GIF89a', [0, 0]), 'image/gif'],
    [bytes('RIFF', [0, 0, 0, 0], 'WEBP'), 'image/webp'],
    [bytes('RIFF', [0, 0, 0, 0], 'WAVE'), 'audio/wav'],
    [bytes('BM', new Array(14).fill(0)), 'image/bmp'],
    [bytes([0x49, 0x49, 0x2a, 0x00]), 'image/tiff'],
    [bytes([0, 0, 0, 0x20], 'ftypavif'), 'image/avif'],
    [bytes([0, 0, 0, 0x20], 'ftypheic'), 'image/heic'],
    [bytes([0, 0, 0, 0x20], 'ftypqt  '), 'video/quicktime'],
    [bytes([0, 0, 0, 0x20], 'ftypisom'), 'video/mp4'],
    [bytes([0x50, 0x4b, 0x05, 0x06]), 'application/zip'],
    [bytes([0x1f, 0x8b, 8]), 'application/gzip'],
    [bytes('Rar!', [0x1a, 0x07, 0]), 'application/vnd.rar'],
    [bytes([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), 'application/x-7z-compressed'],
    [bytes('OggS'), 'audio/ogg'],
    [bytes('fLaC'), 'audio/flac'],
    [bytes('ID3', [3]), 'audio/mpeg'],
    [bytes([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm'],
    [bytes([0x7f], 'ELF'), 'application/x-executable'],
    [bytes([0xcf, 0xfa, 0xed, 0xfe]), 'application/x-mach-binary'],
    [bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), 'application/x-cfb'],
    [bytes('<?xml version="1.0"?><svg/>'), 'image/svg+xml'],
    [bytes('<?xml version="1.0"?><note/>'), 'application/xml'],
    [new TextEncoder().encode('\uFEFF  <script>alert(1)</script>'), 'text/html'],
    [bytes('hello, world'), 'text/plain'],
    [bytes([0xff, 0xfe, 0x00, 0x41]), 'application/octet-stream'],
    [bytes([0xc3, 0x28, 0x41]), 'application/octet-stream'], // invalid UTF-8
    [new Uint8Array(), 'application/x-empty'],
  ])('%#: → %s', (head, expected) => {
    expect(detectMime(head)).toBe(expected)
  })

  test('Office Open XML is told apart from plain zip when its entries say so', () => {
    expect(detectMime(zipEntry('[Content_Types].xml'))).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    const xl = zipEntry('[Content_Types].xml')
    xl.set(new TextEncoder().encode('xl/workbook.xml   '), 30 + 19 + 5)
    expect(detectMime(xl)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    const ppt = zipEntry('_rels/.rels')
    ppt.set(new TextEncoder().encode('ppt/presentation '), 30 + 11 + 5)
    expect(detectMime(ppt)).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    )
    const epub = new Uint8Array(80)
    epub.set([0x50, 0x4b, 0x03, 0x04])
    epub.set(new TextEncoder().encode('mimetypeapplication/epub+zip'), 30)
    expect(detectMime(epub)).toBe('application/epub+zip')
    expect(detectMime(zipEntry('photo.jpg'))).toBe('application/zip')
  })

  test('a UTF-8 character cut in half at the end of the head is still text', () => {
    const head = new TextEncoder().encode('price: 10 €')
    expect(detectMime(head.subarray(0, head.length - 1))).toBe('text/plain')
  })

  test('fuzz: total, never throws, always returns a type/subtype', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 600 }), (head) => {
        expect(detectMime(head)).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/)
      }),
      { numRuns: 3000 },
    )
  })
})

describe('mimeMatches / helpers', () => {
  test('exact, family and wildcard entries; parameters and case ignored', () => {
    expect(mimeMatches('image/png', ['image/*'])).toBe(true)
    expect(mimeMatches('Image/PNG; charset=binary', ['image/png'])).toBe(true)
    expect(mimeMatches('application/pdf', ['image/*'])).toBe(false)
    expect(mimeMatches('anything/else', ['*/*'])).toBe(true)
    expect(mimeMatches('imagex/png', ['image/*'])).toBe(false)
  })

  test('baseMime and extensionFor', () => {
    expect(baseMime(' Text/Plain ; charset=utf-8')).toBe('text/plain')
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('application/x-unknown')).toBeUndefined()
  })
})
