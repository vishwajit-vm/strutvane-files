import { configDefaults, defineConfig } from 'vitest/config'

// Runs ONLY integration tests against real services in throwaway Docker containers (MinIO for
// S3, Azurite for Azure Blob, Postgres for the SQL store). Each test file starts its containers
// with `docker run --rm` and removes them afterwards. Docker is local-only (ADR-0006): nothing
// Docker-related is committed beyond these test helpers.
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    exclude: [...configDefaults.exclude],
    environment: 'node',
    passWithNoTests: false,
    allowOnly: false,
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
})
