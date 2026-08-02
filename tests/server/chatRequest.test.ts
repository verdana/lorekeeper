import { describe, expect, it } from 'vitest'
import { buildChatRequestBody } from '../../src/server/chatRequest'
import type { AIProvider, ChatMessage } from '../../src/shared/types'

const messages: ChatMessage[] = [{ role: 'user', content: 'Write the scene.' }]

function provider(baseUrl: string, model: string): AIProvider {
  return {
    id: 'test',
    name: 'Test',
    baseUrl,
    apiKey: 'test-key',
    model,
    maxTokens: 8192,
  }
}

describe('buildChatRequestBody', () => {
  it('disables thinking for the official DeepSeek API', () => {
    const body = buildChatRequestBody(
      provider('https://api.deepseek.com', 'deepseek-v4-flash'),
      messages,
      { stream: true, temperature: 0.8, topP: 0.9, disableThinking: true },
    )

    expect(body).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      temperature: 0.8,
      top_p: 0.9,
      thinking: { type: 'disabled' },
    })
  })

  it('keeps thinking controls absent outside writing and rewrite requests', () => {
    const body = buildChatRequestBody(
      provider('https://api.deepseek.com', 'deepseek-v4-flash'),
      messages,
    )

    expect(body.thinking).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
  })

  it('uses the DashScope non-thinking control for Qwen-compatible requests', () => {
    const body = buildChatRequestBody(
      provider('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-max'),
      messages,
      { disableThinking: true },
    )

    expect(body.enable_thinking).toBe(false)
    expect(body.thinking).toBeUndefined()
  })

  it('does not send vendor-specific controls to unrelated providers', () => {
    const body = buildChatRequestBody(
      provider('https://api.openai.com/v1', 'gpt-5.6-luna'),
      messages,
      { disableThinking: true },
    )

    expect(body.thinking).toBeUndefined()
    expect(body.enable_thinking).toBeUndefined()
  })
})
