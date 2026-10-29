import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [
    react(),
    {
      name: 'local-index',
      enforce: 'post',
      generateBundle(_, bundle) {
        const page = bundle['local.html'];
        if (!page) throw new Error('Local page was not generated');
        page.fileName = 'index.html';
        bundle['index.html'] = page;
        delete bundle['local.html'];
      },
    },
    {
      name: 'clean-local-output',
      buildStart() {
        const output = fileURLToPath(
          new URL('../../connector/internal/localhttp/assets', import.meta.url),
        );
        for (const name of readdirSync(output))
          if (name !== 'README.txt') rmSync(join(output, name), { recursive: true, force: true });
      },
    },
  ],
  base: '/',
  build: {
    outDir: '../../connector/internal/localhttp/assets',
    emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL('./local.html', import.meta.url)) },
  },
});
