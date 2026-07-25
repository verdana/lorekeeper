import type { AgentPersona, ChatMessage, DiscussionMessage } from '@shared/types'
import { chatStream } from './api'
import { uid } from './lib'

/** Rough token estimate: ~4 chars/token for Latin, ~2 for CJK, ~3.5 mixed. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    if (ch > '\u2E80' && ch <= '\u9FFF') cjk++
    else if (ch > '\uFF00' && ch <= '\uFFEF') cjk++
    else latin++
  }
  return Math.ceil(cjk / 2 + latin / 4)
}

/**
 * 按预算裁剪上下文块。优先级：Outline. > 设定文档 > 章节。
 * Outline always kept; settings kept whole; chapters trimmed from oldest.
 * Truncate tail if single item exceeds half the budget. + "…〔truncated〕"标记。
 */
export function packContext(opts: {
  outline: string
  settings: string[]
  chapters: string[]
  budget: number
}): string {
  const { outline, settings, chapters, budget } = opts
  const parts: string[] = []
  let used = 0

  // 1. Outline.（最高优先级）
  if (outline.trim()) {
    parts.push(`# Plot Outline\n\n${outline}`)
    used += estimateTokens(outline)
  }

  // 2. 设定文档（次高优先级）
  let settingsBudget = budget - used
  // 每篇设定预留 20 token 的标题和分隔符开销
  const settingOverhead = settings.length * 20
  settingsBudget -= settingOverhead

  if (settingsBudget > 0) {
    let remaining = settingsBudget
    for (const content of settings) {
      const tokens = estimateTokens(content)
      if (tokens <= remaining) {
        parts.push(content)
        remaining -= tokens
      } else if (remaining > 200) {
        // 半篇裁尾
        const ratio = remaining / tokens
        const cutLen = Math.floor(content.length * ratio)
        parts.push(content.slice(0, cutLen) + '\n\n…〔truncated for context budget〕')
        remaining = 0
        break
      }
      // 剩余预算不足 200 token 时跳过剩余篇目
    }
    used = budget - remaining
  }

  // 3. 章节（最低优先级，从旧到新裁）
  const chapterBudget = budget - used - 20 // 20 token 分隔符余量
  if (chapterBudget > 0 && chapters.length > 0) {
    let remaining = chapterBudget
    for (const content of chapters) {
      const tokens = estimateTokens(content)
      if (tokens <= remaining) {
        parts.push(content)
        remaining -= tokens
      } else if (remaining > 100) {
        const cutLen = Math.floor(content.length * (remaining / tokens))
        parts.push(content.slice(0, cutLen) + '\n\n…〔truncated for context budget〕')
        remaining = 0
        break
      }
    }
  }

  return parts.join('\n\n---\n\n')
}

/** Doc brief (id + title + category) for agent-driven relevance selection. */
export interface DocBrief {
  id: string
  title: string
  category: string
}

/**
 * Agent 自主选择与本轮话题相关的设定文档。
 * 每个选中的 Agent 并行返回一份文档 ID 列表，取并集。
 * 任一 Agent 请求失败则回退到全部文档（不阻塞讨论）。
 */
export async function selectRelevantDocs(opts: {
  topic: string
  personas: AgentPersona[]
  docs: DocBrief[]
  signal?: AbortSignal
}): Promise<string[]> {
  if (opts.docs.length === 0) return []
  const allIds = opts.docs.map((d) => d.id)

  const results = await Promise.all(
    opts.personas.map(async (persona) => {
      const prompt = [
        `You are about to discuss this topic with other personas:`,
        `"${opts.topic}"`,
        ``,
        `Below are the available codex documents for this story world.`,
        `Which ones are directly relevant to the discussion topic?`,
        `Return ONLY a comma-separated list of document IDs.`,
        `If none are relevant, return "NONE".`,
        ``,
        `Available documents:`,
        ...opts.docs.map((d) => `- ${d.id}: ${d.title} (${d.category})`)
      ].join('\n')

      try {
        const { content } = await chatStream(
          [
            { role: 'system', content: persona.systemPrompt },
            { role: 'user', content: prompt }
          ],
          persona.providerId,
          () => {}
        )
        const line = content.trim()
        if (line === 'NONE' || !line) return [] as string[]
        return line.split(',').map((s) => s.trim()).filter(Boolean) as string[]
      } catch {
        return allIds // fallback: 请求失败时包含全部文档，不阻塞讨论
      }
    })
  )

  const ids = new Set<string>()
  for (const result of results) {
    for (const id of result) ids.add(id)
  }
  return ids.size > 0 ? Array.from(ids) : allIds
}

