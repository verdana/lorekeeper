// Side-effect import: load .env.local before any prompt/config module is
// evaluated (they resolve the prompt language at import time). Keep this first.
import './env'
import express from 'express'
import { join } from 'path'
import { existsSync } from 'fs'
import JSZip from 'jszip'
import { initPaths, projectRoot } from './paths'
import * as store from './store'
import { chat, chatStream, generateWorld } from './ai'
import type { Api } from '../shared/types'

const PORT = Number(process.env.PORT ?? 5178)

/** Static assets root. Read lazily so Electron sets APP_ROOT before startServer. */
const appRoot = (): string => process.env.APP_ROOT ?? process.cwd()

// Only localhost/127.0.0.1/::1 can access /api. Origin header is set by the browser
// and cannot be forged, so malicious cross-origin requests carry their own Origin and are blocked.
// Prevents a malicious page from calling the local API to steal keys while the tool is open.
// Requests without Origin (curl, packed Electron, same-origin nav) are allowed.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
function guardLocalOrigin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const origin = req.headers.origin
  if (origin) {
    let host: string | null = null
    try {
      host = new URL(origin).hostname
    } catch {
      host = null
    }
    if (!host || !LOCAL_HOSTS.has(host)) {
      res.status(403).json({ error: 'Cross-origin requests are not allowed.' })
      return
    }
  }
  next()
}

/**
 * RPC 分发表：方法名 → 实现。参数以数组形式从请求体传入，按顺序展开。
 * 这一张表就是原来的 IPC 契约（Api 接口）在 HTTP 上的等价物。
 */
const handlers: { [K in keyof Api]: (...args: Parameters<Api[K]>) => ReturnType<Api[K]> } = {
  getNovelMeta: async () => store.getNovelMeta(),
  saveNovelMeta: async (meta) => store.saveNovelMeta(meta),
  getProjectPath: async () => projectRoot(),

  listWorlds: async () => store.listWorlds(),
  getCurrentWorldId: async () => store.getCurrentWorldId(),
  switchWorld: async (id) => store.switchWorld(id),
  deleteWorld: async (id) => store.deleteWorld(id),
  createBlankWorld: async (title, genre, coverColor) =>
    store.createBlankWorld(title, genre, coverColor),
  createWorldWithData: async (meta, data) => store.createWorldWithData(meta, data),

  listSettings: async () => store.listSettings(),
  readSetting: async (id) => store.readSetting(id),
  writeSetting: async (id, content) => store.writeSetting(id, content),
  createSetting: async (category, title) => store.createSetting(category, title),
  deleteSetting: async (id) => store.deleteSetting(id),

  readChapter: async (file) => store.readChapter(file),
  writeChapter: async (file, content) => store.writeChapter(file, content),

  getConfig: async () => store.getConfig(),
  saveConfig: async (config) => store.saveConfig(config),

  chat: async (messages, providerId) => chat(messages, providerId),
  generateWorld: async (input) => generateWorld(input),

  listDiscussions: async () => store.listDiscussions(),
  saveDiscussion: async (session) => store.saveDiscussion(session),
  deleteDiscussion: async (id) => store.deleteDiscussion(id),

  listSnapshots: async () => store.listSnapshots(),
  readSnapshot: async (id) => store.readSnapshot(id),
  restoreSnapshot: async (id) => store.restoreSnapshot(id),

  readOutline: async () => store.readOutline(),
  writeOutline: async (content) => store.writeOutline(content),
}

