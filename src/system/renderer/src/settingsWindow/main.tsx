import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import { aboutPortOf } from "@panelyth/renderer-core"
import { initInterfaceSize, initTheme, startSettingsWindowPage } from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { aboutApi, bridge } from "../bridge"
import { SettingsWindowApp } from "./SettingsWindowApp"
import "../styles.css"

// System's settings window (settings.html, ADR-0039, ADR-0042): the shared
// settings only (General, Appearance, About); System has none of its own.
await initLocale()
initTheme()
initInterfaceSize()
const save = (key: string, value: unknown): void =>
  void bridge.setSetting(key, value).catch(() => undefined)
startSettingsWindowPage({
  settings: {
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: save,
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  },
  about: aboutPortOf(aboutApi, save),
  frame: bridge.windowFrame(),
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
