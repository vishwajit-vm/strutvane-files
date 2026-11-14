/**
 * MIME detection from file contents ("magic bytes"), never from the extension or the browser's
 * `Content-Type`, which are attacker-controlled (RFC-0002 §4: a renamed `.exe` posing as `.pdf`).
 *
 * Detection looks at the first {@link SNIFF_BYTES} bytes. Anything unrecognised is
 * `application/octet-stream`, which no allow-list should contain by accident. The rules for the
 * common types match `@strutvane/framework`'s detector; this one adds AVIF/HEIC, audio/video
 * containers and best-effort Office (OOXML) detection.
 *
 * @module
 */

/** How many leading bytes detection reads (enough for OOXML's first zip entries). */
export const SNIFF_BYTES = 4100

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v)

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0))

const latin1 = (b: Uint8Array, start: number, end: number): string =>
  String.fromCharCode(...b.subarray(start, Math.min(end, b.length)))

/** Detect a MIME type from the first bytes of a file. Pure, total and never throws. */
export function detectMime(head: Uint8Array): string {
  if (head.length === 0) return 'application/x-empty'
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf'
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(head, ascii('GIF87a')) || startsWith(head, ascii('GIF89a'))) return 'image/gif'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'image/webp'
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WAVE'), 8)) return 'audio/wav'
  if (startsWith(head, ascii('BM')) && head.length >= 14) return 'image/bmp'
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff'
  if (startsWith(head, ascii('ftyp'), 4)) return detectIsoMedia(head)
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return detectZip(head)
  if (startsWith(head, [0x50, 0x4b, 0x05, 0x06])) return 'application/zip'
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip'
  if (startsWith(head, ascii('Rar!\x1a\x07'))) return 'application/vnd.rar'
  if (startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed'
  if (startsWith(head, ascii('OggS'))) return 'audio/ogg'
  if (startsWith(head, ascii('fLaC'))) return 'audio/flac'
  if (startsWith(head, ascii('ID3')) || startsWith(head, [0xff, 0xfb])) return 'audio/mpeg'
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (startsWith(head, ascii('MZ'))) return 'application/x-msdownload'
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'application/x-executable'
  if (startsWith(head, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(head, [0xca, 0xfe, 0xba, 0xbe]))
    return 'application/x-mach-binary'
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/x-cfb' // legacy Office (.doc/.xls), which can carry macros
  return detectText(head)
}

/** ISO base media (`ftyp` box): AVIF, HEIC, MP4, QuickTime. */
function detectIsoMedia(head: Uint8Array): string {
  const brand = latin1(head, 8, 12)
  if (brand === 'avif' || brand === 'avis') return 'image/avif'
  if (['heic', 'heix', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic'
  if (brand === 'qt  ') return 'video/quicktime'
  return 'video/mp4'
}

/**
 * Zip, refined to Office Open XML when its first entries say so. Office files start with
 * `[Content_Types].xml` and keep their main part (`word/`, `xl/`, `ppt/`) near the start.
 * Detection is best effort: an unusual entry order falls back to `application/zip`.
 */
function detectZip(head: Uint8Array): string {
  const text = latin1(head, 30, head.length)
  if (text.startsWith('[Content_Types].xml') || text.startsWith('_rels/.rels')) {
    if (text.includes('word/'))
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (text.includes('xl/'))
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    if (text.includes('ppt/'))
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  }
  if (text.startsWith('mimetypeapplication/epub+zip')) return 'application/epub+zip'
  return 'application/zip'
}

function detectText(head: Uint8Array): string {
  if (head.includes(0)) return 'application/octet-stream'
  let text: string
  try {
    // Incomplete trailing sequences are allowed: the head may cut a character in half.
    text = new TextDecoder('utf-8', { fatal: true }).decode(trimPartialUtf8(head))
  } catch {
    return 'application/octet-stream'
  }
  const start = text.replace(/^﻿/, '').trimStart().slice(0, 512).toLowerCase()
  if (start.startsWith('<svg') || (start.startsWith('<?xml') && start.includes('<svg')))
    return 'image/svg+xml'
  if (/^<(!doctype html|html|head|body|script|iframe|meta|link|style)\b/.test(start))
    return 'text/html'
  if (start.startsWith('<?xml')) return 'application/xml'
  if (start.startsWith('<!doctype svg') || start.includes('<svg')) return 'image/svg+xml'
  return 'text/plain'
}

/** Drop an incomplete UTF-8 sequence at the end of a buffer. */
function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let end = b.length
  for (let i = b.length - 1; i >= Math.max(0, b.length - 4); i--) {
    const byte = b[i] as number
    if ((byte & 0xc0) === 0x80) continue // continuation byte
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    if (b.length - i < need) end = i
    break
  }
  return b.subarray(0, end)
}

/**
 * Whether `mime` matches an allow-list entry: an exact type (`application/pdf`), a family
 * (`image/*`) or everything (`*\/*`). Comparison is case-insensitive and ignores parameters.
 */
export function mimeMatches(mime: string, accept: readonly string[]): boolean {
  const m = baseMime(mime)
  return accept.some((entry) => {
    const a = baseMime(entry)
    if (a === '*/*') return true
    if (a.endsWith('/*')) return m.startsWith(a.slice(0, -1))
    return m === a
  })
}

/** `Text/Plain; charset=utf-8` → `text/plain`. */
export function baseMime(mime: string): string {
  return (mime.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Types that can run script when served inline from your origin (stored XSS). They are rejected
 * by default even when an allow-list such as `image/*` would match; allowing them is an explicit
 * opt-in, and they are then always served as attachments.
 */
export const ACTIVE_CONTENT: ReadonlySet<string> = new Set([
  'text/html',
  'image/svg+xml',
  'application/xml',
  'application/xhtml+xml',
  'text/xml',
])

/** Executable and macro-capable containers, rejected by `image/*`-style lists by construction. */
export const EXECUTABLE_CONTENT: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-cfb',
])

/** Raster image types the image pipeline can decode, re-encode and strip. */
export const RASTER_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/tiff',
])

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/svg+xml': 'svg',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/epub+zip': 'epub',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
}

/** The file extension for a MIME type, if well known. */
export function extensionFor(mime: string): string | undefined {
  return EXTENSIONS[baseMime(mime)]
}