/** Start Express server. Returns the actual port (0 = OS-assigned). */
export async function startServer(port?: number): Promise<number> {
  const p = port ?? PORT
  initPaths()
  // First launch: copy the seed directory (assets/seed/, a sample data root) into the data directory.
  // Override the seed source with ORBIT_SEED_DIR.
  const seedDir = process.env.ORBIT_SEED_DIR ?? join(appRoot(), 'assets', 'seed')
  store.bootstrap(seedDir)

  const app = express()
  app.use('/api', guardLocalOrigin)
  app.use(express.json({ limit: '16mb' }))

  /**
   * 流式 chat 端点（SSE）。这是通用 RPC（Api 契约 + Proxy）之外的旁路：
   * 通用端点一次性返回 JSON，无法承载流，故单列。body 与 chat 相同：[messages, providerId?]。
   * 逐段以 `data: {"type":"reasoning|content","text":"..."}` 推送，
   * 结束发 `event: done`，出错发 `event: error`。
   * 必须注册在通用 `/api/:method` 之前，否则会被其捕获。
   */
  app.post('/api/chatStream', async (req, res) => {
    const [messages, providerId, temperature, topP] = Array.isArray(req.body) ? req.body : []
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders()

    const aborted = { v: false }
    // 用 res 的 close 检测客户端断开：req 的 close 在请求体读完后即触发，会误判为中断。
    res.on('close', () => {
      aborted.v = true
    })

    try {
      let content = 0
      let reasoning = 0
      let chunks = 0
      for await (const chunk of chatStream(messages, providerId, temperature, topP)) {
        if (aborted.v) return
        chunks++
        if (chunk.type === 'content') content += chunk.text.length
        else reasoning += chunk.text.length
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      console.log(
        `[chatStream] providerId=${providerId ?? '(active)'} chunks=${chunks} content=${content} reasoning=${reasoning}${
          content === 0 ? '  ⚠ 上游未产出正文(content=0)' : ''
        }`,
      )
      res.write('event: done\ndata: {}\n\n')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      console.error(`[chatStream] 出错：${message}`)
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
    } finally {
      res.end()
    }
  })

  /**
   * 一键导出全书（旁路端点，GET）：把当前世界目录打包成 zip 下载。
   * 走旁路而非通用 RPC，是因为二进制 zip 无法用一次性 JSON 承载。
   * 保留 settings/ chapters/ novel.json 的原始目录结构，用户解压即得可用数据。
   */
  app.get('/api/exportWorld', async (_req, res) => {
    try {
      const { name, files } = store.collectWorldFiles()
      const zip = new JSZip()
      for (const f of files) zip.file(f.path, f.content)
      const buf = await zip.generateAsync({ type: 'nodebuffer' })
      // 文件名里的非 ASCII 走 RFC 5987 filename*，兼容中文世界名
      const encoded = encodeURIComponent(`${name}.zip`)
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="export.zip"; filename*=UTF-8''${encoded}`,
      )
      res.send(buf)
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 通用 RPC 端点：POST /api/<method>，body 为参数数组
  app.post('/api/:method', async (req, res) => {
    const method = req.params.method as keyof Api
    const handler = handlers[method]
    if (!handler) {
      res.status(404).json({ error: `未知方法：${method}` })
      return
    }
    try {
      const args = Array.isArray(req.body) ? req.body : []
      const result = await (handler as (...a: unknown[]) => Promise<unknown>)(...args)
      res.json({ result })
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) })
    }
  })

  // 生产：托管构建后的前端静态资源（dev 时前端由 vite 单独提供）
  const clientDir = join(appRoot(), 'out/renderer')
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir))
    // Express 5 的 path-to-regexp 要求具名通配符：'*' → '/*splat'
    app.get('/*splat', (_req, res) => res.sendFile(join(clientDir, 'index.html')))
  }

  return new Promise<number>((resolve, reject) => {
    const server = app.listen(p, () => {
      const addr = server.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : p
      console.log(`Lorekeeper  →  http://localhost:${actualPort}`)
      console.log(`Data directory: ${projectRoot()}`)
      resolve(actualPort)
    })
    server.on('error', reject)
  })
}

// tsx 直跑（pnpm start / pnpm dev:server）时自启动；被 import（Electron 主进程）时不自启，
// 由主进程显式调用 startServer()。Electron 环境下 process.versions.electron 存在，直接跳过。
if (!process.versions.electron) {
  startServer().catch((e) => {
    console.error('Server failed to start:', e)
    process.exit(1)
  })
}
