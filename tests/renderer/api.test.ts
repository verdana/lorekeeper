import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatStream } from '../../src/renderer/src/api'

// node tsconfig has no renderer env.d.ts (which declares window.api); the
// installed api module assigns window.api, so provide a minimal shape here.
declare global {
  interface Window {
    api?: unknown
  }
}

const sseResponse = (events: string[]): Response => {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e + '\n\n'))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const run = (events: string[]) => chatStream([{ role: 'user', content: 'x' }], undefined, () => {})

describe('chatStream completeness semantics', () => {
  it('takes completed/finishReason from the model-level done event', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'data: {"type":"content","text":"hello "}',
            'data: {"type":"content","text":"world"}',
            'data: {"type":"done","finishReason":"stop","complete":true}',
          ]),
        ),
    )
    const out = await run([])
    expect(out.content).toBe('hello world')
    expect(out.completed).toBe(true)
    expect(out.finishReason).toBe('stop')
  })

  it('keeps completed=false when a transport-level event: done follows a model complete:false', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'data: {"type":"content","text":"half"}',
            'data: {"type":"done","finishReason":"length","complete":false}',
            'event: done\ndata: {}',
          ]),
        ),
    )
    const out = await run([])
    expect(out.content).toBe('half')
    expect(out.completed).toBe(false)
    expect(out.finishReason).toBe('length')
  })

  it('returns completed=false when the connection closes without a model-level done', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          'data: {"type":"content","text":"partial"}',
          'event: done\ndata: {}', // transport-level only
        ]),
      ),
    )
    const out = await run([])
    expect(out.content).toBe('partial')
    expect(out.completed).toBe(false)
    expect(out.finishReason).toBeNull()
  })

  it('propagates a transport error even after partial content', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          sseResponse([
            'data: {"type":"content","text":"partial"}',
            'event: error\ndata: {"error":"boom"}',
          ]),
        ),
    )
    await expect(run([])).rejects.toThrow('boom')
  })
})
