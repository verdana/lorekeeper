import { build } from 'esbuild'

// 把 electron/main.ts 及其 import 的服务器代码（Express、store、ai…）打成单个 CJS 文件，
// 供 Electron 主进程加载。electron 本体由运行时提供，必须 external。
await build({
  entryPoints: ['electron/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'out/main/index.cjs',
  external: ['electron'],
  // express 5 / jszip 等纯 JS 依赖直接打进来，无需在产物里带 node_modules。
  logLevel: 'info'
})

console.log('✓ electron main bundled → out/main/index.cjs')
