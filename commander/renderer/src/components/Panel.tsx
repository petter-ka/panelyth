import { forwardRef } from "react"
import type { Side } from "../features/panels"

interface PanelProps {
  side: Side
  active: boolean
  onActivate(): void
}

/**
 * One file panel (ADR-0028). Stage C00 is the shell only: the header, the
 * active-panel marking and an empty state. Listings arrive in Stage C01.
 */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { side, active, onActivate },
  ref,
) {
  const label = side === "left" ? "Left panel" : "Right panel"
  return (
    <section
      aria-label={label}
      data-testid={`panel-${side}`}
      data-active={active}
      onMouseDown={onActivate}
      className={`flex h-full min-w-0 flex-col border-t-2 ${active ? "border-accent" : "border-transparent"}`}
    >
      <header className="flex h-8 shrink-0 items-center border-b border-border bg-chrome px-3 text-xs text-muted">
        <span className={active ? "text-text" : undefined}>{label}</span>
      </header>
      <div
        ref={ref}
        tabIndex={0}
        role="grid"
        aria-label={`${label} contents`}
        className="flex min-h-0 flex-1 items-center justify-center bg-canvas outline-none"
      >
        <div className="text-center">
          <p className="text-sm text-text">No folder open</p>
          <p className="mt-1 text-xs text-muted">Folder listings come next.</p>
        </div>
      </div>
    </section>
  )
})
