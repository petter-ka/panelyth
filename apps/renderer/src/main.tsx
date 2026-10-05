import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./app/App"
import { startFolderMonitoring } from "./features/folder/folderStore"
import { startJobMonitoring } from "./features/jobs/jobsStore"
import { startLibraryMonitoring } from "./features/library/libraryStore"
import { startVideoPrefsPersistence } from "./features/media/videoPrefsPersistence"
import { startPreviewTracking } from "./features/preview/previewStore"
import { startShortcutPersistence } from "./features/shortcuts/shortcutStore"
import { startThumbMonitoring } from "./features/previews/thumbStore"
import { startCoverMonitoring } from "./features/previews/coverStore"
import { startViewerImageMonitoring } from "./features/viewer/viewerImages"
import { startSidecarMonitoring } from "./features/system/sidecarStore"
import { startStartupFolder } from "./features/settings/startupFolder"
import { startViewerSettingsPersistence } from "./features/settings/settingsStore"
import { initTheme } from "./features/theme/themeStore"
import { initInterfaceSize } from "./features/theme/interfaceSizeStore"
import { startTreeMonitoring } from "./features/tree/treeStore"
import { startWorkspacePersistence } from "./features/workspace/workspace"
import "./styles/index.css"

initTheme()
initInterfaceSize()
startSidecarMonitoring()
startFolderMonitoring()
startJobMonitoring()
startThumbMonitoring()
startCoverMonitoring()
startViewerImageMonitoring()
startPreviewTracking()
startLibraryMonitoring()
startTreeMonitoring()
startWorkspacePersistence()
startShortcutPersistence()
startVideoPrefsPersistence()
startViewerSettingsPersistence()
startStartupFolder()

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
