import type { SelectionInfo } from "@panelyth/contracts"
import { hasMarks, markCount } from "@panelyth/renderer-core"
import { useEffect, useState } from "react"
import { bridge, isBridgeAvailable } from "../bridge"
import { formatBytes, formatCount } from "../features/format"
import { stopListing, useListingStore } from "../features/listing"
import { marksDescriptor, useMarksStore } from "../features/marks"
import type { Side } from "../features/panels"
import { isRunning, stopSizes, useSizeJobs } from "../features/sizes"
import { usePanelVolume } from "./DriveBar"
import { t } from "@panelyth/i18n"

/** Marked sizes are asked of Go at most this often while marks change. */
const INFO_DELAY_MS = 150

/**
 * "2 of 1,204 marked · 4.4 MB of 2.4 GB" plus free space; while the folder
 * is listed: "Listing… 12,400 entries so far" with Stop; while folder sizes
 * are calculated: "Calculating folder sizes…" with Stop.
 */
export function StatusLine({ side }: { side: Side }) {
  const total = useListingStore((s) => s[side].query?.total ?? 0)
  const query = useListingStore((s) => s[side].query)
  const progress = useListingStore((s) => s[side].progress)
  const marks = useMarksStore((s) => s[side])
  const sizeJob = useSizeJobs((s) => s[side])

  const volume = usePanelVolume(side)

  // Sizes of the marks and of the whole listing, from Go (debounced).
  const [sizes, setSizes] = useState<{
    key: unknown
    marked: SelectionInfo | null
    all: number
  } | null>(null)
  useEffect(() => {
    if (!query || !isBridgeAvailable() || query.total === 0) return
    let live = true
    const timer = setTimeout(() => {
      const all = {
        queryId: query.queryId,
        version: query.version,
        ranges: [[0, query.total]] as [number, number][],
        include: [],
        exclude: [],
      }
      const d = marksDescriptor(side)
      void Promise.all([
        bridge.selectionInfo(all),
        d ? bridge.selectionInfo(d) : Promise.resolve(null),
      ])
        .then(([a, m]) => live && setSizes({ key: marks, marked: m, all: a.bytes }))
        .catch(() => undefined)
    }, INFO_DELAY_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, marks, side])
  const shown = sizes?.key === marks ? sizes : null

  const listing = progress?.state === "running"
  const marked = hasMarks(marks) ? markCount(marks) : 0
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-chrome px-2 text-2xs text-muted prose-nums"
      data-testid={`status-${side}`}
      aria-live="polite"
    >
      {listing ? (
        <>
          <span>
            {t("Listing… {count} entries so far", {
              count: formatCount(Math.max(total, progress.entries)),
            })}
          </span>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => stopListing(side)}
            className="h-5 min-h-[20px] rounded px-1.5 text-text hover:bg-raised"
          >
            {t("Stop")}
          </button>
        </>
      ) : marked > 0 ? (
        <span data-testid={`marked-${side}`}>
          {t("{marked} of {total} marked", {
            marked: formatCount(marked),
            total: formatCount(total),
          })}
          {shown?.marked &&
            ` · ${t("{current} of {total}", { current: formatBytes(shown.marked.bytes), total: formatBytes(shown.all) })}`}
        </span>
      ) : (
        <span>
          {t("{count, plural, one {# entry} other {# entries}}", { count: total })}
          {shown && total > 0 && ` · ${formatBytes(shown.all)}`}
        </span>
      )}
      {isRunning(sizeJob) && (
        <>
          <span>· {t("Calculating folder sizes…")}</span>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => stopSizes(side)}
            className="h-5 min-h-[20px] rounded px-1.5 text-text hover:bg-raised"
          >
            {t("Stop")}
          </button>
        </>
      )}
      <span className="flex-1" />
      {volume?.freeBytes !== undefined && (
        <span data-testid={`free-${side}`}>
          {volume.totalBytes
            ? t("{free} free of {total}", {
                free: formatBytes(volume.freeBytes),
                total: formatBytes(volume.totalBytes),
              })
            : t("{free} free", { free: formatBytes(volume.freeBytes) })}
        </span>
      )}
    </div>
  )
}
