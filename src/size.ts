/**
 * Human-friendly byte sizes: `'10MB'`, `'512 KB'`, `'1.5GB'` or a plain number of bytes.
 *
 * Units are binary (1 KB = 1024 bytes), the way operating systems and browsers display file
 * sizes, so `maxSize: '10MB'` accepts exactly what a user's file manager calls "10 MB".
 *
 * @module
 */

/** Supported units (case-insensitive at runtime). */
export type SizeUnit = 'B' | 'KB' | 'MB' | 'GB' | 'TB'

/** A size: bytes as a number, or a string such as `'10MB'` or `'1.5 GB'`. */
export type ByteSize = number | `${number}${SizeUnit}` | `${number} ${SizeUnit}`

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
  tb: 1024 ** 4,
}

const PATTERN = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?b)\s*$/i

/**
 * Parse a size into whole bytes. Throws a `RangeError` for anything that is not a finite,
 * non-negative size, so a typo in configuration fails at boot instead of silently disabling a
 * limit.
 */
export function parseSize(size: ByteSize | string): number {
  if (typeof size === 'number') {
    if (!Number.isSafeInteger(size) || size < 0)
      throw new RangeError(`Invalid size: ${size} (expected a whole number of bytes >= 0)`)
    return size
  }
  const match = PATTERN.exec(size)
  const unit = match?.[2] ? UNITS[match[2].toLowerCase()] : undefined
  if (!match?.[1] || unit === undefined)
    throw new RangeError(`Invalid size: "${size}" (expected e.g. 512KB, 10MB, 1.5GB)`)
  const bytes = Math.floor(Number(match[1]) * unit)
  if (!Number.isSafeInteger(bytes)) throw new RangeError(`Size too large: "${size}"`)
  return bytes
}

/** Format bytes for messages: `10 MB`, `1.5 GB`, `900 B`. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return `${bytes} B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let i = 0
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024
    i++
  }
  const rounded = value >= 10 || i === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[i]}`
}
