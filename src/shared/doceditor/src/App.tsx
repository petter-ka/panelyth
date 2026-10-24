import { t } from "@panelyth/i18n"
import { TitleBar } from "@panelyth/ui"
import { useLayoutEffect, useRef } from "react"
import { Dialogs } from "./components/Dialogs"
import { DiskBanner } from "./components/DiskBanner"
import { ExportDialog } from "./components/ExportDialog"
import { Header } from "./components/Header"
import { StatusBar } from "./components/StatusBar"
import { useStore } from "./store"
import type { Workspace } from "./workspace"

/**
 * Places the editor's element, made outside React. A remount (a new
 * language remounts the tree) moves the same element, so the document, the
 * undo history and the scroll position stay.
 */
function EditorHost({ workspace }: { workspace: Workspace }) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = host.current
    if (!node) return
    // The editor and (Markdown) the preview: one of them is hidden.
    node.append(workspace.element, workspace.previewElement)
    workspace.editor.view.requestMeasure()
    return () => {
      for (const el of [workspace.element, workspace.previewElement])
        if (el.parentNode === node) node.removeChild(el)
    }
  }, [workspace])
  const readOnly = useStore(workspace.chrome, (s) => s.readOnly)
  return (
    <div
      ref={host}
      className="min-h-0 flex-1 font-mono"
      data-testid="editor-host"
      data-readonly={readOnly ? "true" : "false"}
    />
  )
}

export function App({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex h-full flex-col bg-canvas text-text">
      {/* The window's title strip (ADR-0045): no height where the OS draws the frame. */}
      <TitleBar title={workspace.session.name} rail={false} mark />
      <Header workspace={workspace} />
      <DiskBanner workspace={workspace} />
      <EditorHost workspace={workspace} />
      <StatusBar workspace={workspace} />
      <Dialogs workspace={workspace} />
      <ExportDialog workspace={workspace} />
    </div>
  )
}

/** The window could not open its file (no session, the read failed). */
export function OpenError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col bg-canvas text-text">
      <TitleBar title="Panelyth" rail={false} mark />
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <p role="alert" className="max-w-md text-center text-sm text-muted">
          {message || t("The file could not be opened.")}
        </p>
      </div>
    </div>
  )
}
