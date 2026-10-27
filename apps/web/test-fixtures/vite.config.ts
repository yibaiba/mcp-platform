import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  build: {
    outDir: '../../.data/app-fixture',
    emptyOutDir: true,
    lib: {
      entry: fileURLToPath(new URL('./appView.ts', import.meta.url)),
      name: 'AcceptanceApp',
      formats: ['iife'],
      fileName: () => 'app.js',
    },
    minify: false,
  },
});
