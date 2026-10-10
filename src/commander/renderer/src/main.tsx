import { initInterfaceSize, initTheme, startSharedAppearanceSync } from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { bridge, isBridgeAvailable } from "./bridge"
import { AppShell } from "./components/AppShell"
import { startSwitchSettingsSync } from "@panelyth/renderer-core"
import { startPanels } from "./features/carry"
import { startDrives } from "./features/drives"
import { startHotlist } from "./features/hotlist"
import { startQueue } from "./features/queue"
import { loadShortcuts } from "./features/keymap"
import { loadSettings } from "./features/settings"
import { startMarks } from "./features/marks"
import { startSizeJobs } from "./features/sizes"
import { loadLayout } from "./features/panels"
import { startSidecarMonitoring } from "./features/sidecar"
import { startMedia } from "./features/media"
import { startOpen } from "./features/open"
import { startQuickView } from "./features/viewers"
import { startFind } from "./features/find"
import { startArchives } from "./features/archives"
import "./styles.css"

initTheme()
initInterfaceSize()
startSidecarMonitoring()
// Stage C05: Enter on files, quick view following the cursor.
startOpen()
startQuickView()
if (isBridgeAvailable()) {
  // Theme and interface size are shared with the viewer (ADR-0031).
  startSharedAppearanceSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
  void loadLayout().catch(() => undefined)
  // What carries over on a switch (Settings → General, shared with the viewer).
  startSwitchSettingsSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
  void loadShortcuts().catch(() => undefined)
  void loadSettings().catch(() => undefined)
  // Drives, the hotlist (shared bookmarks) and recent locations (C03).
  startDrives()
  startHotlist()
  // The shared operation queue (Stage C04).
  startQueue()
  // Marks, folder sizes, panel listings, events and the shared context (C01, C02).
  startMarks()
  startSizeJobs()
  void startPanels().catch(() => undefined)
  // Quick view and the lister: the shared media components on this bridge (C05).
  startMedia()
  // Find files: results and progress of the dialog's search (C06).
  startFind()
  // Archives: the results of archive tests are announced (C07).
  startArchives()
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
