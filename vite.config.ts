import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/renderer',
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  server: {
    // Listen on all interfaces (including IPv4) to avoid WSL2 connectivity issues on 127.0.0.1:5173.
    host: true,
    port: 5173,
    // 开发时把 /api、/landing 请求代理到后端进程
    proxy: {
      '/api': 'http://localhost:5178',
      '/landing': 'http://localhost:5178'
    }
  },
  build: {
    // Output to out/renderer, matching the backend static serving path.
    outDir: resolve('out/renderer'),
    emptyOutDir: true,
    // Suppress rolldown plugin timings warning (Vite 8 build default).
    rolldownOptions: {
      checks: { pluginTimings: false }
    },
    // Raise chunk size warning limit to 1000 kB to suppress harmless alerts.
    chunkSizeWarningLimit: 1000
  },
  plugins: [react()]
})
