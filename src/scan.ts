/**
 * The virus-scan hook (RFC-0002 §4).
 *
 * A {@link VirusScanner} answers "clean" or "infected" for a byte stream, and throws when it
 * cannot answer. What happens when it cannot answer is a policy decision:
 *
 * - `fail-closed` (default): reject the upload with `SCAN_UNAVAILABLE` (503). Nothing unscanned
 *   is ever stored.
 * - `pending-scan`: store the file but mark it `pending-scan`; it is hidden (never served) until
 *   a later scan marks it clean. Use this when availability matters more than immediacy.
 *
 * `@strutvane/files/clamav` provides a ClamAV (`clamd`) scanner.
 *
 * @module
 */
import { FileInfectedError, ScanUnavailableError } from './errors.ts'

/** A scan verdict. */
export type ScanVerdict =
  | { readonly status: 'clean' }
  | { readonly status: 'infected'; readonly signature: string }

/** A virus scanner. `scan` throws {@link ScanUnavailableError} (or anything) when it can't answer. */
export interface VirusScanner {
  /** Scanner name for logs, e.g. `"clamav"`. */
  readonly name: string
  scan(
    stream: ReadableStream<Uint8Array>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ScanVerdict>
}

/** What to do when the scanner is unavailable. */
export type ScanFailurePolicy = 'fail-closed' | 'pending-scan'

/** The scan state stored with a file. */
export type ScanStatus = 'clean' | 'pending-scan' | 'infected' | 'not-scanned'

/**
 * Scan and apply the policy. Returns `clean` or `pending-scan`; throws {@link FileInfectedError}
 * for malware and {@link ScanUnavailableError} when the scanner is down under `fail-closed`.
 * Without a scanner, returns `not-scanned`.
 */
export async function scanWithPolicy(
  scanner: VirusScanner | undefined,
  open: () => ReadableStream<Uint8Array>,
  policy: ScanFailurePolicy = 'fail-closed',
  options: { readonly signal?: AbortSignal } = {},
): Promise<Exclude<ScanStatus, 'infected'>> {
  if (!scanner) return 'not-scanned'
  let verdict: ScanVerdict
  try {
    verdict = await scanner.scan(open(), options)
  } catch (error) {
    if (policy === 'pending-scan') return 'pending-scan'
    throw error instanceof ScanUnavailableError ? error : new ScanUnavailableError({ cause: error })
  }
  if (verdict.status === 'infected') throw new FileInfectedError(verdict.signature)
  return 'clean'
}
