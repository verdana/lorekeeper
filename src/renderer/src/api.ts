import type { Api, ChatMessage } from '@shared/types'

// RPC timeout for every window.api call. The server handlers are fast local
// file ops, so this cap only fires when the server is wedged (blocked event
// loop, dead connection) — without it a stuck commit/snapshot/read would leave
// batch writing parked forever. Exported so tests can drive the timer.
export const API_TIMEOUT_MS = 60_000

const isAbort = (e: unknown): boolean =>
  (e instanceof DOMException && e.name === 'AbortError') ||
  (e instanceof Error && e.name === 'AbortError')

/**
 * 前端 API 客户端：把对 window.api.<method>(...args) 的调用
 * 转成 POST /api/<method>，body 为参数数组。用 Proxy 自动转发，
 * 无需为每个方法手写包装 —— 与后端 handlers 表一一对应。
 * 每个请求带 API_TIMEOUT_MS 超时兜底：超时中止并抛出描述性错误。
 */
const api = new Proxy({} as Api, {
  get(_target, method: string) {
    return async (...args: unknown[]): Promise<unknown> => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS)
      try {
        const resp = await fetch(`/api/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
          signal: ctrl.signal,
        })
        const data = await resp.json().catch(() => ({}))
        if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
        return data.result
      } catch (e) {
        // The only abort source here is our own timer, so surface it clearly.
        if (isAbort(e)) {
          throw new Error(
            `Request to /api/${method} timed out after ${API_TIMEOUT_MS / 1000}s. ` +
              'The local server may be busy or unresponsive — retry.',
          )
        }
        throw e
      } finally {
        clearTimeout(timer)
      }
    }
  },
})

export function installApi(): void {
  window.api = api
}

// Client-side timeouts: the renderer is the final line of defense. The local
// server has its own watchdog, but if that abort never unblocks a suspended
// reader, or the upstream streams without ever finishing, only aborting the
// fetch here guarantees the caller (batch writing, AI assist, ...) settles
// instead of spinning forever.
// - CONNECT_TIMEOUT_MS caps the phase before the SSE response headers arrive.
// - IDLE_TIMEOUT_MS caps the gap between two streamed deltas once streaming
//   started; thinking models still emit reasoning deltas, so a silence this
//   long means the stream is dead, not just thinking.
const CHAT_CONNECT_TIMEOUT_MS = 60_000
const CHAT_IDLE_TIMEOUT_MS = 120_000

/** Surface an internal timeout as a descriptive error (not an AbortError). */
function chatTimeoutError(ms: number, phase: 'connect' | 'stream'): Error {
  const dur = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
  return new Error(
    `AI request timed out after ${dur} without ${
      phase === 'connect' ? 'a response' : 'stream data'
    }. The provider may be down or overloaded — check its status and retry.`,
  )
}

/**
 * 流式 chat 客户端：走 SSE 旁路端点 /api/chatStream（不在 Proxy/Api 契约内，因流无法用一次性 JSON 承载）。
 * 每收到一段增量就调 onChunk（区分 reasoning 思考 / content 正文），返回拼好的全文与全部思考。
 * 传入 signal 可中断（AbortController）。
 *
 * 完整性语义（batch writing 依赖）：
 * - `completed` 只由模型级 `{ type:'done', complete }` 事件决定；末尾传输级 `event: done`
 *   不代表模型完成（上游可能因 max_tokens 截断或连接中断而提前收尾），不参与判定。
 * - 连接关闭但从未收到模型级 done → `completed = false`。
 * - `finishReason` 透传模型级 done 的报告（'stop'/'length'/'content_filter' 等），未知时为 null。
 * 现有调用方只解构 `{ content }`，忽略新字段，保持向后兼容。
 *
 * 超时（客户端兜底，服务端 watchdog 之外的第二道防线）：connect 阶段 60s、
 * 流式读取 idle 180s（可用 `timeouts` 覆盖）。超时中止请求并抛出描述性错误；
 * 调用方传入的 signal 触发的中止仍然传播 AbortError（供 Stop 等使用）。
 */
export async function chatStream(
  messages: ChatMessage[],
  providerId: string | undefined,
  onChunk: (type: 'reasoning' | 'content', text: string) => void,
  signal?: AbortSignal,
  temperature?: number,
  topP?: number,
  disableThinking = false,
  timeouts: { connectMs?: number; idleMs?: number } = {},
): Promise<{
  content: string
  reasoning: string
  finishReason: string | null
  completed: boolean
}> {
  const connectMs = timeouts.connectMs ?? CHAT_CONNECT_TIMEOUT_MS
  const idleMs = timeouts.idleMs ?? CHAT_IDLE_TIMEOUT_MS

  const ctrl = new AbortController()
  let timedOut = false
  const abortFromSignal = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) ctrl.abort()
    else signal.addEventListener('abort', abortFromSignal)
  }

  let connectTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = (): void => {
    idleTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, idleMs)
  }
  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  try {
    connectTimer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, connectMs)
    let resp: Response
    try {
      resp = await fetch('/api/chatStream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([messages, providerId, temperature, topP, disableThinking]),
        signal: ctrl.signal,
      })
    } catch (e) {
      // Convert only our own timeout abort; a caller-initiated abort keeps its
      // AbortError so Stop etc. behave exactly as before.
      if (timedOut) throw chatTimeoutError(connectMs, 'connect')
      throw e
    } finally {
      if (connectTimer) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
    }
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}))
      throw new Error(data.error ?? `Request failed (${resp.status})`)
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    let finishReason: string | null = null
    let completed = false

    // A single SSE event (or padding before a blank line) must not grow without
    // bound — a broken/hostile provider could otherwise OOM the renderer.
    const MAX_SSE_BUFFER = 2 * 1024 * 1024

    while (true) {
      armIdle()
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (e) {
        if (timedOut) throw chatTimeoutError(idleMs, 'stream')
        throw e
      } finally {
        clearIdle()
      }
      const { done, value } = result
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_SSE_BUFFER) {
        throw new Error('The AI stream sent an oversized event and was aborted.')
      }

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const isError = event.includes('event: error')
        for (const line of event.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (!payload) continue
          // Upkeep: malformed keep-alive / partial chunks must not abort the
          // whole stream, so parse defensively and skip unparseable events.
          let json: {
            type?: 'reasoning' | 'content' | 'done'
            text?: string
            finishReason?: string
            complete?: boolean
            error?: string
          }
          try {
            json = JSON.parse(payload) as typeof json
          } catch {
            continue
          }
          if (isError) throw new Error(json.error ?? 'The AI streaming request failed.')
          if (json.type === 'done') {
            // Model-level done: the only authority for completeness.
            completed = json.complete === true
            if (json.finishReason !== undefined) finishReason = json.finishReason
            continue
          }
          if (json.text && json.type) {
            if (json.type === 'reasoning') reasoning += json.text
            else content += json.text
            onChunk(json.type, json.text)
          }
        }
      }
    }
    return { content, reasoning, finishReason, completed }
  } finally {
    if (connectTimer) clearTimeout(connectTimer)
    clearIdle()
    if (signal) signal.removeEventListener('abort', abortFromSignal)
  }
}
