import { initInterfaceSize, initTheme, startSharedAppearanceSync } from "@fastview/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { bridge, isBridgeAvailable } from "./bridge"
import { AppShell } from "./components/AppShell"
import { loadLayout } from "./features/panels"
import { startSidecarMonitoring } from "./features/sidecar"
import "./styles.css"

initTheme()
initInterfaceSize()
startSidecarMonitoring()
if (isBridgeAvailable()) {
  // Theme and interface size are shared with the viewer (ADR-0031).
  startSharedAppearanceSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
  void loadLayout().catch(() => undefined)
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
