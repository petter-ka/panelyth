import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from "react"
import {
  dismissError,
  openHome,
  retry,
  useListingStore,
  type PanelErrorKind,
} from "../features/listing"
import type { Side } from "../features/panels"
import { FullView, type FullViewHandle } from "./FullView"
import { PathBar, type PathBarHandle } from "./PathBar"
import { StatusLine } from "./StatusLine"

export interface PanelHandle {
  focus(): void
}

interface PanelProps {
  side: Side
  active: boolean
  onActivate(): void
}

const TITLES: Record<PanelErrorKind, string> = {
  notFound: "Folder not found",
  denied: "Permission denied",
  notReady: "Drive not ready",
  network: "Network location unavailable",
  other: "This folder can't be opened",
}

/**
 * One file panel (ADR-0028): path bar, the Full view, the status line, and
 * the listing states (CFR-28): loading, empty, permission denied, not found,
 * drive not ready, network unavailable.
 */
export const Panel = forwardRef<PanelHandle, PanelProps>(function Panel(
  { side, active, onActivate },
  ref,
) {
  const label = side === "left" ? "Left panel" : "Right panel"
  const view = useRef<FullViewHandle>(null)
  const pathBar = useRef<PathBarHandle>(null)
  useImperativeHandle(ref, () => ({ focus: () => view.current?.focus() }), [])

  const dirId = useListingStore((s) => s[side].dirId)
  const error = useListingStore((s) => s[side].error)
  const total = useListingStore((s) => s[side].query?.total ?? 0)
  const listing = useListingStore((s) => s[side].progress?.state === "running")
  const loading = useListingStore((s) => s[side].loading)

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "d") {
      e.preventDefault()
      pathBar.current?.edit()
    } else if (e.key === "Escape" && error) {
      e.preventDefault()
      dismissError(side)
    }
  }

  let message: { title: string; detail?: string } | null = null
  if (dirId === null && !error) message = { title: loading ? "Opening…" : "No folder open" }
  else if (dirId !== null && total === 0 && !error && !loading) {
    message = listing ? { title: "Listing…" } : { title: "This folder is empty" }
  }

  return (
    <section
      aria-label={label}
      data-testid={`panel-${side}`}
      data-active={active}
      onMouseDown={onActivate}
      onKeyDown={onKeyDown}
      className={`flex h-full min-w-0 flex-col border-t-2 ${active ? "border-accent" : "border-transparent"}`}
    >
      <PathBar ref={pathBar} side={side} active={active} onDone={() => view.current?.focus()} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <FullView ref={view} side={side} active={active} label={`${label} contents`} />
        {message && (
          <div className="pointer-events-none absolute inset-x-0 top-14 text-center text-xs text-muted">
            {message.title}
          </div>
        )}
        {error && (
          <div
            role="alert"
            data-testid={`error-${side}`}
            data-kind={error.kind}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas px-6 text-center"
          >
            <div>
              <p className="text-sm text-text">{TITLES[error.kind]}</p>
              <p className="mt-1 text-xs text-muted">{error.message}</p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => void retry(side)}
                className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
              >
                Retry
              </button>
              {dirId !== null && (
                <button
                  type="button"
                  onClick={() => dismissError(side)}
                  title="Esc"
                  className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
                >
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={() => void openHome(side)}
                className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
              >
                Home folder
              </button>
            </div>
          </div>
        )}
      </div>
      <StatusLine side={side} />
    </section>
  )
})
