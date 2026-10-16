import { openSettingsWindowOr } from "@panelyth/ui"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

/** The in-page Settings dialog, for when the settings window cannot open (ADR-0039). */
export const useSettingsStore = create<{ open: boolean }>(() => ({ open: false }))

export const setSettingsOpen = (open: boolean): void => useSettingsStore.setState({ open })

export function openSettings(): void {
  if (!isBridgeAvailable()) return setSettingsOpen(true)
  openSettingsWindowOr(
    (tab) => bridge.openSettingsWindow(tab),
    () => setSettingsOpen(true),
  )
}
