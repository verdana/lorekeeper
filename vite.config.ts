import { resolve } from 'path'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // Load all root .env.* vars (not just VITE_-prefixed) so the renderer can
  // also see PROMPT_LANG — the alias of VITE_PROMPT_LANG — via `define` below.
  const env = loadEnv(mode, resolve('.'), '')
  return {
    root: 'src/renderer',
    // .env.local lives at the repo root, but Vite's envDir defaults to `root`
    // (src/renderer). Point it back to the project root so VITE_PROMPT_LANG is
    // actually loaded and statically inlined into the renderer bundle.
    envDir: resolve('.'),
    define: {
      // Merge PROMPT_LANG into the renderer bundle so resolveLang() sees it
      // in addition to import.meta.env.VITE_PROMPT_LANG. Defined on
      // import.meta.env (not process.env) because the browser bundle has no
      // process shim — a process.env define would be dead code.
      'import.meta.env.PROMPT_LANG': JSON.stringify(env.PROMPT_LANG ?? ''),
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
      },
    },
    server: {
      // Listen on all interfaces (including IPv4) to avoid WSL2 connectivity issues on 127.0.0.1:5173.
      host: true,
      port: 5173,
      // 开发时把 /api 请求代理到后端进程
      proxy: {
        '/api': 'http://localhost:5178',
      },
    },
    build: {
      // Output to out/renderer, matching the backend static serving path.
      outDir: resolve('out/renderer'),
      emptyOutDir: true,
      // Suppress rolldown plugin timings warning (Vite 8 build default).
      rolldownOptions: {
        checks: { pluginTimings: false },
      },
      // Raise chunk size warning limit to 1000 kB to suppress harmless alerts.
      chunkSizeWarningLimit: 1000,
    },
    plugins: [react()],
  }
})
