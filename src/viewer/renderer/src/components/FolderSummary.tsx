import { cancelScan, hasFilters, isScanning, useFolderStore } from "../features/folder/folderStore"
import { t } from "@panelyth/i18n"

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
  const items = t("{count, plural, one {# item} other {# items}}", { count: total })
  const results = t("{count, plural, one {# result} other {# results}} for “{search}”", {
    count: total,
    search,
  })
  if (scanning) {
    parts.push(
      t("Indexing… {found} so far", {
        found: search ? results : items,
      }),
    )
  } else if (progress?.state === "cancelled") {
    parts.push(
      t("Indexing stopped. {count, plural, one {# item} other {# items}} found so far", {
        count: total,
      }),
    )
  } else if (search) {
    parts.push(results)
  } else if (filtered) {
    parts.push(
      t("{count, plural, one {# item matches} other {# items match}} the filters", {
        count: total,
      }),
    )
  } else {
    parts.push(items)
  }
  if (progress && progress.skipped > 0) {
    parts.push(
      t("{count, plural, one {# other file} other {# other files}} not shown", {
        count: progress.skipped,
      }),
    )
  }
  if (progress && progress.errors > 0) {
    parts.push(
      t("{count, plural, one {# folder} other {# folders}} couldn't be read", {
        count: progress.errors,
      }),
    )
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
          {t("Stop")}
        </button>
      )}
    </div>
  )
}
