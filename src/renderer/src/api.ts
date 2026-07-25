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
        body: JSON.stringify(args)
      })
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data.error ?? `Request failed (${resp.status})`)
      return data.result
    }
  }
})

export function installApi(): void {
  window.api = api
}

/**
 * 流式 chat 客户端：走 SSE 旁路端点 /api/chatStream（不在 Proxy/Api 契约内，因流无法用一次性 JSON 承载）。
 * 每收到一段增量就调 onChunk（区分 reasoning 思考 / content 正文），返回拼好的全文与全部思考。
 * 传入 signal 可中断（AbortController）。
 */
export async function chatStream(
  messages: ChatMessage[],
  providerId: string | undefined,
  onChunk: (type: 'reasoning' | 'content', text: string) => void,
  signal?: AbortSignal,
  temperature?: number,
  topP?: number
): Promise<{ content: string; reasoning: string }> {
  const resp = await fetch('/api/chatStream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([messages, providerId, temperature, topP]),
    signal
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

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

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
        const json = JSON.parse(payload) as {
          type?: 'reasoning' | 'content'
          text?: string
          error?: string
        }
        if (isError) throw new Error(json.error ?? 'The AI streaming request failed.')
        if (json.text && json.type) {
          if (json.type === 'reasoning') reasoning += json.text
          else content += json.text
          onChunk(json.type, json.text)
        }
      }
    }
  }
  return { content, reasoning }
}
