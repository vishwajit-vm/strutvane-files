import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, test } from 'vitest'
import { createClamAvScanner, parseClamdReply } from '../src/clamav/scanner.ts'
import { FileInfectedError, QuotaExceededError, ScanUnavailableError } from '../src/errors.ts'
import { createQuotaGuard, GLOBAL_QUOTA_KEY, MemoryQuotaCounter } from '../src/quota.ts'
import { scanWithPolicy, type VirusScanner } from '../src/scan.ts'
import { toWebStream } from '../src/spool.ts'

describe('quotas', () => {
  test('reserve within the limit, refuse beyond it with QUOTA_EXCEEDED params', async () => {
    const counter = new MemoryQuotaCounter()
    const quota = createQuotaGuard({ counter, limitFor: (t) => (t === 'big' ? 1000 : 100) })
    const release = await quota.reserve('small', 60)
    const error = await quota.reserve('small', 50).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(QuotaExceededError)
    expect((error as QuotaExceededError).params).toEqual({
      limit: 100,
      used: 60,
      requested: 50,
      available: 40,
    })
    await quota.reserve('big', 500) // other tenants are independent
    await release()
    await release() // idempotent: never releases twice
    expect(await counter.usage('small')).toBe(0)
    await quota.reserve('small', 100) // exactly at the limit is fine
  })

  test('concurrent reservations never overshoot', async () => {
    const counter = new MemoryQuotaCounter()
    const quota = createQuotaGuard({ counter, limitFor: async () => 1000 })
    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => quota.reserve('t', 100)),
    )
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    expect(await counter.usage('t')).toBe(1000)
  })

  test('unlimited tenants are still counted; no tenancy uses the global key', async () => {
    const counter = new MemoryQuotaCounter()
    const quota = createQuotaGuard({ counter, limitFor: () => undefined })
    await quota.reserve(null, 5)
    expect(await counter.usage(GLOBAL_QUOTA_KEY)).toBe(5)
    await quota.release(null, 50)
    expect(await counter.usage(GLOBAL_QUOTA_KEY)).toBe(0) // never below zero
    await expect(quota.reserve(null, -1)).rejects.toThrow(RangeError)
  })
})

describe('scanWithPolicy', () => {
  const scanner = (
    verdict: () => Promise<{ status: 'clean' } | { status: 'infected'; signature: string }>,
  ): VirusScanner => ({
    name: 'fake',
    scan: verdict,
  })
  const open = () => toWebStream('data')

  test('no scanner → not-scanned; clean → clean; infected → FILE_INFECTED', async () => {
    expect(await scanWithPolicy(undefined, open)).toBe('not-scanned')
    expect(
      await scanWithPolicy(
        scanner(async () => ({ status: 'clean' })),
        open,
      ),
    ).toBe('clean')
    await expect(
      scanWithPolicy(
        scanner(async () => ({ status: 'infected', signature: 'Eicar' })),
        open,
      ),
    ).rejects.toBeInstanceOf(FileInfectedError)
  })

  test('scanner down: fail closed by default, or pending-scan when configured', async () => {
    const down = scanner(async () => {
      throw new Error('ECONNREFUSED')
    })
    const error = await scanWithPolicy(down, open).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ScanUnavailableError)
    expect((error as ScanUnavailableError).status).toBe(503)
    expect(await scanWithPolicy(down, open, 'pending-scan')).toBe('pending-scan')
    const already = new ScanUnavailableError()
    await expect(
      scanWithPolicy(
        scanner(async () => Promise.reject(already)),
        open,
        'fail-closed',
      ),
    ).rejects.toBe(already)
  })
})

// ---- ClamAV: an in-process server that speaks clamd's INSTREAM protocol ----

type Behaviour = 'clean' | 'infected' | 'error' | 'hang' | 'early-reply' | 'garbage'

interface FakeClamd {
  port: number
  received: () => Buffer
  close: () => Promise<void>
}

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'

