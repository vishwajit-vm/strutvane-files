/**
 * Pure rule checks: given what is known about a file (size, detected type, dimensions), list
 * what is wrong with it. No I/O, so the same checks run in the upload pipeline, in field
 * validators and in the direct-upload confirm step.
 *
 * @module
 */
import { type FileIssue, fileIssue } from './errors.ts'
import { ACTIVE_CONTENT, baseMime, EXECUTABLE_CONTENT, mimeMatches } from './mime.ts'
import type { ResolvedRules } from './rules.ts'
import { formatSize } from './size.ts'

/** What validation needs to know about a file. */
export interface FileFacts {
  readonly size: number
  /** The type detected from the bytes (never the browser's claim). */
  readonly detectedMime: string
  readonly width?: number
  readonly height?: number
}

type Path = readonly (string | number)[]

/** Size checks: empty, too small, too large. Returns at most one issue. */
export function checkSize(size: number, rules: ResolvedRules, path: Path): FileIssue[] {
  if (size === 0 && rules.minSize > 0) return [fileIssue('file_empty', path)]
  if (size < rules.minSize)
    return [
      fileIssue('file_too_small', path, {
        min: formatSize(rules.minSize),
        minBytes: rules.minSize,
        size,
      }),
    ]
  if (size > rules.maxSize)
    return [
      fileIssue('file_too_large', path, {
        max: formatSize(rules.maxSize),
        maxBytes: rules.maxSize,
        size,
      }),
    ]
  return []
}

/**
 * Whether a detected type is allowed. Active content (SVG/HTML/XML) and executables are refused
 * unless explicitly allowed, *even if* an entry such as `image/*` or `*\/*` would match: a
 * broad allow-list must never be a way to host scripts or malware.
 */
export function isTypeAllowed(detectedMime: string, rules: ResolvedRules): boolean {
  const mime = baseMime(detectedMime)
  if (mime === 'application/x-empty') return rules.minSize === 0
  if (ACTIVE_CONTENT.has(mime) && !rules.allowActiveContent) return false
  if (EXECUTABLE_CONTENT.has(mime) && !rules.allowExecutables) return false
  return mimeMatches(mime, rules.accept)
}

/** Type check. Returns at most one issue. */
export function checkType(detectedMime: string, rules: ResolvedRules, path: Path): FileIssue[] {
  return isTypeAllowed(detectedMime, rules)
    ? []
    : [
        fileIssue('file_type_not_allowed', path, {
          accept: rules.accept.join(', '),
          detected: baseMime(detectedMime),
        }),
      ]
}

/** Dimension checks (only when width and height are known). Returns at most one issue. */
export function checkDimensions(
  width: number | undefined,
  height: number | undefined,
  rules: ResolvedRules,
  path: Path,
): FileIssue[] {
  if (width === undefined || height === undefined) return []
  const r = rules.image
  const bad =
    width * height > r.maxPixels ||
    width < (r.minWidth ?? 1) ||
    height < (r.minHeight ?? 1) ||
    width > (r.maxWidth ?? Number.POSITIVE_INFINITY) ||
    height > (r.maxHeight ?? Number.POSITIVE_INFINITY)
  if (!bad) return []
  return [
    fileIssue('image_dimensions_invalid', path, {
      width,
      height,
      minWidth: r.minWidth ?? 1,
      minHeight: r.minHeight ?? 1,
      maxWidth: r.maxWidth ?? 'any',
      maxHeight: r.maxHeight ?? 'any',
      maxPixels: r.maxPixels,
    }),
  ]
}

/** Every check, in the order a user would want to hear about them: size, then type, then pixels. */
export function checkFile(facts: FileFacts, rules: ResolvedRules, path: Path): FileIssue[] {
  const size = checkSize(facts.size, rules, path)
  if (size.length > 0) return size
  const type = checkType(facts.detectedMime, rules, path)
  if (type.length > 0) return type
  return checkDimensions(facts.width, facts.height, rules, path)
}
