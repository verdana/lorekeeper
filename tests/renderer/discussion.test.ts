import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentPersona, ChatMessage, DiscussionMessage } from '../../src/shared/types'

/**
 * The discussion orchestrator is a pure async module over the streaming client,
 * so it can be tested by scripting the client's deltas. That matters here: the
 * module routes content and reasoning deltas to message ids, and a mistake in
 * that routing is invisible until a live discussion garbles its messages.
 */
const state = vi.hoisted(() => ({
  /** One scripted answer per call, consumed in order. */
  script: [] as { content?: string[]; reasoning?: string[]; fail?: string }[],
  calls: [] as { messages: ChatMessage[]; providerId?: string; signal?: AbortSignal }[],
}))

vi.mock('../../src/renderer/src/api', () => ({
  chatStream: async (
    messages: ChatMessage[],
    providerId: string | undefined,
    onChunk: (type: 'reasoning' | 'content', text: string) => void,
    signal?: AbortSignal,
  ) => {
    state.calls.push({ messages, providerId, signal })
    const answer = state.script.shift() ?? {}
    if (answer.fail) throw new Error(answer.fail)
    for (const delta of answer.reasoning ?? []) onChunk('reasoning', delta)
    for (const delta of answer.content ?? []) onChunk('content', delta)
    return {
      content: (answer.content ?? []).join(''),
      reasoning: (answer.reasoning ?? []).join(''),
      finishReason: 'stop',
      completed: true,
      usage: { source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null },
    }
  },
}))

const {
  estimateTokens,
  packContext,
  proposalRound,
  regenerateSpeak,
  regenerateSummary,
  mergeConclusion,
  runRound,
  selectRelevantDocs,
} = await import('../../src/renderer/src/discussion')

const persona = (id: string, name = id): AgentPersona => ({
  id,
  name,
  role: 'r',
  systemPrompt: `you are ${name}`,
  color: '#000',
})

const message = (over: Partial<DiscussionMessage> = {}): DiscussionMessage => ({
  id: 'm_1',
  personaId: 'p1',
  personaName: 'Ada',
  content: '',
  round: 1,
  ts: 1,
  ...over,
})

/** Collect the hooks a caller would pass, so tests can assert what arrived. */
function hooks() {
  const announced: string[] = []
  const content: { id: string; delta: string }[] = []
  const reasoning: { id: string; delta: string }[] = []
  return {
    announced,
    content,
    reasoning,
    hooks: {
      onMessage: (msg: DiscussionMessage) => announced.push(msg.id),
      onContent: (id: string, delta: string) => content.push({ id, delta }),
      onReasoning: (id: string, delta: string) => reasoning.push({ id, delta }),
    },
  }
}

beforeEach(() => {
  state.script = []
  state.calls = []
})

describe('runRound', () => {
  it('announces each speaker and routes content and reasoning to its id', async () => {
    state.script = [
      { content: ['She ', 'spoke.'], reasoning: ['hmm '] },
      { content: ['He answered.'] },
    ]
    const sink = hooks()
    const added = await runRound({
      topic: 'the ledger',
      personas: [persona('p1', 'Ada'), persona('p2', 'Bo')],
      round: 1,
      prior: [],
      hooks: sink.hooks,
    })

    expect(added).toHaveLength(2)
    expect(sink.announced).toEqual(added.map((m) => m.id))
    // Deltas are addressed to the message that produced them, not to the last one.
    expect(sink.content).toEqual([
      { id: added[0].id, delta: 'She ' },
      { id: added[0].id, delta: 'spoke.' },
      { id: added[1].id, delta: 'He answered.' },
    ])
    expect(sink.reasoning).toEqual([{ id: added[0].id, delta: 'hmm ' }])
    expect(added[0].content).toBe('She spoke.')
    // Reasoning never leaks into the transcript.
    expect(added[0].content).not.toContain('hmm')
    // The second speaker is prompted with the first speaker's transcript.
    expect(state.calls[1].messages[1].content).toContain('She spoke.')
  })

  it('attributes each call to its own persona and provider', async () => {
    state.script = [{ content: ['a'] }, { content: ['b'] }]
    await runRound({
      topic: 't',
      personas: [persona('p1'), persona('p2')],
      round: 2,
      prior: [],
      hooks: hooks().hooks,
    })
    expect(state.calls[0].messages[0].content).toBe('you are p1')
    expect(state.calls[1].messages[0].content).toBe('you are p2')
  })

  it('stops before the next speaker when the signal is already aborted', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    state.script = [{ content: ['unused'] }]
    const added = await runRound({
      topic: 't',
      personas: [persona('p1'), persona('p2')],
      round: 1,
      prior: [],
      hooks: { ...hooks().hooks, signal: ctrl.signal },
    })
    expect(added).toEqual([])
    expect(state.calls).toHaveLength(0)
  })
})

