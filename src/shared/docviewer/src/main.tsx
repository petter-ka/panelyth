import { applyLocale, isLocale, LocaleBoundary } from "@panelyth/i18n"
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

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <LocaleBoundary>
      <App params={params} />
    </LocaleBoundary>
  </StrictMode>,
)
