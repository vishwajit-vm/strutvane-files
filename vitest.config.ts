import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Integration tests (`*.integration.test.ts`) run against real MinIO, Azurite and Postgres in
// throwaway Docker containers. They are kept out of the default gate because the Windows and
// macOS CI runners have no Docker; the gate uses in-process fakes that speak the same interfaces.
// Run them with `test:integration` (vitest.integration.config.ts). `mergeConfig` appends this
// exclude to the shared one.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      exclude: ['**/*.integration.test.ts'],
      testTimeout: 30_000,
      hookTimeout: 30_000,
    },
  }),
)
