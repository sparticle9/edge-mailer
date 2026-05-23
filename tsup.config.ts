import { defineConfig } from 'tsup'

export default defineConfig({
  format: ['cjs', 'esm'],
  entry: {
    index: './src/index.ts',
    cloudflare: './src/cloudflare.ts',
    deno: './src/deno.ts',
  },
  dts: true,
  shims: true,
  minify: true,
  skipNodeModulesBundle: true,
  clean: true,
})
