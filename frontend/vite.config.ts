/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    // The end-to-end tests point the proxy at their own backend.
    proxy: { '/api': process.env.API_PROXY_TARGET || 'http://localhost:8000' },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // The longest form tests take about 3 s alone and more while `make check`
    // runs the Go tests and linters next to them; 5 s (the default) is too tight.
    testTimeout: 15_000,
  },
})
