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
