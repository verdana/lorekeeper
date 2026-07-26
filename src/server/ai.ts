import type { ChatMessage, GenerateWorldInput, GeneratedWorld } from '../shared/types'
import { getConfig } from './store'
import { PROMPTS } from '../shared/prompts'

/**
 * OpenAI 兼容的 chat completion 调用。
 * 兼容 OpenAI / DeepSeek / Kimi / 通义 / 本地 Ollama 等一切遵循
 * POST {baseUrl}/chat/completions 协议的提供商。
 */
export async function chat(messages: ChatMessage[], providerId?: string): Promise<string> {
  const cfg = getConfig()
  const pid = providerId ?? cfg.ai.activeProviderId
  const provider = cfg.ai.providers.find((p) => p.id === pid) ?? cfg.ai.providers[0]

  if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
  if (!provider.apiKey) throw new Error(`Provider "${provider.name}" has no API key set.`)

  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`

  const maxTokens = provider.maxTokens ?? 16384

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature: 0.8,
      max_tokens: maxTokens,
      stream: false,
    }),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`AI request failed (${resp.status}): ${text.slice(0, 300)}`)
  }

  const data = (await resp.json()) as {
    choices?: { message?: { content?: string } }[]
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
export async function* chatStream(
  messages: ChatMessage[],
  providerId?: string,
  temperature?: number,
  topP?: number,
): AsyncGenerator<{ type: 'reasoning' | 'content'; text: string }> {
  const cfg = getConfig()
  const pid = providerId ?? cfg.ai.activeProviderId
  const provider = cfg.ai.providers.find((p) => p.id === pid) ?? cfg.ai.providers[0]

  if (!provider) throw new Error('No AI provider configured. Add one under Settings first.')
  if (!provider.apiKey) throw new Error(`Provider "${provider.name}" has no API key set.`)

  const base = provider.baseUrl.replace(/\/$/, '')
  const url = `${base}/chat/completions`

  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
    max_tokens: provider.maxTokens ?? 16384,
    stream: true,
  }
  // 仅在显式传入时才覆盖，否则依赖上游默认值
  if (temperature != null) body.temperature = temperature
  if (topP != null) body.top_p = topP

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`AI request failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  if (!resp.body) throw new Error('The AI returned no streaming response.')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finishReason: string | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE 事件以空行分隔；逐个完整事件处理，剩余不完整的留在 buffer
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)
      for (const line of event.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') {
          console.log(`[ai.chatStream] 收到 [DONE]，finish_reason=${finishReason ?? '(未上报)'}`)
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
          // 忽略无法解析的心跳/空行
        }
      }
    }
  }
  // 流自然结束（未见 [DONE]）时也报一下收尾状态，便于诊断“合并后被截断”
  console.log(`[ai.chatStream] 流结束（无 [DONE]），finish_reason=${finishReason ?? '(未上报)'}`)
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

const VALID_CATEGORIES = ['worldview', 'character', 'geography', 'economy', 'outline', 'misc']

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
      category: VALID_CATEGORIES.includes(d.category as string)
        ? (d.category as GeneratedWorld['docs'][number]['category'])
        : ('misc' as const),
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
