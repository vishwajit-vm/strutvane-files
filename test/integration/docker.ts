// Throwaway Docker containers for integration tests (ADR-0006: Docker is local-only; nothing
// Docker-related is committed besides this helper). Containers run with --rm, bind to
// 127.0.0.1 on a random port, carry a label, and are force-removed in afterAll.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Container {
  id: string
  host: string
  port: (containerPort: number) => Promise<number>
  stop: () => Promise<void>
}

export async function startContainer(
  image: string,
  ports: number[],
  args: string[] = [],
  env: Record<string, string> = {},
  volumes: Record<string, string> = {},
): Promise<Container> {
  const { stdout } = await run('docker', [
    'run',
    '-d',
    '--rm',
    '--label',
    'strutvane-files-test=1',
    ...ports.flatMap((p) => ['-p', `127.0.0.1::${p}`]),
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...Object.entries(volumes).flatMap(([host, inside]) => ['-v', `${host}:${inside}:ro`]),
    image,
    ...args,
  ])
  const id = stdout.trim()
  return {
    id,
    host: '127.0.0.1',
    async port(containerPort) {
      const out = await run('docker', ['port', id, `${containerPort}/tcp`])
      const match = /:(\d+)\s*$/m.exec(out.stdout.trim().split('\n')[0] ?? '')
      if (!match?.[1]) throw new Error(`no mapped port for ${containerPort}`)
      return Number(match[1])
    },
    async stop() {
      await run('docker', ['rm', '-f', id]).catch(() => {})
    },
  }
}

/** Poll until `check` resolves truthy (or time out). */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return
    } catch {
      // not ready yet
    }
    if (Date.now() > deadline) throw new Error('service did not become ready in time')
    await new Promise((r) => setTimeout(r, 500))
  }
}
