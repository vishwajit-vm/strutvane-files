/**
 * A ClamAV scanner speaking clamd's `INSTREAM` protocol over TCP or a Unix socket.
 *
 * Protocol (from `man clamd`): send `zINSTREAM\0`, then the file as chunks, each prefixed with
 * its length as a 4-byte big-endian integer, then a zero-length chunk. clamd answers with one
 * null-terminated line: `stream: OK`, `stream: <signature> FOUND`, or `... ERROR`.
 *
 * Everything that is not a clear `OK` or `FOUND` is a {@link ScanUnavailableError}: connection
 * refused, timeouts, protocol errors, `INSTREAM size limit exceeded` (raise clamd's
 * `StreamMaxLength` to at least your largest `maxSize`). With the default `fail-closed` policy
 * the upload is then refused, so an outage never lets an unscanned file through.
 *
 * @module
 */
import { connect, type Socket } from 'node:net'
import { ScanUnavailableError } from '../errors.ts'
import type { ScanVerdict, VirusScanner } from '../scan.ts'

/** Options for {@link createClamAvScanner}. */
export interface ClamAvOptions {
  /** Default `127.0.0.1`. Ignored when `socketPath` is set. */
  readonly host?: string
  /** Default 3310. */
  readonly port?: number
  /** Unix socket path (e.g. `/run/clamav/clamd.ctl`) instead of TCP. */
  readonly socketPath?: string
  /** Idle timeout per socket operation, in ms. Default 30 000. */
  readonly timeoutMs?: number
  /** Bytes per INSTREAM chunk. Default 64 KiB (must stay under clamd's `StreamMaxLength`). */
  readonly chunkSize?: number
}

/** A ClamAV scanner with a health check. */
export interface ClamAvScanner extends VirusScanner {
  /** Resolves `true` if clamd answers `PING` with `PONG`. Never throws. */
  ping(): Promise<boolean>
}

/** Parse clamd's answer to INSTREAM. Exported for tests. */
export function parseClamdReply(raw: string): ScanVerdict {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: clamd terminates replies with NUL.
  const reply = raw.replace(/\u0000/g, '').trim()
  if (/^stream: OK$/.test(reply)) return { status: 'clean' }
  const found = /^stream: (.+) FOUND$/.exec(reply)
  if (found?.[1]) return { status: 'infected', signature: found[1] }
  throw new ScanUnavailableError({
    cause: new Error(`unexpected clamd reply: ${reply.slice(0, 200)}`),
  })
}

/** Create a ClamAV scanner. Each scan opens its own connection (clamd handles one per thread). */
export function createClamAvScanner(options: ClamAvOptions = {}): ClamAvScanner {
  const timeoutMs = options.timeoutMs ?? 30_000
  const chunkSize = options.chunkSize ?? 64 * 1024
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 0xffffffff)
    throw new RangeError('chunkSize must be a positive 32-bit integer')

  const open = (): Socket => {
    const socket = options.socketPath
      ? connect({ path: options.socketPath })
      : connect({ host: options.host ?? '127.0.0.1', port: options.port ?? 3310 })
    socket.setTimeout(timeoutMs)
    return socket
  }

  /** Send `write(socket)` and collect the reply until clamd closes the connection. */
  const exchange = (
    write: (socket: Socket, stop: () => boolean) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      const socket = open()
      const chunks: Buffer[] = []
      let settled = false
      const fail = (cause: unknown): void => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(cause instanceof ScanUnavailableError ? cause : new ScanUnavailableError({ cause }))
      }
      const onAbort = (): void => fail(signal?.reason)
      signal?.addEventListener('abort', onAbort, { once: true })
      socket.on('timeout', () => fail(new Error(`clamd did not answer within ${timeoutMs} ms`)))
      socket.on('error', (error) => {
        // clamd closes early on errors such as "size limit exceeded"; its reply, if any, wins.
        if ((error as NodeJS.ErrnoException).code === 'EPIPE' && chunks.length > 0) return
        if ((error as NodeJS.ErrnoException).code === 'ECONNRESET' && chunks.length > 0) return
        fail(error)
      })
      socket.on('data', (chunk: Buffer) => chunks.push(chunk))
      socket.on('close', () => {
        signal?.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      socket.on('connect', () => {
        write(socket, () => settled || socket.destroyed || chunks.length > 0).then(() => {
          if (!socket.destroyed) socket.end()
        }, fail)
      })
    })

  const send = (socket: Socket, data: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      const ok = socket.write(data, (error) => (error ? reject(error) : undefined))
      if (ok) {
        resolve()
        return
      }
      // Wait for the buffer to drain, or for the socket to close (clamd hung up early).
      const done = (): void => {
        socket.off('drain', done)
        socket.off('close', done)
        resolve()
      }
      socket.once('drain', done)
      socket.once('close', done)
    })

  return {
    name: 'clamav',
    async scan(stream, opts = {}) {
      const reply = await exchange(async (socket, stop) => {
        await send(socket, Buffer.from('zINSTREAM\0'))
        const reader = stream.getReader()
        try {
          for (;;) {
            if (stop()) return
            const { done, value } = await reader.read()
            if (done) break
            for (let offset = 0; offset < value.byteLength; offset += chunkSize) {
              if (stop()) return
              const part = value.subarray(offset, offset + chunkSize)
              const header = Buffer.alloc(4)
              header.writeUInt32BE(part.byteLength)
              await send(socket, header)
              await send(socket, part)
            }
          }
          await send(socket, Buffer.alloc(4)) // zero-length chunk: end of stream
        } finally {
          await reader.cancel().catch(() => {})
        }
      }, opts.signal)
      return parseClamdReply(reply)
    },
    async ping() {
      try {
        const reply = await exchange(async (socket) => send(socket, Buffer.from('zPING\0')))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: clamd terminates replies with NUL.
        return reply.replace(/\u0000/g, '').trim() === 'PONG'
      } catch {
        return false
      }
    },
  }
}
