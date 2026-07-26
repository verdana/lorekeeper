import { build } from 'esbuild'
import { existsSync, readFileSync } from 'fs'

// 从 .env.local 里取提示词语言（PROMPT_LANG），构建期烧进主进程 bundle。
// 运行时主进程不带 .env.local，直接读 process.env 永远拿不到值，会退回英文。
function readPromptLang() {
  const fromEnv = process.env.PROMPT_LANG
  if (fromEnv) return fromEnv
  if (!existsSync('.env.local')) return 'en'
  for (const raw of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim() === 'PROMPT_LANG') {
      return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    }
  }
  return 'en'
}

const promptLang = readPromptLang()

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
  // 主进程侧的提示词语言在构建期定死；resolveLang() 会读到这个值。
  define: {
    'process.env.PROMPT_LANG': JSON.stringify(promptLang)
  },
  // express 5 / jszip 等纯 JS 依赖直接打进来，无需在产物里带 node_modules。
  logLevel: 'info'
})

console.log(`✓ electron main bundled → out/main/index.cjs (PROMPT_LANG=${promptLang})`)
