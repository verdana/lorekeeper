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
}

export {}
