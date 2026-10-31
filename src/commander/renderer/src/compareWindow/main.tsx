import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import {
  connectWindowFrame,
  initInterfaceSize,
  initTheme,
  startSharedAppearanceSync,
} from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { bridge, isBridgeAvailable } from "../bridge"
import { startCompareEvents } from "../features/compare"
import { startQueue } from "../features/queue"
import { applyStoredSettings, loadSettings, SETTINGS_KEY } from "../features/settings"
import { startSidecarMonitoring } from "../features/sidecar"
import {
  CompareWindowApp,
  compareRequestOf,
  releaseCompare,
  startCompareRequest,
} from "./CompareWindowApp"
import "../styles.css"

// A compare window's page (compare.html, ADR-0048). It shares the commander's
// origin, so the stored language, theme and size apply as in the commander;
// it starts only what the comparison needs: the compare and job events, the
// jobs (a compare job may end before the page follows it) and the
// commander's settings (the date rules and the date format).
await initLocale()
initTheme()
initInterfaceSize()
startSidecarMonitoring()
if (isBridgeAvailable()) {
  // The title strip's window buttons (ADR-0045).
  connectWindowFrame(bridge.windowFrame())
  // Theme and interface size follow the apps while the window is open.
  startSharedAppearanceSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
  // The date rules edited here or in the commander stay one value (main relays them).
  bridge.on("settings.changed", ({ key, value }) => {
    if (key === SETTINGS_KEY) applyStoredSettings(value)
  })
  void loadSettings().catch(() => undefined)
  startQueue()
  startCompareEvents()
  // Closing the window lets go of what it holds in Go.
  window.addEventListener("pagehide", releaseCompare)
}
const request = compareRequestOf()
if (request) startCompareRequest(request)

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <CompareWindowApp />
    </LocaleBoundary>
  </StrictMode>,
)
