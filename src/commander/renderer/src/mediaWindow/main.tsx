import { startVideoPrefsPersistence, startViewerImageMonitoring } from "@panelyth/media-ui"
import { initInterfaceSize, initTheme } from "@panelyth/ui"
import { initLocale, LocaleBoundary } from "@panelyth/i18n"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { configureCommanderMedia } from "../features/media"
import { MediaWindowApp } from "./MediaWindowApp"
import "../styles.css"

// The full-screen media window's page (media.html, ADR-0033 amended). It
// shares the commander's origin, so the stored language and theme apply as
// they do in the commander; nothing else of the commander is started.
await initLocale()
initTheme()
initInterfaceSize()
configureCommanderMedia()
startViewerImageMonitoring()
// Mute, volume and repeat are the same here as in the apps.
startVideoPrefsPersistence()

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <MediaWindowApp />
    </LocaleBoundary>
  </StrictMode>,
)
