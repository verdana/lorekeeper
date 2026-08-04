import type { Api, ChatMessage } from '@shared/types'

/**
 * 前端 API 客户端：把对 window.api.<method>(...args) 的调用
 * 转成 POST /api/<method>，body 为参数数组。用 Proxy 自动转发，
 * 无需为每个方法手写包装 —— 与后端 handlers 表一一对应。
 */
const api = new Proxy({} as Api, {
  get(_target, method: string) {
    return async (...args: unknown[]): Promise<unknown> => {
      const resp = await fetch(`/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
      return data.result
    }
  },
})

export function installApi(): void {
  window.api = api
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
 */
export async function chatStream(
  messages: ChatMessage[],
  providerId: string | undefined,
  onChunk: (type: 'reasoning' | 'content', text: string) => void,
  signal?: AbortSignal,
  temperature?: number,
  topP?: number,
  disableThinking = false,
): Promise<{
  content: string
  reasoning: string
  finishReason: string | null
  completed: boolean
}> {
  const resp = await fetch('/api/chatStream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([messages, providerId, temperature, topP, disableThinking]),
    signal,
  })
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
    const { done, value } = await reader.read()
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
}
