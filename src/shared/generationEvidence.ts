import type {
  ChatMessage,
  GenerationCost,
  GenerationProviderSnapshot,
  GenerationTokenUsage,
} from './types'

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/

/** Model-independent approximation used only when a provider reports no usage. */
export function estimateTokenCount(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk++
    else if (/\s/.test(char)) other += 0.25
    else other++
  }
  return Math.max(0, Math.ceil(cjk + other / 4))
}

export function estimateChatUsage(messages: ChatMessage[], output: string): GenerationTokenUsage {
  const inputTokens = messages.reduce(
    (total, message) => total + estimateTokenCount(message.content) + 4,
    2,
  )
  const outputTokens = estimateTokenCount(output)
  return {
    source: 'estimated',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  }
}

export function estimateGenerationCost(
  usage: GenerationTokenUsage,
  provider: GenerationProviderSnapshot,
): GenerationCost {
  const inputPrice = provider.inputPriceCnyPerMillionTokens
  const outputPrice = provider.outputPriceCnyPerMillionTokens
  if (
    usage.inputTokens == null ||
    usage.outputTokens == null ||
    inputPrice == null ||
    outputPrice == null
  ) {
    return {
      source: 'unavailable',
      currency: 'CNY',
      inputCost: null,
      outputCost: null,
      totalCost: null,
    }
  }
  const inputCost = (usage.inputTokens * inputPrice) / 1_000_000
  const outputCost = (usage.outputTokens * outputPrice) / 1_000_000
  return {
    source: 'estimated',
    currency: 'CNY',
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
  }
}

/** Tokens used by retention deliberately ignore whitespace-only formatting edits. */
export function retentionTokens(text: string): string[] {
  return (
    text.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? []
  )
}

/** Fraction of selected model tokens still present, in order, in the saved chapter. */
export function calculateRetentionRatio(selectedText: string, authorText: string): number {
  const selected = retentionTokens(selectedText)
  const author = retentionTokens(authorText)
  if (selected.length === 0) return 0
  let previous = new Uint32Array(author.length + 1)
  let current = new Uint32Array(author.length + 1)
  for (const selectedToken of selected) {
    for (let j = 1; j <= author.length; j++) {
      current[j] =
        selectedToken === author[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1])
    }
    ;[previous, current] = [current, previous]
    current.fill(0)
  }
  return previous[author.length] / selected.length
}
