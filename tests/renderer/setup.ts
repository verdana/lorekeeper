/**
 * jsdom gaps that the renderer depends on.
 *
 * jsdom implements the DOM but not the layout-dependent parts of it, so a
 * component that scrolls or measures itself throws on mount. These shims exist
 * to make a render test possible, not to assert anything: they are the minimum
 * for a component to render. Guarded so the file is harmless in the node
 * environment the server tests use.
 */

if (typeof Element !== 'undefined') {
  const proto = Element.prototype as Element & {
    scrollTo?: (options?: ScrollToOptions | number, y?: number) => void
    scrollIntoView?: (arg?: boolean | ScrollIntoViewOptions) => void
  }
  if (typeof proto.scrollTo !== 'function') {
    // jsdom throws on scrollTo; the view only uses it to follow streamed text.
    proto.scrollTo = () => {}
  }
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {}
  }
}

if (typeof Range !== 'undefined') {
  const proto = Range.prototype as Range & {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  // CodeMirror measures the caret's range to place its cursor and selection
  // layers. jsdom has no layout, so the honest answer is "no rectangles" —
  // which the editor already handles by drawing nothing.
  if (typeof proto.getClientRects !== 'function') {
    proto.getClientRects = () => [] as unknown as DOMRectList
  }
  if (typeof proto.getBoundingClientRect !== 'function') {
    const zero = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    }
    proto.getBoundingClientRect = () => zero as unknown as DOMRect
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // Layout observers never fire in jsdom; components that use one to measure
  // their own size simply keep their initial state.
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  class IntersectionObserverStub {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds: readonly number[] = []
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
    takeRecords(): [] {
      return []
    }
  }
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver =
    IntersectionObserverStub
}

// Node 22.4+ installs an experimental global `localStorage` that stays
// `undefined` unless the process runs with `--localstorage-file`. That global
// shadows the Storage jsdom would otherwise expose, so renderer tests that call
// `localStorage.clear()` crashed under Node 26. Give the jsdom environment an
// in-memory Storage when the platform does not provide one.
if (typeof window !== 'undefined') {
  const memoryStorage = (): Storage => {
    const entries = new Map<string, string>()
    return {
      get length(): number {
        return entries.size
      },
      key: (index: number) => [...entries.keys()][index] ?? null,
      getItem: (key: string) => entries.get(String(key)) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(String(key), String(value))
      },
      removeItem: (key: string) => {
        entries.delete(String(key))
      },
      clear: () => {
        entries.clear()
      },
    } as Storage
  }

  const target = globalThis as unknown as Record<string, unknown> & { window?: Window }
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    if (!target[key]) {
      const storage = memoryStorage()
      Object.defineProperty(globalThis, key, { value: storage, configurable: true })
      if (target.window && (target.window as unknown as Record<string, unknown>) !== target) {
        Object.defineProperty(target.window, key, { value: storage, configurable: true })
      }
    }
  }
}

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  // Not used for behaviour, only avoided: some components read a media query.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
