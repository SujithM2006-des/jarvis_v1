import { Component, type ReactNode } from 'react'

/**
 * Holds a custom layout (CustomLayout.tsx, written by JARVIS on request). If it
 * throws while rendering, it is dropped — the stock interface underneath keeps
 * working — and the reason goes to the log, so a bad layout can never leave
 * him without a face.
 */
export class LayoutBoundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  state = { failed: null as string | null }

  static getDerivedStateFromError(err: unknown) {
    return { failed: err instanceof Error ? err.message : String(err) }
  }

  componentDidCatch(err: unknown) {
    console.warn(`[jarvis] custom layout failed, showing the stock interface: ${String((err as Error)?.message ?? err)}`)
    // The stock parts the layout replaced (its `hide` list) come back.
    const root = document.documentElement
    for (const c of [...root.classList]) if (c.startsWith('cl-hide-')) root.classList.remove(c)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
