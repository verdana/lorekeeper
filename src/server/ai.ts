import type { ChatMessage, GenerateWorldInput, GeneratedWorld } from '../shared/types'
import { getConfig } from './store'
import { SETTING_CATEGORIES } from './paths'
import { PROMPTS } from '../shared/prompts'
import { buildChatRequestBody } from './chatRequest'

// Timeouts guarding against a hung upstream. Without these, a provider that
// accepts the connection but never responds (dead endpoint, silently stuck
// local model, lost network) would leave long-running calls — batch writing,
// world generation — stuck on one request forever.
// - CONNECT_TIMEOUT_MS caps the phase before the response headers arrive.
// - IDLE_TIMEOUT_MS caps the gap between two streamed deltas once streaming
//   started (thinking models emit reasoning deltas, so a true silence this
//   long means the upstream is dead, not just thinking).
const CONNECT_TIMEOUT_MS = 90_000
const IDLE_TIMEOUT_MS = 180_000

const isAbort = (e: unknown): boolean =>
  (e instanceof DOMException && e.name === 'AbortError') ||
  (e instanceof Error && e.name === 'AbortError')

/** Surface an internal timeout as a descriptive error instead of an AbortError. */
function rethrowTimeout(e: unknown, limit: number, phase: 'connect' | 'stream' | 'body'): never {
  if (!isAbort(e)) throw e
  const dur = limit >= 1000 ? `${Math.round(limit / 1000)}s` : `${limit}ms`
  const what =
    phase === 'connect' ? 'a response' : phase === 'stream' ? 'stream data' : 'the response body'
  throw new Error(
    `AI request timed out after ${dur} without ${what}. The provider may be down or overloaded — check its status and retry.`,
  )
}

/**
 * OpenAI 兼容的 chat completion 调用。
 * 兼容 OpenAI / DeepSeek / Kimi / 通义 / 本地 Ollama 等一切遵循
 * POST {baseUrl}/chat/completions 协议的提供商。
 */
