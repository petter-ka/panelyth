import type { SidecarState } from "@fastview/contracts"
import { THEME_OPTIONS, Tooltip, useThemeStore } from "@fastview/ui"
import { useCarryNotice } from "../features/carry"
import { useFilesStore } from "../features/files"
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
  const notice = useCarryNotice((s) => s.message)
  const filesNotice = useFilesStore((s) => s.notice)
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted">
      <span className="flex items-center gap-1.5" data-testid="sidecar-status" data-state={state}>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state]}`} />
        {LABEL[state]}
      </span>
      {notice && (
        <span role="status" data-testid="carry-notice" className="text-warning">
          {notice}
        </span>
      )}
      {filesNotice && (
        <span role="status" data-testid="files-notice" className="text-text">
          {filesNotice}
        </span>
      )}
      <span className="flex-1" />
      <Tooltip content="Change theme (shared with the viewer)">
        <button
          type="button"
          onClick={cycle}
          className="rounded px-1 hover:text-text"
          data-testid="theme-toggle"
        >
          Theme: {themeLabel}
        </button>
      </Tooltip>
    </footer>
  )
}
