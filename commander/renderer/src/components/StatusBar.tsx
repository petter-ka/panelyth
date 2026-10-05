import type { SidecarState } from "@fastview/contracts"
import { THEME_OPTIONS, useThemeStore } from "@fastview/ui"
import { useSidecarStore } from "../features/sidecar"

const LABEL: Record<SidecarState, string> = {
  starting: "Backend starting",
  ready: "Backend ready",
  restarting: "Backend restarting",
  stopping: "Backend stopping",
  stopped: "Backend stopped",
  failed: "Backend unavailable",
}

const DOT: Record<SidecarState, string> = {
  starting: "bg-warning",
  ready: "bg-success",
  restarting: "bg-warning",
  stopping: "bg-muted",
  stopped: "bg-muted",
  failed: "bg-danger",
}

export function StatusBar() {
  const state = useSidecarStore((s) => s.status?.state ?? "starting")
  const theme = useThemeStore((s) => s.preference)
  const cycle = useThemeStore((s) => s.cycle)
  const themeLabel = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? theme
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted">
      <span className="flex items-center gap-1.5" data-testid="sidecar-status" data-state={state}>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state]}`} />
        {LABEL[state]}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        onClick={cycle}
        className="rounded px-1 hover:text-text"
        title="Change theme (shared with the viewer)"
        data-testid="theme-toggle"
      >
        Theme: {themeLabel}
      </button>
    </footer>
  )
}
