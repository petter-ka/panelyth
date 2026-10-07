import { forwardRef, useEffect, useImperativeHandle, useRef, type KeyboardEvent } from "react"
import { Tooltip } from "@fastview/ui"
import { useUiStore } from "../features/commands"
import { useQuickSearch } from "../features/quicksearch"
import {
  dismissError,
  openHome,
  retry,
  useListingStore,
  type PanelErrorKind,
} from "../features/listing"
import type { Side } from "../features/panels"
import { BriefView } from "./BriefView"
import { DriveBar, DriveMenu } from "./DriveBar"
import { FullView, type FullViewHandle } from "./FullView"
import { HistoryMenu, HotlistMenu } from "./HotlistMenus"
import { PathBar, type PathBarHandle } from "./PathBar"
import { StatusLine } from "./StatusLine"
import { TabBar } from "./TabBar"

/** The quick-search box at the bottom of the panel (focus stays in the list). */
function QuickSearchBox({ side }: { side: Side }) {
  const open = useQuickSearch((s) => s.side === side)
  const text = useQuickSearch((s) => s.text)
  const missed = useQuickSearch((s) => s.missed)
  if (!open) return null
  return (
    <div
      role="search"
      aria-label="Quick search"
      data-testid={`quicksearch-${side}`}
      data-missed={missed}
      className="absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded border border-accent bg-raised px-2 py-1 text-xs shadow-lg"
    >
      <span className="text-muted">Search:</span>
      <span className={missed ? "text-danger" : "text-text"} aria-live="polite">
        {text}
      </span>
      <span className="text-[0.6875rem] text-muted">↑↓ next · Esc</span>
    </div>
  )
}

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
  const list = useRef<FullViewHandle>(null)
  const pathBar = useRef<PathBarHandle>(null)
  useImperativeHandle(ref, () => ({ focus: () => list.current?.focus() }), [])

  const dirId = useListingStore((s) => s[side].dirId)
  const error = useListingStore((s) => s[side].error)
  const total = useListingStore((s) => s[side].query?.total ?? 0)
  const listing = useListingStore((s) => s[side].progress?.state === "running")
  const loading = useListingStore((s) => s[side].loading)
  const view = useListingStore((s) => s[side].view)
  // Ctrl+F1 / Ctrl+F2 replace the focused view: the new one takes the keys.
  const viewSeen = useRef(view)
  useEffect(() => {
    if (viewSeen.current === view) return
    viewSeen.current = view
    if (active) list.current?.focus()
  }, [view, active])

  // Alt+D (path.edit) from the keymap.
  const editToken = useUiStore((s) => s.editPath[side])
  const seenToken = useRef(editToken)
  useEffect(() => {
    // Only requests made after this panel mounted.
    if (editToken !== seenToken.current) pathBar.current?.edit()
    seenToken.current = editToken
  }, [editToken])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && error) {
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
      <DriveBar side={side} />
      <TabBar side={side} />
      <PathBar ref={pathBar} side={side} active={active} onDone={() => list.current?.focus()} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {view === "brief" ? (
          <BriefView ref={list} side={side} active={active} label={`${label} contents`} />
        ) : (
          <FullView ref={list} side={side} active={active} label={`${label} contents`} />
        )}
        <QuickSearchBox side={side} />
        <DriveMenu side={side} />
        <HotlistMenu side={side} />
        <HistoryMenu side={side} />
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
                <Tooltip content="Esc">
                  <button
                    type="button"
                    onClick={() => dismissError(side)}
                    className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
                  >
                    Back
                  </button>
                </Tooltip>
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
