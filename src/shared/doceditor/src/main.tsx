import { applyLocale, isLocale, LocaleBoundary, t } from "@panelyth/i18n"
import { unwrap } from "@panelyth/renderer-core"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App, OpenError } from "./App"
import { applyStyle, applyTheme } from "./appearance"
import { bridge } from "./bridge"
import { connectFrame } from "./frame"
import { readSessionText } from "./text/read"
import { createWorkspace } from "./workspace"
import "./styles.css"

// The text editor window (ADR-0046): its session (the file's name, encoding
// and read token), the theme and language for the first paint, the text read
// once through the token, then the editor. React renders only the chrome.

const root = document.getElementById("root")
if (!root) throw new Error("#root missing")
const reactRoot = createRoot(root)

// The title strip first: even a window that cannot open its file can be closed by it.
const frameApi = bridge.isAvailable() ? bridge.api() : null
if (frameApi?.frame) connectFrame(frameApi)

async function open(): Promise<void> {
  performance.mark("doceditor:start")
  const api = bridge.api()
  const session = await unwrap(() => api.session())
  if (isLocale(session.lang)) await applyLocale(session.lang, false)
  const dark = applyTheme(session.theme)
  applyStyle(session.style)
  const text = await readSessionText(session)
  performance.mark("doceditor:read")
  const workspace = createWorkspace({ api, session, text, dark })
  performance.mark("doceditor:editor")
  performance.measure("doceditor:open", "doceditor:start", "doceditor:editor")
  reactRoot.render(
    <StrictMode>
      <LocaleBoundary>
        <App workspace={workspace} />
      </LocaleBoundary>
    </StrictMode>,
  )
  requestAnimationFrame(() => workspace.focus())
}

open().catch((error: unknown) => {
  applyTheme(null)
  applyStyle(null)
  reactRoot.render(
    <LocaleBoundary>
      <OpenError
        message={
          error instanceof Error
            ? error.message
            : t("This window was not opened for a file to edit.")
        }
      />
    </LocaleBoundary>,
  )
})
