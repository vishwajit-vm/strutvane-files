// Byte fixtures for tests: real images made with sharp, plus hand-crafted hostile files.
import { crc32, deflateSync } from 'node:zlib'
import sharp from 'sharp'

export const PDF: Uint8Array = new TextEncoder().encode(
  '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n',
)
/** A Windows executable header (MZ) — what a renamed `invoice.pdf.exe` really is. */
export const EXE: Uint8Array = new Uint8Array([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00,
])
export const SVG: Uint8Array = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>',
)
export const HTML: Uint8Array = new TextEncoder().encode(
  '<!DOCTYPE html><html><script>alert(1)</script></html>',
)

export async function png(width = 32, height = 32): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: '#3366ff' } })
      .png()
      .toBuffer(),
  )
}

/** The marker hidden in the fixture's EXIF description; it must never survive sanitising. */
export const EXIF_MARKER = 'HOME-ADDRESS-51.5N-0.12W'

/**
 * A hand-built EXIF block (little-endian TIFF): IFD0 with an ImageDescription holding
 * {@link EXIF_MARKER}, Orientation = 6 (rotate 90° clockwise) and a pointer to a GPS IFD with
 * GPSLatitudeRef/GPSLatitude. Built by hand so the test does not depend on how a library writes
 * EXIF.
 */
function exifBlock(): Uint8Array {
  const desc = new TextEncoder().encode(`${EXIF_MARKER}\0`)
  const ifd0Entries = 3
  const ifd0Size = 2 + ifd0Entries * 12 + 4
  const gpsOffset = 8 + ifd0Size
  const gpsEntries = 2
  const gpsSize = 2 + gpsEntries * 12 + 4
  const latOffset = gpsOffset + gpsSize
  const descOffset = latOffset + 24
  const buf = new Uint8Array(descOffset + desc.length)
  const v = new DataView(buf.buffer)
  buf.set([0x49, 0x49, 0x2a, 0x00]) // "II*\0"
  v.setUint32(4, 8, true)
  let o = 8
  const entry = (tag: number, type: number, count: number, value: number, short = false) => {
    v.setUint16(o, tag, true)
    v.setUint16(o + 2, type, true)
    v.setUint32(o + 4, count, true)
    if (short) v.setUint16(o + 8, value, true)
    else v.setUint32(o + 8, value, true)
    o += 12
  }
  v.setUint16(o, ifd0Entries, true)
  o += 2
  entry(0x010e, 2, desc.length, descOffset) // ImageDescription (ASCII)
  entry(0x0112, 3, 1, 6, true) // Orientation = 6
  entry(0x8825, 4, 1, gpsOffset) // GPSInfo IFD pointer
  v.setUint32(o, 0, true)
  o = gpsOffset
  v.setUint16(o, gpsEntries, true)
  o += 2
  v.setUint16(o, 0x0001, true) // GPSLatitudeRef = "N"
  v.setUint16(o + 2, 2, true)
  v.setUint32(o + 4, 2, true)
  buf[o + 8] = 0x4e
  o += 12
  entry(0x0002, 5, 3, latOffset) // GPSLatitude (3 rationals)
  v.setUint32(o, 0, true)
  for (const [i, [num, den]] of [
    [51, 1],
    [30, 1],
    [0, 1],
  ].entries()) {
    v.setUint32(latOffset + i * 8, num as number, true)
    v.setUint32(latOffset + i * 8 + 4, den as number, true)
  }
  buf.set(desc, descOffset)
  return buf
}

/** A 40×20 JPEG carrying the EXIF block above (GPS + orientation 6 + the marker). */
export async function jpegWithGps(): Promise<Uint8Array> {
  const plain = new Uint8Array(
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#ff0000' } })
      .jpeg()
      .toBuffer(),
  )
  const tiff = exifBlock()
  const payload = concat(new TextEncoder().encode('Exif\0\0'), tiff)
  const app1 = new Uint8Array(4 + payload.length)
  app1.set([0xff, 0xe1, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff])
  app1.set(payload, 4)
  // SOI, then our APP1, then the rest of the original file.
  return concat(plain.slice(0, 2), app1, plain.slice(2))
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const typeAndData = new Uint8Array(4 + data.length)
  typeAndData.set(new TextEncoder().encode(type), 0)
  typeAndData.set(data, 4)
  out.set(typeAndData, 4)
  view.setUint32(8 + data.length, crc32(typeAndData))
  return out
}

/**
 * A decompression bomb: a valid ~100-byte PNG whose header claims `width × height` pixels
 * (default 50 000 × 50 000 = 2.5 gigapixels ≈ 7.5 GB when decoded).
 */
export function pngBomb(width = 50_000, height = 50_000): Uint8Array {
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, width)
  v.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const idat = deflateSync(new Uint8Array(64)) // far too little data for the claimed size
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array()),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** A JPEG cut in half: valid header, truncated scan data. */
export async function truncatedJpeg(): Promise<Uint8Array> {
  const full = new Uint8Array(
    await sharp({ create: { width: 256, height: 256, channels: 3, background: '#00ff00' } })
      .jpeg({ quality: 95 })
      .toBuffer(),
  )
  return full.slice(0, Math.floor(full.length / 2))
}

/** Concatenate byte arrays. */
export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Does `haystack` contain the ASCII string `needle`? */
export function containsAscii(haystack: Uint8Array, needle: string): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle, 'latin1'))
}
