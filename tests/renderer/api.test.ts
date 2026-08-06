import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_TIMEOUT_MS, chatStream, installApi } from '../../src/renderer/src/api'

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

describe('chatStream client-side timeouts', () => {
  /** A never-closing SSE body whose pending read rejects when the signal aborts. */
  const abortableSseBody = (events: string[], signal?: AbortSignal): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener('abort', () =>
          controller.error(new DOMException('Aborted', 'AbortError')),
        )
        for (const e of events) controller.enqueue(encoder.encode(e + '\n\n'))
      },
    })
  }

  it('times out when the server never sends response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        (_url: string, opts: RequestInit) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            )
          }),
      ),
    )
    await expect(
      chatStream(
        [{ role: 'user', content: 'x' }],
        undefined,
        () => {},
        undefined,
        undefined,
        undefined,
        false,
        {
          connectMs: 50,
        },
      ),
    ).rejects.toThrow(/timed out after 50ms without a response/)
  })

  it('times out when the stream stalls with no deltas (idle)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, opts: RequestInit) =>
        Promise.resolve(
          new Response(
            abortableSseBody(['data: {"type":"content","text":"hi"}'], opts.signal ?? undefined),
            {
              status: 200,
            },
          ),
        ),
      ),
    )
    await expect(
      chatStream(
        [{ role: 'user', content: 'x' }],
        undefined,
        () => {},
        undefined,
        undefined,
        undefined,
        false,
        {
          idleMs: 50,
        },
      ),
    ).rejects.toThrow(/timed out after 50ms without stream data/)
  })

  it('propagates a caller-initiated abort as an AbortError, not a timeout', async () => {
    const caller = new AbortController()
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation((_url: string, opts: RequestInit) =>
          Promise.resolve(
            new Response(abortableSseBody([], opts.signal ?? undefined), { status: 200 }),
          ),
        ),
    )
    const p = chatStream(
      [{ role: 'user', content: 'x' }],
      undefined,
      () => {},
      caller.signal,
      undefined,
      undefined,
      false,
      { idleMs: 5000 },
    )
    caller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('window.api RPC timeout', () => {
  it('times out a wedged RPC instead of hanging forever', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('window', {})
      installApi()
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(
          (_url: string, opts: RequestInit) =>
            new Promise((_resolve, reject) => {
              opts.signal?.addEventListener('abort', () =>
                reject(new DOMException('Aborted', 'AbortError')),
              )
            }),
        ),
      )
      const readChapter = (window.api as { readChapter: (f: string) => Promise<unknown> })
        .readChapter
      const p = readChapter('c.md')
      // Attach the assertion before the timer fires so the eventual rejection
      // is observed, not reported as an unhandled rejection.
      const assertion = expect(p).rejects.toThrow(/timed out after/)
      await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('still surfaces a real server error (not a timeout)', async () => {
    vi.stubGlobal('window', {})
    installApi()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )
    const readChapter = (window.api as { readChapter: (f: string) => Promise<unknown> }).readChapter
    await expect(readChapter('c.md')).rejects.toThrow('boom')
  })
})
