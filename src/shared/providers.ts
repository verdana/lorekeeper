/**
 * Built-in provider presets for BYOK setup.
 *
 * The app calls providers with the OpenAI-compatible protocol:
 *   POST {baseUrl}/chat/completions
 * So each preset's baseUrl is the exact prefix that should sit before
 * `/chat/completions`. Most vendors include `/v1`; DeepSeek is the exception
 * (its canonical endpoint is https://api.deepseek.com/chat/completions).
 *
 * Only baseUrl + model are pre-filled; the API key is always left blank for
 * the user to enter (BYOK).
 *
 * Verified against each vendor's official docs (see `docsUrl`).
 */

export interface ProviderPreset {
  /** Short human label shown in the preset menu. */
  label: string
  /** Friendly provider name applied to the created provider. */
  name: string
  /** OpenAI-compatible base URL prefix. */
  baseUrl: string
  /** Recommended default model id at the time this preset was authored. */
  model: string
  /** Suggested max output tokens; undefined = model default. */
  maxTokens?: number
  /** Where to apply for / read about the API key. */
  docsUrl?: string
  /** True for fully local providers that need no real API key. */
  local?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    label: 'DeepSeek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    maxTokens: 8192,
    docsUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    label: 'OpenAI',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.6-luna',
    maxTokens: 16384,
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    label: 'Kimi (Moonshot)',
    name: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k3',
    maxTokens: 8192,
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
  },
  {
    label: 'Bailian (Qwen)',
    name: 'Bailian (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.7-max',
    maxTokens: 8192,
    docsUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
  },
  {
    label: 'Volcengine Ark (Doubao)',
    name: 'Volcengine Ark (Doubao)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-1-pro',
    maxTokens: 8192,
    docsUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
  },
  {
    label: 'Zhipu GLM',
    name: 'Zhipu GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    maxTokens: 16384,
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    label: 'SiliconFlow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V4-Pro',
    maxTokens: 8192,
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    label: 'OpenRouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-5.6-luna',
    maxTokens: 8192,
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    label: 'Ollama (Local)',
    name: 'Ollama (Local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen3.6',
    maxTokens: 4096,
    docsUrl: 'https://ollama.com/download',
    local: true,
  },
]
