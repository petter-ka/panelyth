import type { SidecarState } from "@panelyth/contracts"
import { THEME_OPTIONS, Tooltip, useThemeStore } from "@panelyth/ui"
import { useCarryNotice } from "../features/carry"
import { useFilesStore } from "../features/files"
import { useSidecarStore } from "../features/sidecar"
import { msg, t } from "@panelyth/i18n"

const LABEL: Record<SidecarState, string> = {
  starting: msg("Backend starting"),
  ready: msg("Backend ready"),
  restarting: msg("Backend restarting"),
  stopping: msg("Backend stopping"),
  stopped: msg("Backend stopped"),
  failed: msg("Backend unavailable"),
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
  const themeLabel = t(THEME_OPTIONS.find((o) => o.value === theme)?.label ?? theme)
  const notice = useCarryNotice((s) => s.message)
  const filesNotice = useFilesStore((s) => s.notice)
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-border bg-chrome px-3 text-2xs text-muted">
      <span className="flex items-center gap-1.5" data-testid="sidecar-status" data-state={state}>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state]}`} />
        {t(LABEL[state])}
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
      <Tooltip content={t("Change theme (shared with the viewer)")}>
        <button
          type="button"
          onClick={cycle}
          className="h-6 rounded px-1.5 font-normal hover:bg-raised hover:text-text"
          data-testid="theme-toggle"
        >
          {t("Theme: {theme}", { theme: themeLabel })}
        </button>
      </Tooltip>
    </footer>
  )
}
