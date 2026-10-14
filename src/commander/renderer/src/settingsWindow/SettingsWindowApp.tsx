import { FullScreenSettings } from "@panelyth/media-ui"
import { SettingsWindowPage, TooltipProvider } from "@panelyth/ui"
import { bridge } from "../bridge"
import { CommanderSettings } from "../components/SettingsDialog"
import { useSidecarStore } from "../features/sidecar"

/** Closes the window; with "shortcuts" the commander opens its shortcuts dialog behind it. */
const close = (then?: "shortcuts"): void =>
  void bridge.closeSettingsWindow(then).catch(() => window.close())

/**
 * The commander's settings window (ADR-0039): the dialog's tabs, filling a
 * native window. "Show hidden files" and "system files too" are applied to the panels by
 * the commander's view when the change arrives, not here.
 */
export function SettingsWindowApp() {
  const settingsReady = useSidecarStore((s) => s.status?.state === "ready")
  return (
    <TooltipProvider>
      <SettingsWindowPage
        currentApp="commander"
        showGeneral
        settingsReady={settingsReady}
        appSettings={<CommanderSettings />}
        fullScreenSettings={<FullScreenSettings />}
        onOpenShortcuts={() => close("shortcuts")}
        onClose={() => close()}
      />
    </TooltipProvider>
  )
}