/**
 * 讨论组编排（在浏览器里跑）。拆成可复用的积木，支持「用户插话 + 继续」的交互式讨论：
 *   runRound   —— 让选中的 Agent 各发言一轮，追加到已有记录之后（每人都能看到之前全部发言，含用户插话）。
 *   summarize  —— 由「主持人」综合全部记录得出结论。
 *   mergeConclusion —— 把结论融合进某设定文档原文，产出更新后的完整全文（供预览后写回）。
 *
 * 流式：每条发言先以空内容 onMessage 出现，再随 AI 逐 token 产出增量填充，UI 打字机式实时Render.。
 * 推理型模型的思考过程经 onReasoning 单独推送（仅供实时展示，不并入正文、不持久化）。
 * signal（AbortSignal）中断时立即停止并中断底层请求。
 */

export interface StreamHooks {
  onMessage: (msg: DiscussionMessage) => void // 新消息出现（内容可能为空，随后由 onContent 填充）
  onContent: (id: string, delta: string) => void // 某条消息追加一段正文增量
  onReasoning: (id: string, delta: string) => void // 某条消息追加一段思考增量（不入正文）
  signal?: AbortSignal
}

const transcriptText = (msgs: DiscussionMessage[]): string =>
  msgs.map((m) => `[${m.personaName}]: ${m.content}`).join('\n\n')

// 流式产出一条消息：先推占位空消息，再随 delta 累加内容。返回落定后的完整正文。
async function streamOne(
  msg: DiscussionMessage,
  chatMessages: ChatMessage[],
  providerId: string | undefined,
  hooks: StreamHooks
): Promise<string> {
  hooks.onMessage(msg)
  const { content } = await chatStream(
    chatMessages,
    providerId,
    (type, text) => {
      if (type === 'content') hooks.onContent(msg.id, text)
      else hooks.onReasoning(msg.id, text)
    },
    hooks.signal
  )
  msg.content = content.trim()
  return msg.content
}

