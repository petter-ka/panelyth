import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import { aboutPortOf, startAboutSync, startSwitchSettingsSync } from "@panelyth/renderer-core"
import {
  initInterfaceSize,
  initTheme,
  menuCommandHandler,
  connectWindowFrame,
  startSharedAppearanceSync,
} from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { aboutApi, bridge, isBridgeAvailable } from "./bridge"
import { startSearchEvents } from "./features/search"
import { openSettings } from "./features/settings"
import { startSystem } from "./features/system"
import "./styles.css"

// The stored language loads before the first paint (ADR-0034).
await initLocale()
initTheme()
initInterfaceSize()
if (isBridgeAvailable()) {
  // The title strip's window buttons (ADR-0045).
  connectWindowFrame(bridge.windowFrame())
  const settings = {
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key: string, value: unknown) =>
      void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener: (key: string, value: unknown) => void) =>
      bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  }
  // Theme, style and interface size are shared with the other apps (ADR-0031).
  startSharedAppearanceSync(settings)
  startSwitchSettingsSync(settings)
  // Settings → About and the native menu's items (Stage P06).
  startAboutSync(
    aboutPortOf(aboutApi, settings.saveSetting),
    menuCommandHandler({ openSettings, openShortcuts: () => undefined }),
  )
  // The dashboard's readings, only while System is on screen (ADR-0042).
  startSystem()
  startSearchEvents()
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <App />
    </LocaleBoundary>
  </StrictMode>,
)
