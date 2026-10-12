import { initInterfaceSize, initTheme, startSharedAppearanceSync } from "@panelyth/ui"
import { initLocale, LocaleBoundary } from "@panelyth/i18n"
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
import { loadCommandHistory } from "./features/cmdline"
import { loadTools } from "./features/tools"
import { startThumbs } from "./features/thumbs"
import { loadSettings } from "./features/settings"
import { startMarks } from "./features/marks"
import { startSizeJobs } from "./features/sizes"
import { loadLayout } from "./features/panels"
import { startSidecarMonitoring } from "./features/sidecar"
import { startMedia } from "./features/media"
import { startOpen } from "./features/open"
import { startMediaWindowHost, startQuickView } from "./features/viewers"
import { startFind } from "./features/find"
import { startArchives } from "./features/archives"
import { startCompareEvents } from "./features/compare"
import { startRenameEvents } from "./features/rename"
import "./styles.css"

// The stored language loads before the first paint (ADR-0034).
await initLocale()
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
  // The user's commands first: their key bindings are among the shortcuts (C10).
  void loadTools()
    .catch(() => undefined)
    .then(loadShortcuts)
    .catch(() => undefined)
  void loadCommandHistory().catch(() => undefined)
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
  // The Thumbnails view: finished previews reach both panels' tiles (C10).
  startThumbs()
  // Full-screen media windows ask this panel for the next and previous image (ADR-0033).
  startMediaWindowHost()
  // Find files: results and progress of the dialog's search (C06).
  startFind()
  // Archives: the results of archive tests are announced (C07).
  startArchives()
  // Compare and synchronize: the dialog's compare, checksum and compare jobs (C08).
  startCompareEvents()
  // Multi-rename, its undo and attribute changes: their results are announced (C09).
  startRenameEvents()
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <AppShell />
    </LocaleBoundary>
  </StrictMode>,
)
