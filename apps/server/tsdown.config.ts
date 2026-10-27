import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: './src/index.ts',
  format: 'esm',
  outDir: './dist',
  clean: true,
  noExternal: [/@platform\/(auth|db|contracts)$/],
  external: ['@platform/pi-runtime'],
});
