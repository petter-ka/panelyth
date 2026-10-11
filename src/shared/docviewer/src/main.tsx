import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { applyTheme, parseParams } from "./params"
import "./styles.css"

const params = parseParams(location.hash)
applyTheme(params?.theme ?? null)
if (params) document.title = params.name

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
createRoot(root).render(
  <StrictMode>
    <App params={params} />
  </StrictMode>,
)
