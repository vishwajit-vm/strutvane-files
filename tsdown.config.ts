import { defineConfig } from 'tsdown'

// One entry per subpath export. Cloud SDKs and sharp are optional peers: they are never bundled,
// and only the subpath that needs one imports it, so `@strutvane/files` itself stays light.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    s3: 'src/s3/index.ts',
    azure: 'src/azure/index.ts',
    images: 'src/images/index.ts',
    clamav: 'src/clamav/index.ts',
    sql: 'src/sql/index.ts',
  },
  format: 'esm',
  platform: 'node',
  target: 'node24',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@strutvane/contracts',
      '@strutvane/core',
      '@aws-sdk/client-s3',
      '@aws-sdk/s3-request-presigner',
      '@azure/storage-blob',
      '@azure/identity',
      'sharp',
    ],
  },
})
