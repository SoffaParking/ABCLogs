import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// In development the dashboard runs on Vite's port and proxies the server's
// routes, so the same relative URLs work in dev and in the built image.
// Workspace packages are read from their TypeScript source (`source`).
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ingest': 'http://localhost:8080',
      '/healthz': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
    },
  },
});
