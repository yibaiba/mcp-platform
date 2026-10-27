import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [tailwindcss(), tanstackRouter({ autoCodeSplitting: true }), react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 4301,
    proxy: {
      '/api': { target: 'http://localhost:4300', ws: true },
      '/mcp': 'http://localhost:4300',
      '/.well-known': 'http://localhost:4300',
    },
  },
});
