import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import { aboutPortOf } from "@panelyth/renderer-core"
import { startSettingsWindowPage } from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { aboutApi, bridge } from "../bridge"
import { startEditorSettingsPersistence } from "../features/editor/editorSettings"
import { startLibraryMonitoring } from "../features/library/libraryStore"
import { startViewerSettingsPersistence } from "../features/settings/settingsStore"
import { startSidecarMonitoring } from "../features/system/sidecarStore"
import { initTheme } from "../features/theme/themeStore"
import { initInterfaceSize } from "../features/theme/interfaceSizeStore"
import { SettingsWindowApp } from "./SettingsWindowApp"
import "../styles/index.css"

// The viewer's settings window (settings.html, ADR-0039). It shares the
// viewer's origin, so the stored language, theme and size apply as in the
// viewer; it starts only what Settings reads: the sidecar status, the library's
// stored settings and the shared settings.
await initLocale()
initTheme()
initInterfaceSize()
startSidecarMonitoring()
startLibraryMonitoring()
startViewerSettingsPersistence()
startEditorSettingsPersistence()
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
