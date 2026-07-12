import { defineConfig } from 'tsup';

// Build the harness's public surface (src/index.ts) into a consumable ESM package with types.
// Apps depend on this via a local `file:` link during co-development; `dist/` is gitignored.
// Runtime deps (ajv, ws) stay external — they're the consumer's node_modules, not bundled here.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
