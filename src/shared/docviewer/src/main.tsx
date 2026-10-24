import type { DocumentFrameApi } from "@panelyth/contracts"
import { applyLocale, isLocale, LocaleBoundary } from "@panelyth/i18n"
import { connectWindowFrame } from "@panelyth/ui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { applyTheme, parseParams } from "./params"
import "./styles.css"

const params = parseParams(location.hash)
// The language the commander was in when it opened the window (ADR-0034).
if (isLocale(params?.lang)) await applyLocale(params.lang, false)
applyTheme(params?.theme ?? null)
if (params) document.title = params.name

// The title strip's window buttons (ADR-0045): the frame-only preload on Windows;
// elsewhere there is no bridge at all, and the OS draws the frame.
const frame = (window as { panelyth?: DocumentFrameApi }).panelyth
if (frame) {
  connectWindowFrame({
    titleBar: frame.frame.titleBar,
    state: async () => {
      const r = await frame.frame.state()
      if (!r.ok) throw new Error(r.e.message)
      return r.r
    },
    control: async (action) => {
      await frame.frame.control(action)
    },
    onState: (listener) => frame.onEvent("window.state", listener),
    // A window of its own is always the one on screen.
    onShown: () => () => undefined,
  })
}

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <App params={params} />
    </LocaleBoundary>
  </StrictMode>,
)
