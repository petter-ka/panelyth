import { Component, type ErrorInfo, type ReactNode } from "react"
import { EmptyState } from "../components/EmptyState"

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

// React only supports error boundaries as class components; this is the one
// sanctioned exception to the functional-components rule.
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("render failure", error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <EmptyState
          tone="danger"
          title="Something went wrong"
          description={this.state.error.message}
          action={
            <button
              type="button"
              className="h-7 rounded-md border border-border bg-raised px-2.5 text-xs hover:border-muted"
              onClick={() => location.reload()}
            >
              Reload
            </button>
          }
        />
      )
    }
    return this.props.children
  }
}
