import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The kit package is served from wherever a host puts it, so every asset path is relative.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // One React for the page, also when KITION_LINK=1 links kition-sdk packages.
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    exclude: ['@kition/kit-editor', '@kition/kit-host', '@kition/kit-ui-protocol', '@kition/kit-dev-host'],
    // The excluded kit-editor's tessera-ui imports this CommonJS shim: pre-bundle it, or the page cannot import it.
    include: ['@kition/kit-editor > @kition/tessera-ui > use-sync-external-store/shim'],
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