export async function chat(
  messages: ChatMessage[],
  providerId?: string,
  timeouts: { connectMs?: number; bodyMs?: number } = {},
): Promise<string> {
  const cfg = getConfig()
  const pid = providerId ?? cfg.ai.activeProviderId
  const provider = cfg.ai.providers.find((p) => p.id === pid) ?? cfg.ai.providers[0]

  if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
  if (!provider.apiKey) throw new Error(`Provider "${provider.name}" has no API key set.`)

  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`

  const body = buildChatRequestBody(provider, messages)

  const connectMs = timeouts.connectMs ?? CONNECT_TIMEOUT_MS
  const ctrl = new AbortController()
  const connectTimer = setTimeout(() => ctrl.abort(), connectMs)
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    rethrowTimeout(e, connectMs, 'connect')
  } finally {
    clearTimeout(connectTimer)
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`AI request failed (${resp.status}): ${text.slice(0, 300)}`)
  }

  // The headers arrived, but the body may still hang (provider accepted the
  // request then stalled) — cap the json read just like the connect phase.
  const bodyMs = timeouts.bodyMs ?? CONNECT_TIMEOUT_MS
  const bodyTimer = setTimeout(() => ctrl.abort(), bodyMs)
  let data: { choices?: { message?: { content?: string } }[] }
  try {
    data = (await resp.json()) as typeof data
  } catch (e) {
    rethrowTimeout(e, bodyMs, 'body')
  } finally {
    clearTimeout(bodyTimer)
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('The AI returned empty content.')
  return content
}

/**
 * 流式版本：以 stream: true 请求上游，边接收边逐段 yield 增量文本。
 * 上游遵循 OpenAI SSE 协议：一行行 `data: {json}`，末尾 `data: [DONE]`。
 * 推理型模型（如 glm/deepseek-r1）会先在 delta.reasoning_content 输出思考、
 * 再在 delta.content 输出正文，故按 type 区分 yield，让前端能分别展示。
 * 调用方（server/index.ts 的 /api/chatStream 端点）把每段转发给前端。
 */
/**
 * One streamed chunk. `reasoning` / `content` carry text deltas; the final
 * model-level `done` event carries the upstream finish state and is the ONLY
 * authority for completeness (the transport-level SSE `event: done` that
 * /api/chatStream appends is explicitly not used for that purpose).
 */
export type ChatStreamChunk =
  | { type: 'reasoning' | 'content'; text: string }
  | { type: 'done'; finishReason?: string; complete: boolean }

export async function* chatStream(
  messages: ChatMessage[],
  providerId?: string,
  temperature?: number,
  topP?: number,
  disableThinking = false,
  timeouts: { connectMs?: number; idleMs?: number } = {},
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamChunk> {
  const cfg = getConfig()
  const pid = providerId ?? cfg.ai.activeProviderId
  const provider = cfg.ai.providers.find((p) => p.id === pid) ?? cfg.ai.providers[0]

  if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
  if (!provider.apiKey) throw new Error(`Provider "${provider.name}" has no API key set.`)

  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`

  const body = buildChatRequestBody(provider, messages, {
    stream: true,
    temperature,
    topP,
    disableThinking,
  })

  const connectMs = timeouts.connectMs ?? CONNECT_TIMEOUT_MS
  const idleMs = timeouts.idleMs ?? IDLE_TIMEOUT_MS
  const ctrl = new AbortController()
  // A caller-supplied signal (e.g. the /api/chatStream endpoint aborting when
  // the client disconnects) stops the upstream request too. It is NOT a
  // timeout: it must surface as an AbortError, so rethrowTimeout is bypassed.
  let externalAbort = false
  const abortFromSignal = (): void => {
    externalAbort = true
    ctrl.abort()
  }
  if (signal) {
    if (signal.aborted) abortFromSignal()
    else signal.addEventListener('abort', abortFromSignal)
  }
  const connectTimer = setTimeout(() => ctrl.abort(), connectMs)
  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
  } catch (e) {
    if (externalAbort) throw e
    rethrowTimeout(e, connectMs, 'connect')
  } finally {
    clearTimeout(connectTimer)
  }

  if (!resp.ok) {
    // The error body read is guarded too: a provider that sends status headers
    // then stalls must not hang the caller on resp.text().
    const bodyTimer = setTimeout(() => ctrl.abort(), idleMs)
    let text = ''
    try {
      text = await resp.text()
    } catch (e) {
      rethrowTimeout(e, idleMs, 'body')
    } finally {
      clearTimeout(bodyTimer)
    }
    throw new Error(`AI request failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  if (!resp.body) throw new Error('The AI returned no streaming response.')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishReason: string | undefined
  // Idle cap: abort when no delta arrives for idleMs while reading.
  let idleTimer: NodeJS.Timeout | null = null
  const armIdle = (): void => {
    idleTimer = setTimeout(() => ctrl.abort(), idleMs)
  }
  const clearIdle = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  // try/finally so an early termination (gen.return() by the caller, a [DONE]
  // return, or a thrown timeout) never leaks the idle timer or the reader.
  try {
    while (true) {
      armIdle()
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (e) {
        clearIdle()
        if (externalAbort) throw e
        rethrowTimeout(e, idleMs, 'stream')
      }
      clearIdle()
      const { done, value } = result
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE events are separated by blank lines; process complete events one by
      // one and keep any incomplete remainder in the buffer.
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        for (const line of event.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') {
            console.log(
              `[ai.chatStream] received [DONE], finish_reason=${finishReason ?? '(not reported)'}`,
            )
            yield { type: 'done', finishReason, complete: true }
            return
          }
          try {
            const json = JSON.parse(payload) as {
              choices?: {
                delta?: { content?: string; reasoning_content?: string }
                finish_reason?: string
              }[]
            }
            const choice = json.choices?.[0]
            if (choice?.finish_reason) finishReason = choice.finish_reason
            const delta = choice?.delta
            if (delta?.reasoning_content) yield { type: 'reasoning', text: delta.reasoning_content }
            if (delta?.content) yield { type: 'content', text: delta.content }
          } catch {
            // Ignore unparseable heartbeats / blank lines.
          }
        }
      }
    }
    // Stream ended naturally (no [DONE]); log the closing state for diagnosing truncated merges.
    console.log(
      `[ai.chatStream] stream ended (no [DONE]), finish_reason=${finishReason ?? '(not reported)'}`,
    )
    yield { type: 'done', finishReason, complete: false }
  } finally {
    clearIdle()
    if (signal) signal.removeEventListener('abort', abortFromSignal)
    await reader.cancel().catch(() => {
      // Cancelling a finished/already-cancelled reader is a no-op; ignore.
    })
  }
}

/**
 * 一句话 / 种子生成世界：让 AI 一次返回自洽的整套设定（GeneratedWorld）。
 * 一次调用（而非分多次）以保证各部分相互呼应；非流式，前端显示 loading。
 */
export async function generateWorld(input: GenerateWorldInput): Promise<GeneratedWorld> {
  const prompt = input.prompt?.trim()
  const seed = input.seedText?.trim()
  if (!prompt && !seed) throw new Error('Enter a one-line description, or upload seed files.')

  const system = PROMPTS.world.system
  const user = prompt ? PROMPTS.world.fromPrompt(prompt) : PROMPTS.world.fromSeed(seed as string)

  const raw = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ])

  return parseGeneratedWorld(raw)
}

/** 解析 AI 返回的 JSON，容错剥离可能的 ```json 围栏；失败给出可操作的提示 */
function parseGeneratedWorld(raw: string): GeneratedWorld {
  let text = raw.trim()
  // 剥离 markdown 代码块围栏
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1].trim()
  // 兜底：截取第一个 { 到最后一个 }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end !== -1) text = text.slice(start, end + 1)

  let obj: Partial<GeneratedWorld>
  try {
    obj = JSON.parse(text) as Partial<GeneratedWorld>
  } catch {
    throw new Error(
      'Failed to parse the generated result — it may have been truncated for length. Please retry, or switch to a more reliable model in Settings.',
    )
  }

  if (!obj.docs || !Array.isArray(obj.docs) || obj.docs.length === 0) {
    throw new Error(
      'The generated result is incomplete (no codex documents), likely truncated. Please retry or switch models.',
    )
  }

  const docs = obj.docs
    .filter((d) => d && d.title && d.content)
    .map((d) => ({
      category: (SETTING_CATEGORIES as string[]).includes(d.category as string)
        ? (d.category as GeneratedWorld['docs'][number]['category'])
        : ('99-misc' as const),
      title: String(d.title),
      content: String(d.content),
    }))

  if (docs.length === 0)
    throw new Error('The generated result is incomplete. Please retry or switch models.')

  return {
    title: obj.title?.trim() || 'Untitled World',
    genre: obj.genre?.trim() || '',
    synopsis: obj.synopsis?.trim() || '',
    docs,
  }
}