describe('regenerate', () => {
  it('streams into an existing message without announcing it', async () => {
    state.script = [{ content: ['A new ', 'answer.'] }]
    const sink = hooks()
    const target = message({ content: 'old text' })
    const text = await regenerateSpeak({
      topic: 't',
      persona: persona('p1', 'Ada'),
      round: 3,
      prior: [message({ id: 'm_0', content: 'earlier' })],
      target,
      hooks: sink.hooks,
    })

    expect(text).toBe('A new answer.')
    expect(target.content).toBe('A new answer.')
    expect(sink.announced).toEqual([])
    expect(sink.content.map((c) => c.id)).toEqual([target.id, target.id])
  })

  it('writes a regenerated summary into its target too', async () => {
    state.script = [{ content: ['  Summary.  '] }]
    const sink = hooks()
    const target = message({ id: 'm_mod', personaName: 'Moderator' })
    const text = await regenerateSummary({
      topic: 't',
      transcript: [message({ content: 'a point' })],
      target,
      hooks: sink.hooks,
    })
    expect(text).toBe('Summary.')
    expect(target.content).toBe('Summary.')
    expect(sink.announced).toEqual([])
  })
})

describe('mergeConclusion', () => {
  it('forwards content deltas only and returns the trimmed text', async () => {
    state.script = [{ content: ['# Doc\n', 'body'], reasoning: ['thinking'] }]
    const deltas: string[] = []
    const text = await mergeConclusion({
      title: 'Ledger',
      original: 'old',
      topic: 't',
      conclusion: 'c',
      onDelta: (delta) => deltas.push(delta),
    })
    expect(deltas).toEqual(['# Doc\n', 'body'])
    expect(text).toBe('# Doc\nbody')
    expect(text).not.toContain('thinking')
  })
})

describe('selectRelevantDocs', () => {
  const docs = [
    { id: 'a.md', title: 'A', category: '01-worldview' },
    { id: 'b.md', title: 'B', category: '11-character' },
  ]

  it('unions the ids the agents pick', async () => {
    state.script = [{ content: ['a.md'] }, { content: ['b.md, a.md'] }]
    const ids = await selectRelevantDocs({
      topic: 't',
      personas: [persona('p1'), persona('p2')],
      docs,
    })
    expect(ids.sort()).toEqual(['a.md', 'b.md'])
  })

  it('falls back to every document when the agents decline or fail', async () => {
    state.script = [{ content: ['NONE'] }]
    expect(await selectRelevantDocs({ topic: 't', personas: [persona('p1')], docs })).toEqual([
      'a.md',
      'b.md',
    ])

    state.script = [{ fail: 'provider down' }]
    expect(await selectRelevantDocs({ topic: 't', personas: [persona('p1')], docs })).toEqual([
      'a.md',
      'b.md',
    ])
  })

  it('asks nothing when there are no documents', async () => {
    expect(await selectRelevantDocs({ topic: 't', personas: [persona('p1')], docs: [] })).toEqual(
      [],
    )
    expect(state.calls).toHaveLength(0)
  })
})

describe('proposalRound', () => {
  it('splits a proposal into point and reason, tolerating separators', async () => {
    state.script = [
      { content: ['The seal — it contradicts chapter two'] },
      { content: ['Her motive - unclear'] },
      { content: ['Just a point with no reason'] },
    ]
    const proposals = await proposalRound({
      topic: 't',
      personas: [persona('p1', 'Ada'), persona('p2', 'Bo'), persona('p3', 'Cy')],
    })
    expect(proposals[0]).toMatchObject({ point: 'The seal', reason: 'it contradicts chapter two' })
    expect(proposals[1]).toMatchObject({ point: 'Her motive', reason: 'unclear' })
    expect(proposals[2]).toMatchObject({ point: 'Just a point with no reason', reason: '' })
    expect(proposals.map((p) => p.personaName)).toEqual(['Ada', 'Bo', 'Cy'])
  })
})

describe('context packing', () => {
  it('always keeps the outline and trims the lowest priority material', () => {
    const packed = packContext({
      outline: 'OUTLINE',
      settings: ['SETTING'],
      chapters: ['CHAPTER'],
      budget: 500,
    })
    expect(packed).toContain('OUTLINE')
    expect(packed).toContain('SETTING')
    expect(packed.split('\n\n---\n\n')[0]).toContain('# Plot Outline')
  })

  it('estimates CJK as denser than latin', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('汉字汉字')).toBeGreaterThan(0)
    expect(estimateTokens('汉字汉字')).toBeLessThanOrEqual(estimateTokens('abcdefgh'))
  })
})
