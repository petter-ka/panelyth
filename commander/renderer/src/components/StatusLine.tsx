import type { Volume } from "@fastview/contracts"
import { useEffect, useState } from "react"
import { formatBytes, formatCount } from "../features/format"
import { stopListing, useListingStore, volumeOf } from "../features/listing"
import type { Side } from "../features/panels"

/**
 * "1,204 entries · 120.5 GB free of 931.5 GB"; while the folder is listed:
 * "Listing… 12,400 entries so far" with Stop. Marked counts arrive in C02.
 */
export function StatusLine({ side }: { side: Side }) {
  const total = useListingStore((s) => s[side].query?.total ?? 0)
  const crumbs = useListingStore((s) => s[side].crumbs)
  const progress = useListingStore((s) => s[side].progress)
  // The volume found for these crumbs; a stale answer for other crumbs is ignored.
  const [found, setFound] = useState<{ crumbs: unknown; volume: Volume | null } | null>(null)
  const volume = found?.crumbs === crumbs ? found.volume : null

  useEffect(() => {
    if (crumbs.length === 0) return
    let live = true
    void volumeOf(crumbs).then((v) => live && setFound({ crumbs, volume: v }))
    return () => {
      live = false
    }
  }, [crumbs])

  const listing = progress?.state === "running"
  return (
    <div
      className="flex h-6 shrink-0 items-center gap-2 border-t border-border bg-chrome px-2 text-[0.6875rem] text-muted tabular-nums"
      data-testid={`status-${side}`}
      aria-live="polite"
    >
      {listing ? (
        <>
          <span>Listing… {formatCount(Math.max(total, progress.entries))} entries so far</span>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => stopListing(side)}
            className="rounded px-1 text-text hover:bg-raised"
          >
            Stop
          </button>
        </>
      ) : (
        <span>
          {formatCount(total)} {total === 1 ? "entry" : "entries"}
        </span>
      )}
      <span className="flex-1" />
      {volume?.freeBytes !== undefined && (
        <span data-testid={`free-${side}`}>
          {formatBytes(volume.freeBytes)} free
          {volume.totalBytes ? ` of ${formatBytes(volume.totalBytes)}` : ""}
        </span>
      )}
    </div>
  )
}
