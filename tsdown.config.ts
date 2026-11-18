import { defineConfig } from 'tsdown'

// One entry per subpath export. The framework is a peer (one copy per app: container tokens and
// `instanceof` rely on it), and the cloud SDKs and sharp are optional peers: none of them is ever
// bundled, and only the subpath that needs an SDK imports it, so `@strutvane/files` stays light.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    provider: 'src/provider.ts',
    installer: 'src/installer.ts',
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
    neverBundle: [/^@strutvane\/framework(\/.*)?$/, /^@aws-sdk\//, /^@azure\//, 'sharp'],
  },
})
