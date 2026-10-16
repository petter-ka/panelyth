import {
  initInterfaceSize,
  initTheme,
  menuCommandHandler,
  startSharedAppearanceSync,
  whileAppLoads,
} from "@panelyth/ui"
import { initLocale, LocaleBoundary, t } from "@panelyth/i18n"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { aboutApi, bridge, isBridgeAvailable } from "./bridge"
import { AppShell } from "./components/AppShell"
import { aboutPortOf, startAboutSync, startSwitchSettingsSync } from "@panelyth/renderer-core"
import { startPanels } from "./features/carry"
import { startDrives } from "./features/drives"
import { startHotlist } from "./features/hotlist"
import { startQueue } from "./features/queue"
import { loadShortcuts, setHelpOpen } from "./features/keymap"
import { loadCommandHistory } from "./features/cmdline"
import { loadTools } from "./features/tools"
import { startThumbs } from "./features/thumbs"
import { loadSettings, openSettings } from "./features/settings"
import { startSettingsRelay } from "./features/settingsRelay"
import { loadTabSets } from "./features/tabsets"
import { startTree } from "./features/tree"
import { startRemote } from "./features/remote"
import { startMarks } from "./features/marks"
import { startSizeJobs } from "./features/sizes"
import { loadLayout } from "./features/panels"
import { startSidecarMonitoring } from "./features/sidecar"
import { startMedia } from "./features/media"
import { startOpen } from "./features/open"
import { startMediaWindowHost, startQuickView } from "./features/viewers"
import { startFind } from "./features/find"
import { startGit } from "./features/git"
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
  // Settings → About and the native menu's items (Stage P06).
  startAboutSync(
    aboutPortOf(
      aboutApi,
      (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    ),
    menuCommandHandler({
      openSettings,
      openShortcuts: () => setHelpOpen(true),
    }),
  )
  // The user's commands first: their key bindings are among the shortcuts (C10).
  void loadTools()
    .catch(() => undefined)
    .then(loadShortcuts)
    .catch(() => undefined)
  void loadCommandHistory().catch(() => undefined)
  void loadSettings().catch(() => undefined)
  // What the settings window changes applies here at once (ADR-0039).
  startSettingsRelay()
  // Saved tab sets (C10.5).
  void loadTabSets().catch(() => undefined)
  // Drives, the hotlist (shared bookmarks) and recent locations (C03).
  startDrives()
  startHotlist()
  // The folder tree follows the panels and the drives (C10.5); it lists nothing until shown.
  startTree()
  // Saved connections (C10.5): read when first shown; nothing connects at startup.
  startRemote()
  // The shared operation queue (Stage C04).
  startQueue()
  // Marks, folder sizes, panel listings, events and the shared context (C01, C02).
  startMarks()
  startSizeJobs()
  // The panels' first folders open behind the loading screen (a cold first switch shows it at once).
  void whileAppLoads(startPanels(), { label: t("Loading…"), immediate: true }).catch(
    () => undefined,
  )
  // Quick view and the lister: the shared media components on this bridge (C05).
  startMedia()
  // The Thumbnails view: finished previews reach both panels' tiles (C10).
  startThumbs()
  // Full-screen media windows ask this panel for the next and previous image (ADR-0033).
  startMediaWindowHost()
  // Find files: results and progress of the dialog's search (C06).
  startFind()
  // Git: the status of the panels' folders and the runs (ADR-0043).
  startGit()
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
