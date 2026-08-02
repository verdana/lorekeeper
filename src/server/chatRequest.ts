import type { AIProvider, ChatMessage } from '../shared/types'

export interface ChatRequestOptions {
  stream?: boolean
  temperature?: number
  topP?: number
  disableThinking?: boolean
}

/** Build one OpenAI-compatible request with vendor-specific non-thinking controls. */
export function buildChatRequestBody(
  provider: AIProvider,
  messages: ChatMessage[],
  options: ChatRequestOptions = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: provider.model,
    messages,
  }
  if (options.stream != null) body.stream = options.stream
  if (provider.maxTokens != null) body.max_tokens = provider.maxTokens
  if (options.temperature != null) body.temperature = options.temperature
  if (options.topP != null) body.top_p = options.topP

  if (options.disableThinking) {
    const baseUrl = provider.baseUrl.toLowerCase()
    if (baseUrl.includes('api.deepseek.com')) {
      body.thinking = { type: 'disabled' }
    } else if (
      baseUrl.includes('dashscope.aliyuncs.com') ||
      baseUrl.includes('.maas.aliyuncs.com')
    ) {
      body.enable_thinking = false
    }
  }

  return body
}
