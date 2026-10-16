import { SettingsWindowPage, TooltipProvider } from "@panelyth/ui"
import { bridge } from "../bridge"

const close = (): void => void bridge.closeSettingsWindow().catch(() => window.close())

/** System's settings window (ADR-0039): the shared tabs, filling a native window. */
export function SettingsWindowApp() {
  return (
    <TooltipProvider>
      <SettingsWindowPage
        currentApp="system"
        showGeneral
        settingsReady
        appSettings={null}
        onOpenShortcuts={close}
        onClose={close}
      />
    </TooltipProvider>
  )
}
