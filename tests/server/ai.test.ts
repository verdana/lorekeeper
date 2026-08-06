import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { chat, chatStream, type ChatStreamChunk } from '../../src/server/ai'
import type { AIProvider, ChatMessage } from '../../src/shared/types'

// The AI client reads the active provider from the store config; mock it so
// tests can point baseUrl at a local throwaway HTTP server.
const mock = vi.hoisted(() => ({ cfg: null as unknown }))

vi.mock('../../src/server/store', () => ({
  getConfig: () => mock.cfg,
}))

const messages: ChatMessage[] = [{ role: 'user', content: 'Write the scene.' }]

let server: http.Server | null = null
let baseUrl = ''

function provider(): AIProvider {
  return {
    id: 'test',
    name: 'Test',
    baseUrl,
    apiKey: 'test-key',
    model: 'test-model',
    maxTokens: 1024,
  }
}

async function listen(handler: (res: http.ServerResponse) => void): Promise<string> {
  server = http.createServer((_req, res) => handler(res))
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
  mock.cfg = { ai: { activeProviderId: 'test', providers: [provider()] } }
  return baseUrl
}

function sse(res: http.ServerResponse, chunks: string[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  for (const c of chunks) res.write(c)
  res.end()
}

async function collect(gen: AsyncGenerator<ChatStreamChunk>): Promise<ChatStreamChunk[]> {
  const out: ChatStreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

beforeEach(() => {
  baseUrl = ''
})

afterEach(async () => {
  server?.closeAllConnections()
  server?.close()
  server = null
})

describe('chatStream timeouts', () => {
  it('times out when the provider never sends response headers', async () => {
    await listen(() => {
      // Never writeHead / write: the connection stays open without a response.
    })
    const gen = chatStream(messages, 'test', undefined, undefined, undefined, {
      connectMs: 200,
    })
    await expect(collect(gen)).rejects.toThrow(/timed out after 200ms without a response/)
  })

  it('times out when the stream stalls with no deltas (idle)', async () => {
    await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      // Send one delta so the fetch resolves, then go silent forever.
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
    })
    const gen = chatStream(messages, 'test', undefined, undefined, undefined, { idleMs: 200 })
    await expect(collect(gen)).rejects.toThrow(/timed out after 200ms without stream data/)
  })

  it('collects streamed deltas and marks completion on [DONE]', async () => {
    await listen((res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"there"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    )
    const chunks = await collect(chatStream(messages, 'test'))
    expect(chunks).toEqual([
      { type: 'content', text: 'Hi ' },
      { type: 'content', text: 'there' },
      { type: 'done', complete: true },
    ])
  })

  it('marks the stream incomplete when it ends without [DONE]', async () => {
    await listen((res) => sse(res, ['data: {"choices":[{"delta":{"content":"half"}}]}\n\n']))
    const chunks = await collect(chatStream(messages, 'test'))
    expect(chunks).toEqual([
      { type: 'content', text: 'half' },
      { type: 'done', complete: false },
    ])
  })

  it('reports a non-2xx provider response', async () => {
    await listen((res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'boom' }))
    })
    await expect(collect(chatStream(messages, 'test'))).rejects.toThrow(/AI request failed \(500\)/)
  })

  it('settles cleanly when the consumer stops the stream early', async () => {
    await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
      // Stay silent afterwards.
    })
    // Large idleMs: this test is about cleanup, not timeouts. Stopping while
    // suspended at a yield must run the finally (clear idle timer, cancel the
    // reader) and settle without leaving anything behind; stopping while the
    // generator is stuck inside reader.read() is unblocked by the idle timer
    // instead (covered by the idle-timeout test above).
    const gen = chatStream(messages, 'test', undefined, undefined, undefined, { idleMs: 5000 })
    const first = await gen.next()
    expect(first.value).toEqual({ type: 'content', text: 'Hi' })
    await expect(gen.return(undefined)).resolves.toEqual({ done: true, value: undefined })
  })
})

describe('chat timeouts', () => {
  it('times out on a hung provider', async () => {
    await listen(() => {
      // Never respond.
    })
    await expect(chat(messages, 'test', { connectMs: 200 })).rejects.toThrow(
      /timed out after 200ms without a response/,
    )
  })

  it('times out when the provider stalls after sending headers (body)', async () => {
    await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
      // Headers arrive, but the body never does: the json read must be capped.
    })
    await expect(chat(messages, 'test', { connectMs: 200, bodyMs: 200 })).rejects.toThrow(
      /timed out after 200ms without the response body/,
    )
  })
})

describe('chatStream external signal', () => {
  it('aborts the upstream request when the caller signal fires', async () => {
    let upstreamClosed = false
    await listen((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
      res.on('close', () => {
        upstreamClosed = true
      })
    })
    const ctrl = new AbortController()
    const gen = chatStream(
      messages,
      'test',
      undefined,
      undefined,
      undefined,
      { idleMs: 5000 },
      ctrl.signal,
    )
    const first = await gen.next()
    expect(first.value).toEqual({ type: 'content', text: 'Hi' })
    ctrl.abort()
    // An external abort surfaces as AbortError (not a timeout error)...
    await expect(gen.next()).rejects.toMatchObject({ name: 'AbortError' })
    // ...and the upstream socket is torn down instead of hanging until idleMs.
    await vi.waitFor(() => expect(upstreamClosed).toBe(true))
  })
})