async function startClamd(behaviour: Behaviour): Promise<FakeClamd> {
  let received = Buffer.alloc(0)
  const sockets = new Set<Socket>()
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0)
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      if (buffer.toString('latin1').startsWith('zPING\0')) {
        socket.end('PONG\0')
        return
      }
      if (behaviour === 'early-reply' && buffer.length > 20) {
        socket.end('INSTREAM size limit exceeded. ERROR\0')
        return
      }
      if (!buffer.toString('latin1').startsWith('zINSTREAM\0')) return
      // Parse chunks after the command.
      let offset = 10
      const parts: Buffer[] = []
      for (;;) {
        if (buffer.length < offset + 4) return
        const len = buffer.readUInt32BE(offset)
        if (len === 0) break
        if (buffer.length < offset + 4 + len) return
        parts.push(buffer.subarray(offset + 4, offset + 4 + len))
        offset += 4 + len
      }
      received = Buffer.concat(parts)
      if (behaviour === 'hang') return
      const reply =
        behaviour === 'garbage'
          ? 'what?\0'
          : behaviour === 'error'
            ? 'stream: lstat() failed: No such file. ERROR\0'
            : received.toString('latin1').includes('EICAR') || behaviour === 'infected'
              ? 'stream: Eicar-Test-Signature FOUND\0'
              : 'stream: OK\0'
      socket.end(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  return {
    port: address.port,
    received: () => received,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

describe('ClamAV scanner (INSTREAM)', () => {
  let clamd: FakeClamd | undefined
  afterEach(async () => {
    await clamd?.close()
    clamd = undefined
  })

  test('clean file: streams every byte in length-prefixed chunks', async () => {
    clamd = await startClamd('clean')
    const scanner = createClamAvScanner({ port: clamd.port, chunkSize: 7 })
    const data = new TextEncoder().encode('hello clamd, this is a clean file')
    expect(await scanner.scan(toWebStream(data))).toEqual({ status: 'clean' })
    expect(clamd.received().toString()).toBe('hello clamd, this is a clean file')
  })

  test('EICAR test file is reported as infected with its signature', async () => {
    clamd = await startClamd('clean')
    const scanner = createClamAvScanner({ port: clamd.port })
    expect(await scanner.scan(toWebStream(EICAR))).toEqual({
      status: 'infected',
      signature: 'Eicar-Test-Signature',
    })
  })

  test.each(['error', 'early-reply', 'garbage'] as const)(
    'clamd %s → SCAN_UNAVAILABLE',
    async (b) => {
      clamd = await startClamd(b)
      const scanner = createClamAvScanner({ port: clamd.port, chunkSize: 4 })
      await expect(scanner.scan(toWebStream('x'.repeat(200)))).rejects.toBeInstanceOf(
        ScanUnavailableError,
      )
    },
  )

  test('scanner down (connection refused) → SCAN_UNAVAILABLE, so uploads fail closed', async () => {
    const dead = await startClamd('clean')
    const port = dead.port
    await dead.close()
    const scanner = createClamAvScanner({ port, timeoutMs: 2000 })
    const error = await scanner.scan(toWebStream('x')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ScanUnavailableError)
    await expect(scanWithPolicy(scanner, () => toWebStream('x'))).rejects.toBeInstanceOf(
      ScanUnavailableError,
    )
    expect(await scanner.ping()).toBe(false)
  })

  test('a hanging clamd times out instead of blocking the upload forever', async () => {
    clamd = await startClamd('hang')
    const scanner = createClamAvScanner({ port: clamd.port, timeoutMs: 200 })
    await expect(scanner.scan(toWebStream('x'))).rejects.toBeInstanceOf(ScanUnavailableError)
  })

  test('an abort stops the scan', async () => {
    clamd = await startClamd('hang')
    const scanner = createClamAvScanner({ port: clamd.port })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('client gone')), 50)
    await expect(
      scanner.scan(toWebStream('x'), { signal: controller.signal }),
    ).rejects.toBeInstanceOf(ScanUnavailableError)
  })

  test('ping, socket paths and option validation', async () => {
    clamd = await startClamd('clean')
    expect(await createClamAvScanner({ port: clamd.port }).ping()).toBe(true)
    expect(() => createClamAvScanner({ chunkSize: 0 })).toThrow(RangeError)
    const viaSocket = createClamAvScanner({
      socketPath: '/definitely/not/here.sock',
      timeoutMs: 500,
    })
    await expect(viaSocket.scan(toWebStream('x'))).rejects.toBeInstanceOf(ScanUnavailableError)
  })

  test('large files are streamed with backpressure', async () => {
    clamd = await startClamd('clean')
    const scanner = createClamAvScanner({ port: clamd.port })
    const big = new Uint8Array(5 * 1024 * 1024).fill(65)
    expect(await scanner.scan(toWebStream(big))).toEqual({ status: 'clean' })
    expect(clamd.received().length).toBe(big.length)
  })

  test('reply parsing', () => {
    expect(parseClamdReply('stream: OK\0')).toEqual({ status: 'clean' })
    expect(parseClamdReply('stream: Win.Test.EICAR_HDB-1 FOUND\0\n')).toEqual({
      status: 'infected',
      signature: 'Win.Test.EICAR_HDB-1',
    })
    expect(() => parseClamdReply('')).toThrow(ScanUnavailableError)
  })
})
