import { Component, type ReactNode } from 'react'
import { onLayoutRetry, reportLayoutError, setHidden } from './kit'

/**
 * Holds a custom layout (CustomLayout.tsx, written by JARVIS on request). If it
 * throws while rendering, it is dropped — the stock interface comes back — and
 * the reason is kept for the bridge's post-apply check, so a bad layout can
 * never leave him without a face. A corrected layout gets another go when the
 * bridge asks (retryLayout in the kit).
 */
export class LayoutBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null }
  private off: (() => void) | null = null

  static getDerivedStateFromError(err: unknown) {
    return { failed: err instanceof Error ? err.message : String(err) }
  }

  componentDidMount() {
    this.off = onLayoutRetry(() => {
      reportLayoutError(null)
      this.setState({ failed: null })
    })
  }

  componentWillUnmount() {
    this.off?.()
  }

  componentDidCatch(err: unknown) {
    const message = String((err as Error)?.message ?? err)
    console.warn(`[jarvis] custom layout failed, showing the stock interface: ${message}`)
    reportLayoutError(message)
    // The stock parts the layout replaced come back.
    setHidden([])
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
