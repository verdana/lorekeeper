import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

interface Props {
  children: ReactNode
  /** Optional context label for error reporting. */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * React Error Boundary. Catches render-phase errors and shows a friendly
 * fallback instead of unmounting the whole tree. Resets when the user clicks
 * "Retry" (remounts children).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`,
      error,
      info.componentStack,
    )
  }

  handleRetry = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children

    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="card p-8 max-w-lg text-center space-y-4">
          <AlertTriangle size={32} className="mx-auto text-star-danger" />
          <h2 className="text-lg font-semibold text-ink-deep">Something went wrong</h2>
          <p className="text-sm text-ink-muted leading-relaxed">
            {this.state.error.message || 'An unexpected error occurred while rendering this view.'}
          </p>
          <button onClick={this.handleRetry} className="btn btn-primary btn-sm">
            <RefreshCw size={14} />
            Retry
          </button>
        </div>
      </div>
    )
  }
}