function speakMessages(
  persona: AgentPersona,
  topic: string,
  prior: DiscussionMessage[],
  round: number,
  context?: string,
  focus?: string
): ChatMessage[] {
  const roundHint =
    round === 1 && prior.length === 0
      ? focus
        ? 'This is the first round on the focus point below. Give your take on it specifically.'
        : 'This is the first round of discussion. Give your initial take and analysis on the topic.'
      : 'Respond to the points made by others above (and any new request the user raised) — agree, build on, push back, or introduce a new angle. Move the discussion forward; do not repeat what has already been said.'

  // 收敛模式(有 focus):死扣这一点、输出适度扩容;发散模式:充分展开。
  const closing = focus
    ? `Speak as "${persona.name}". Discuss ONLY the focus point above. If a new angle or tangent occurs to you, do NOT open it here — keep this deep-dive tight. Aim for one to two focused paragraphs (target roughly 200–400 words, hard ceiling ~800). No preface, take a clear stance, back it with concrete reasoning drawn from the material, and do not repeat what has already been said.`
    : `Speak as "${persona.name}". Output your remarks directly, with no preface beyond your point, and take a clear stance. Argue your case fully, breaking it into points where helpful, and think it through thoroughly.`

  return [
    { role: 'system', content: persona.systemPrompt },
    {
      role: 'user',
      content: `You are taking part in a story workshop discussing a novel.
${context ? `\n[Reference material (this work's codex and prose — base your discussion on it)]\n${context}\n` : ''}${focus ? `\n[Focus — the single point under discussion; stay strictly on it]\n${focus}\n` : ''}
[Topic]
${topic}

${prior.length > 0 ? `[Discussion so far]\n${transcriptText(prior)}\n` : ''}
${roundHint}

${closing}`
    }
  ]
}

/**
 * 一轮讨论：选中的 Agent 依次发言，每人发言时都能看到 prior（含更早轮次与用户插话）里的全部内容。
 * 追加式：不清空 prior，返回本轮新增的消息数组。
 */
export async function runRound(opts: {
  topic: string
  personas: AgentPersona[]
  round: number
  context?: string
  focus?: string
  prior: DiscussionMessage[]
  hooks: StreamHooks
}): Promise<DiscussionMessage[]> {
  const added: DiscussionMessage[] = []
  const running = [...opts.prior] // 供拼 prompt 的滚动记录（不依赖 React 异步状态）
  for (const persona of opts.personas) {
    if (opts.hooks.signal?.aborted) break
    const msg: DiscussionMessage = {
      id: uid('m_'),
      personaId: persona.id,
      personaName: persona.name,
      content: '',
      round: opts.round,
      ts: Date.now()
    }
    running.push(msg)
    added.push(msg)
    await streamOne(
      msg,
      speakMessages(persona, opts.topic, running.slice(0, -1), opts.round, opts.context, opts.focus),
      persona.providerId,
      opts.hooks
    )
  }
  return added
}

/**
 * 重跑某个 persona 该轮发言：拼 prompt 与 runRound 一致，但结果流回给定的 target 消息 id
 * （不新增消息，UI 侧负责先清空 target.content 与 reasoning[target.id]）。
 */
export async function regenerateSpeak(opts: {
  topic: string
  persona: AgentPersona
  round: number
  context?: string
  focus?: string
  prior: DiscussionMessage[] // 该消息之前的全部消息（不含自身）
  target: DiscussionMessage
  hooks: Omit<StreamHooks, 'onMessage'>
}): Promise<string> {
  const { content } = await chatStream(
    speakMessages(opts.persona, opts.topic, opts.prior, opts.round, opts.context, opts.focus),
    opts.persona.providerId,
    (type, text) => {
      if (type === 'content') opts.hooks.onContent(opts.target.id, text)
      else opts.hooks.onReasoning(opts.target.id, text)
    },
    opts.hooks.signal
  )
  opts.target.content = content.trim()
  return opts.target.content
}

/** Converge proposal: one point a persona wants to drill into + brief reason. */
export interface Proposal {
  personaId: string
  personaName: string
  point: string // 一句话的点
  reason: string // 半句话理由
}

function proposalMessages(persona: AgentPersona, topic: string, context?: string): ChatMessage[] {
  return [
    { role: 'system', content: persona.systemPrompt },
    {
      role: 'user',
      content: `You are taking part in a focused story workshop. Before any deep discussion, each participant names the SINGLE point they think is most worth digging into.
${context ? `\n[Reference material (this work's codex and prose)]\n${context}\n` : ''}
[Topic]
${topic}

Speak as "${persona.name}". Output exactly ONE line, in this format:
POINT — REASON
where POINT is the one thing you'd most want to dig into (a short phrase), and REASON is half a sentence on why it matters. Do not list multiple points, do not add any preface, explanation, or extra lines. Just the single line.`
    }
  ]
}

/**
 * 提案轮：每个选中的 persona 各输出一行「点 — 理由」，并行请求。
 * 不走流式（每条极短），一次性返回结构化提案列表，供 UI Render.成可点选清单。
 */
export async function proposalRound(opts: {
  topic: string
  personas: AgentPersona[]
  context?: string
  signal?: AbortSignal
}): Promise<Proposal[]> {
  const results = await Promise.all(
    opts.personas.map(async (persona) => {
      const { content } = await chatStream(
        proposalMessages(persona, opts.topic, opts.context),
        persona.providerId,
        () => {}, // 极短、无需逐 token 回调
        opts.signal
      )
      const line = content.trim().split('\n').find((l) => l.trim()) ?? content.trim()
      // 用「—」或「-」或「:」分隔点与理由，取第一个分隔符
      const m = line.match(/^\s*(.+?)\s*[—\-:]\s*(.+)\s*$/)
      return {
        personaId: persona.id,
        personaName: persona.name,
        point: (m ? m[1] : line).trim(),
        reason: (m ? m[2] : '').trim()
      }
    })
  )
  return results
}

function summarizeMessages(topic: string, transcript: DiscussionMessage[], focus?: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: focus
        ? 'You are the moderator of a focused story workshop. The discussion was deliberately kept to a single point. Summarize tightly and only about that point: the consensus reached, any disagreement, and one concrete, actionable conclusion. Do not introduce new points.'
        : 'You are the moderator of this story workshop. Summarize the whole discussion objectively and in a structured way: distill the points of consensus, the disagreements, and give an actionable conclusion with recommendations.'
    },
    {
      role: 'user',
      content: `${focus ? `[Focus point]\n${focus}\n\n` : ''}[Topic]\n${topic}\n\n[Full transcript]\n${transcriptText(
        transcript
      )}\n\nOutput a structured summary containing: 1) core consensus; 2) main disagreements (if any); 3) final conclusion and actionable next steps. Use Markdown.`
    }
  ]
}

