import { cancelScan, hasFilters, isScanning, useFolderStore } from "../features/folder/folderStore"
import { plural } from "../lib/format"

/** One line of indexing state under the toolbar. */
export function FolderSummary() {
  const folder = useFolderStore((s) => s.folder)
  const progress = useFolderStore((s) => s.progress)
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const search = useFolderStore((s) => s.search)
  const filtered = useFolderStore(hasFilters)
  if (!folder) return null

  const scanning = isScanning(progress, folder)
  const parts: string[] = []
  const found = search
    ? `${plural(total, "result", "results")} for “${search}”`
    : plural(total, "item", "items")
  if (scanning) {
    parts.push(`Indexing… ${found} so far`)
  } else if (progress?.state === "cancelled") {
    parts.push(`Indexing stopped. ${plural(total, "item", "items")} found so far`)
  } else if (search) {
    parts.push(`${plural(total, "result", "results")} for “${search}”`)
  } else if (filtered) {
    parts.push(`${plural(total, "item", "items")} match the filters`)
  } else {
    parts.push(plural(total, "item", "items"))
  }
  if (progress && progress.skipped > 0) {
    parts.push(`${plural(progress.skipped, "other file", "other files")} not shown`)
  }
  if (progress && progress.errors > 0) {
    parts.push(`${plural(progress.errors, "folder", "folders")} couldn't be read`)
  }

  return (
    <div
      className="flex h-8 shrink-0 items-center gap-3 border-b border-border bg-chrome px-4 text-xs text-muted"
      data-testid="folder-summary"
    >
      <span role="status" aria-live="polite" className="tabular-nums">
        {parts.join(". ")}
      </span>
      {scanning && (
        <button
          type="button"
          className="rounded px-1 text-text hover:underline"
          onClick={() => void cancelScan()}
        >
          Stop
        </button>
      )}
    </div>
  )
}
