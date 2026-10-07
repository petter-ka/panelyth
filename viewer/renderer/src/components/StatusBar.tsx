import type { SidecarState } from "@fastview/contracts"
import { Tooltip } from "@fastview/ui"
import { useEffect, useState } from "react"
import { bridge } from "../bridge"
import { useFolderStore } from "../features/folder/folderStore"
import { openShortcutHelp, useShortcutHint } from "../features/shortcuts/shortcutStore"
import { measurePing, useSidecarStore } from "../features/system/sidecarStore"
import { THEME_OPTIONS, useThemeStore } from "../features/theme/themeStore"
import { useSettingsStore } from "../features/settings/settingsStore"
import { selectionCount, toDescriptor, useSelectionStore } from "../features/tiles/selectionStore"
import { formatBytes, formatCount } from "../lib/format"
import { KeyboardIcon, SettingsIcon } from "./ui/icons"

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

const SIZE_DELAY_MS = 150

/**
 * "12 selected, 48.2 MB". The count is exact locally (descriptor math); the
 * size comes from Go, debounced so dragging a selection does not flood IPC.
 */
function SelectionSummary() {
  const count = useSelectionStore(selectionCount)
  const selection = useSelectionStore((s) => s)
  const query = useFolderStore((s) => s.query)
  const [size, setSize] = useState<{ key: unknown; bytes: number } | null>(null)

  useEffect(() => {
    if (count < 2 || !query) return
    let live = true
    const timer = setTimeout(() => {
      bridge
        .selectionInfo(toDescriptor(selection, query.queryId, query.version))
        .then((info) => live && setSize({ key: selection, bytes: info.bytes }))
        .catch(() => undefined)
    }, SIZE_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [count, selection, query])

  if (count === 0) return null
  const bytes = size && size.key === selection ? `, ${formatBytes(size.bytes)}` : ""
  return (
    <span className="tabular-nums text-text" data-testid="selection-summary">
      {formatCount(count)} selected{count > 1 ? bytes : ""}
    </span>
  )
}

export function StatusBar() {
  const state = useSidecarStore((s) => s.status?.state ?? "starting")
  const pingMs = useSidecarStore((s) => s.pingMs)
  const goVersion = useSidecarStore((s) => s.info?.goVersion ?? null)
  const preference = useThemeStore((s) => s.preference)
  const cycleTheme = useThemeStore((s) => s.cycle)
  const themeLabel =
    THEME_OPTIONS.find((option) => option.value === preference)?.label ?? preference
  const shortcutHint = useShortcutHint("help.shortcuts")
  const openSettings = useSettingsStore((s) => s.openSettings)

  return (
    <footer className="flex h-7 items-center gap-3 border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted">
      <span
        role="status"
        aria-live="polite"
        className="flex items-center gap-1.5"
        data-testid="sidecar-status"
      >
        <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[state]}`} />
        <span data-state={state}>{LABEL[state]}</span>
      </span>
      {state === "ready" && (
        <Tooltip content="Measure backend round trip">
          <button
            type="button"
            onClick={() => void measurePing()}
            className="rounded px-1 tabular-nums hover:text-text"
            data-testid="ping"
          >
            {pingMs === null ? "ping …" : `ping ${pingMs.toFixed(1)} ms`}
          </button>
        </Tooltip>
      )}
      {goVersion && <span>{goVersion}</span>}
      <span className="flex-1" />
      <SelectionSummary />
      <Tooltip
        content={shortcutHint ? `Keyboard shortcuts (${shortcutHint})` : "Keyboard shortcuts"}
      >
        <button
          type="button"
          onClick={openShortcutHelp}
          aria-label="Keyboard shortcuts"
          className="grid place-items-center rounded px-1 hover:text-text"
        >
          <KeyboardIcon size={14} />
        </button>
      </Tooltip>
      <Tooltip content="Settings">
        <button
          type="button"
          onClick={openSettings}
          aria-label="Settings"
          className="grid place-items-center rounded px-1 hover:text-text"
        >
          <SettingsIcon size={14} />
        </button>
      </Tooltip>
      <Tooltip content="Change theme">
        <button
          type="button"
          onClick={cycleTheme}
          className="rounded px-1 capitalize hover:text-text"
          data-testid="theme-toggle"
        >
          Theme: {themeLabel}
        </button>
      </Tooltip>
    </footer>
  )
}
