import { SettingsWindowPage, TooltipProvider } from "@panelyth/ui"
import { bridge, canSwitchApps } from "../bridge"
import { ViewerSettings } from "../components/SettingsDialog"
import { useLibraryStore } from "../features/library/libraryStore"

/** Closes the window; with "shortcuts" the viewer opens its shortcuts dialog behind it. */
const close = (then?: "shortcuts"): void =>
  void bridge.closeSettingsWindow(then).catch(() => window.close())

/** The viewer's settings window (ADR-0039): the dialog's tabs, filling a native window. */
export function SettingsWindowApp() {
  const settingsReady = useLibraryStore((s) => s.loaded)
  return (
    <TooltipProvider>
      <SettingsWindowPage
        currentApp="viewer"
        showGeneral={canSwitchApps()}
        settingsReady={settingsReady}
        appSettings={<ViewerSettings />}
        onOpenShortcuts={() => close("shortcuts")}
        onClose={() => close()}
      />
    </TooltipProvider>
  )
}
