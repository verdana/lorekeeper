/// <reference types="vite/client" />
import type { Api } from '../shared/types'
import type { JSX as ReactJSX } from 'react'

declare global {
  interface Window {
    api: Api
  }

  // React 19 removed the global JSX namespace; re-add for JSX.Element return type.
  namespace JSX {
    type Element = ReactJSX.Element
    type IntrinsicElements = ReactJSX.IntrinsicElements
    type ElementClass = ReactJSX.ElementClass
  }

  // process is Node-only. src/shared/prompts/index.ts probes it to pick the
  // prompt language; declare a minimal shape so the web build type-checks.
  // eslint-disable-next-line no-var
  var process: { env?: Record<string, string | undefined> } | undefined
}

export {}