/** Moderator synthesises the full transcript into a conclusion message. */
export async function summarize(opts: {
  topic: string
  transcript: DiscussionMessage[]
  focus?: string
  providerId?: string
  hooks: StreamHooks
}): Promise<DiscussionMessage> {
  const msg: DiscussionMessage = {
    id: uid('m_'),
    personaId: 'moderator',
    personaName: 'Moderator · Summary',
    content: '',
    round: 0,
    ts: Date.now()
  }
  await streamOne(
    msg,
    summarizeMessages(opts.topic, opts.transcript, opts.focus),
    opts.providerId,
    opts.hooks
  )
  return msg
}

/**
 * Regenerate moderator summary: streams back to target message id.
 */
export async function regenerateSummary(opts: {
  topic: string
  transcript: DiscussionMessage[]
  focus?: string
  providerId?: string
  target: DiscussionMessage
  hooks: Omit<StreamHooks, 'onMessage'>
}): Promise<string> {
  const { content } = await chatStream(
    summarizeMessages(opts.topic, opts.transcript, opts.focus),
    opts.providerId,
    (type, text) => {
      if (type === 'content') opts.hooks.onContent(opts.target.id, text)
      else opts.hooks.onReasoning(opts.target.id, text)
    },
    opts.hooks.signal
  )
  opts.target.content = content.trim()
  return opts.target.content
}

function mergeMessages(
  title: string,
  original: string,
  topic: string,
  conclusion: string
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a rigorous codex editor responsible for folding workshop conclusions into a story-bible document. Make only the changes relevant to the conclusion; leave everything else exactly as it was.'
    },
    {
      role: 'user',
      content: `Below is the full current text of a codex document, and the conclusion a story workshop reached about it. Integrate the settled, actionable improvements from the conclusion into the original document, and produce the updated complete document.

Requirements:
- Preserve the original document's structure and any content not touched; only modify, add, or remove where relevant.
- Output the updated **complete Markdown document**, not a diff or a fragment — I will use it to overwrite the original file directly.
- Do not output any explanation, note, code fence (\`\`\`), or extra preface; start straight from the document body.

[Codex document: ${title}] (current full text)
${original || '(this document is currently empty)'}

[Workshop topic]
${topic}

[Workshop conclusion]
${conclusion}`
    }
  ]
}

/** Merge conclusion into the original codex doc, streaming the full updated text for preview. */
export async function mergeConclusion(opts: {
  title: string
  original: string
  topic: string
  conclusion: string
  providerId?: string
  onDelta: (delta: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const { content } = await chatStream(
    mergeMessages(opts.title, opts.original, opts.topic, opts.conclusion),
    opts.providerId,
    (type, text) => {
      if (type === 'content') opts.onDelta(text)
    },
    opts.signal
  )
  return content.trim()
}
