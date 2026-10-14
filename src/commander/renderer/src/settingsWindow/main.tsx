import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import { aboutPortOf } from "@panelyth/renderer-core"
import { initInterfaceSize, initTheme, startSettingsWindowPage } from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { aboutApi, bridge } from "../bridge"
import { loadLayout } from "../features/panels"
import { loadSettings } from "../features/settings"
import { startSidecarMonitoring } from "../features/sidecar"
import { loadTools } from "../features/tools"
import { SettingsWindowApp } from "./SettingsWindowApp"
import "../styles.css"

// The commander's settings window (settings.html, ADR-0039). It shares the
// commander's origin, so the stored language, theme and size apply as in the
// commander; it loads only what Settings edits: the commander's settings, its
// tools and toolbar, the layout (the folder tree mode) and the shared settings.
// The layout loads before anything can be changed, so a saved split is kept.
await initLocale()
initTheme()
initInterfaceSize()
startSidecarMonitoring()
void loadSettings().catch(() => undefined)
void loadTools().catch(() => undefined)
void loadLayout().catch(() => undefined)
const save = (key: string, value: unknown): void =>
  void bridge.setSetting(key, value).catch(() => undefined)
startSettingsWindowPage({
  settings: {
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: save,
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  },
  about: aboutPortOf(aboutApi, save),
})

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <SettingsWindowApp />
    </LocaleBoundary>
  </StrictMode>,
)
