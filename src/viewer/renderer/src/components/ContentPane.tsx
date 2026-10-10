import { useEffect } from "react"
import { notify } from "../features/clipboard/clipboard"
import { isScanning, openFolderDialog, useFolderStore } from "../features/folder/folderStore"
import { useSidecarStore } from "../features/system/sidecarStore"
import { EmptyState } from "./EmptyState"
import { FolderSummary } from "./FolderSummary"
import { FolderToolbar } from "./FolderToolbar"
import { GridPlaceholder } from "./GridPlaceholder"
import { BatchBar } from "./jobs/BatchBar"
import { JobsPanel } from "./jobs/JobsPanel"
import { TileView } from "./tiles/TileView"

/**
 * A failed open keeps the current folder on screen; the error is announced
 * instead of replacing it.
 */
function useOpenErrorNotice(): void {
  const error = useFolderStore((s) => s.error)
  const hasItems = useFolderStore((s) => (s.query?.total ?? 0) > 0)
  useEffect(() => {
    if (error && hasItems) notify(error, "error")
  }, [error, hasItems])
}

function Body() {
  const state = useSidecarStore((s) => s.status?.state ?? null)
  const lastError = useSidecarStore((s) => s.status?.lastError ?? s.error)
  const folder = useFolderStore((s) => s.folder)
  const opening = useFolderStore((s) => s.opening)
  const error = useFolderStore((s) => s.error)
  const hasItems = useFolderStore((s) => (s.query?.total ?? 0) > 0)
  const scanning = useFolderStore((s) => isScanning(s.progress, s.folder))

  if (state === "failed") {
    return (
      <EmptyState
        tone="danger"
        title="The Panelyth backend stopped"
        description={
          lastError ??
          "The background service could not be started. Restart Panelyth; details are in the log."
        }
      />
    )
  }
  if (state !== "ready") return <GridPlaceholder />
  if (error && !hasItems) {
    return <EmptyState tone="danger" title="Couldn't open the folder" description={error} />
  }
  if (!folder) {
    return (
      <EmptyState
        title="No folder open"
        description="Open a folder to start browsing images and videos."
        action={
          <button
            type="button"
            className="h-8 rounded-md bg-accent px-3 text-xs text-accent-foreground"
            disabled={opening}
            onClick={() => void openFolderDialog()}
          >
            Open folder…
          </button>
        }
      />
    )
  }
  if (hasItems) return <TileView />
  if (scanning || opening) return <GridPlaceholder />
  return (
    <EmptyState
      title="No images or videos here"
      description="This folder has no supported images, videos or subfolders."
    />
  )
}

export function ContentPane() {
  useOpenErrorNotice()
  return (
    <main aria-label="Content" className="flex h-full min-h-0 min-w-0 flex-col">
      <FolderToolbar />
      <FolderSummary />
      {/* Canvas: the neutral field media is shown on. */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        <Body />
        <BatchBar />
        <JobsPanel />
      </div>
    </main>
  )
}
