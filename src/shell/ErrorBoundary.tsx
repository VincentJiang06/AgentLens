import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * Adapters are third-party code from the shell's point of view: M1..M4 each drop a
 * `View` in here and one of them will eventually throw on a record nobody tested.
 * That must cost the reader a notice, not the page.
 */

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: (error: Error, reset: () => void) => ReactNode
  /** Changing this clears a caught error — new data deserves a fresh attempt. */
  resetKey?: unknown
}

interface ErrorBoundaryState {
  error: Error | null
  /** The `resetKey` the current error belongs to. */
  seenKey: unknown
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, seenKey: undefined }

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(
    props: ErrorBoundaryProps,
    state: ErrorBoundaryState,
  ): Partial<ErrorBoundaryState> | null {
    // Clearing here rather than in componentDidUpdate keeps it to one render.
    return props.resetKey === state.seenKey ? null : { error: null, seenKey: props.resetKey }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[agentlens] render failed', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    return error === null ? this.props.children : this.props.fallback(error, this.reset)
  }
}
