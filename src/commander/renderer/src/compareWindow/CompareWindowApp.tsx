import { t } from "@panelyth/i18n"
import { TitleBar, TooltipProvider } from "@panelyth/ui"
import { useEffect } from "react"
import { CompareManyView } from "../components/CompareManyDialog"
import { DiffView } from "../components/DiffDialog"
import { SyncView } from "../components/SyncDialog"
import {
  closeCompareMany,
  closeDiff,
  closeSync,
  openDiff,
  showMany,
  showSync,
  useCompareStore,
  type DiffSide,
  type ManyQueries,
  type SyncRoot,
} from "../features/compare"
import { useFilesStore } from "../features/files"
import type { Side } from "../features/panels"

/** What main named in the window's fragment (compareWindowUrl). */
export type CompareRequest =
  | { view: "files"; left: DiffSide; right: DiffSide }
  | {
      view: "many"
      jobId: number
      side: Side
      count: number
      folder: string
      queries: ManyQueries
    }
  | { view: "sync"; left: SyncRoot; right: SyncRoot }

const idOf = (v: string | null): number | null => {
  const n = Number(v)
  return v !== null && Number.isSafeInteger(n) && n > 0 ? n : null
}

/** The comparison the fragment asks for; null for anything else. */
export function compareRequestOf(hash = window.location.hash): CompareRequest | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""))
  switch (p.get("view")) {
    case "files": {
      const l = idOf(p.get("l"))
      const r = idOf(p.get("r"))
      if (l === null || r === null) return null
      return {
        view: "files",
        left: { id: l, name: p.get("ln") ?? "" },
        right: { id: r, name: p.get("rn") ?? "" },
      }
    }
    case "many": {
      const jobId = idOf(p.get("job"))
      const mine = idOf(p.get("mq"))
      const theirs = idOf(p.get("tq"))
      const side = p.get("side")
      if (jobId === null || mine === null || theirs === null) return null
      if (side !== "left" && side !== "right") return null
      return {
        view: "many",
        jobId,
        side,
        count: idOf(p.get("count")) ?? 0,
        folder: p.get("folder") ?? "",
        queries: { mine, theirs },
      }
    }
    case "sync":
      return {
        view: "sync",
        left: { path: p.get("lp") ?? "", dirId: idOf(p.get("ld")) },
        right: { path: p.get("rp") ?? "", dirId: idOf(p.get("rd")) },
      }
  }
  return null
}

/** Shows the comparison in this page's store; the window renders it. */
export function startCompareRequest(request: CompareRequest): void {
  switch (request.view) {
    case "files":
      void openDiff(request.left, request.right)
      return
    case "many":
      showMany({
        side: request.side,
        count: request.count,
        folder: request.folder,
        queries: request.queries,
        jobId: request.jobId,
      })
      return
    case "sync":
      showSync(request.left, request.right)
  }
}

/** What Esc and the views' Close do: a pair opened from the list goes back to it. */
function closeTop(): void {
  const s = useCompareStore.getState()
  if (s.diff) closeDiff()
  else if (s.many) closeCompareMany()
  else if (s.sync) closeSync()
}

/** Lets go of what the window holds in Go: its diff, its compare job, its directory compare. */
export function releaseCompare(): void {
  closeDiff()
  closeCompareMany()
  closeSync()
}

function titleOf(s: ReturnType<typeof useCompareStore.getState>): string {
  if (s.diff) return `${s.diff.left.name} ↔ ${s.diff.right.name} – ${t("Compare by content")}`
  if (s.sync) return t("Synchronize directories")
  return t("Compare by content")
}

/**
 * A comparison in a window of its own (ADR-0048): the two files side by
 * side, the result list of several compared files (Enter shows a pair here,
 * Back to the list returns), or Synchronize directories. The views are the
 * dialogs' own, filling the window; the window closes with its comparison
 * (Close, Esc, a synchronization that started).
 */
export function CompareWindowApp() {
  const shown = useCompareStore((s) => s.diff !== null || s.many !== null || s.sync !== null)
  const view = useCompareStore((s) => (s.diff ? "diff" : s.many ? "many" : s.sync ? "sync" : null))
  const title = useCompareStore(titleOf)
  const notice = useFilesStore((s) => s.notice)
  useEffect(() => {
    if (!shown) window.close()
  }, [shown])
  useEffect(() => {
    document.title = title
  }, [title])
  // Esc closes what is on top, as it closed the dialog; a field or menu that
  // handles Esc itself keeps it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      closeTop()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <TooltipProvider>
      <div
        className="glass-page flex h-full min-h-0 flex-col bg-chrome text-text"
        data-testid="compare-window"
      >
        <TitleBar title={title} rail={false} mark />
        <main className="flex min-h-0 flex-1 flex-col p-3">
          {view === "diff" ? (
            <DiffView fill />
          ) : view === "many" ? (
            <CompareManyView fill />
          ) : view === "sync" ? (
            <SyncView fill />
          ) : null}
        </main>
        {notice && (
          <p role="status" className="truncate border-t border-border px-3 py-1 text-xs text-muted">
            {notice}
          </p>
        )}
      </div>
    </TooltipProvider>
  )
}
