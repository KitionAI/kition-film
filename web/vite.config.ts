import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The kit package is served from wherever a host puts it, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // One React for the page, also when KITION_LINK=1 links the kition-sdk and Tessera checkouts.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@kition/sdk'],
    // The excluded SDK's editor imports Tessera's UI library, which reaches a CommonJS shim (through
    // radix-ui): pre-bundle the library, and the shim as the SDK finds it, or the page cannot import it.
    include: ['@kition/tessera/ui', '@kition/sdk > use-sync-external-store/shim'],
  },
  worker: { format: 'es' },
  server: {
    port: 5189,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url)), fileURLToPath(new URL('../target', import.meta.url))] },
  },
  build: {
    outDir: 'dist',
    rollupOptions: { input: { index: fileURLToPath(new URL('index.html', import.meta.url)), dev: fileURLToPath(new URL('dev.html', import.meta.url)) } },
  },
})
