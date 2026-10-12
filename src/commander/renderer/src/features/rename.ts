import type {
  JobSnapshot,
  RenamePlan,
  RenamePreviewResult,
  RenamePreviewRow,
  RenameUndoInfo,
  SelectionDescriptor,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { describeOperand } from "./compare"
import { inArchive, notice, operand, READ_ONLY, refusedOnConnection } from "./files"
import { marksDescriptor, markNone } from "./marks"
import type { Side } from "./panels"
import { ACTIVE, showDetails, useQueueStore } from "./queue"
import { msg, t } from "@panelyth/i18n"

// Multi-rename (Stage C09, CFR-22): Ctrl+M names the marked entries (or the
// cursor entry) with masks, search and replace, a case conversion and a
// counter. Go names the whole batch on every change (rename.preview) and
// returns the page the table shows; the same plan then runs as one
// multiRename job, and the last one can be undone (undoRename).

/** Rows per preview request; the table asks for the pages it shows. */
export const PREVIEW_PAGE = 200
/** Pages kept; the rest is asked for again when scrolled back to. */
const MAX_PAGES = 12

export const DEFAULT_PLAN: RenamePlan = {
  nameMask: "[N]",
  extMask: "[E]",
  search: "",
  replace: "",
  regex: false,
  matchCase: false,
  case: "",
  start: 1,
  step: 1,
  digits: 1,
}

/** Placeholder buttons of the mask fields (UX-DESIGN "Dialogs"). */
export const PLACEHOLDERS: readonly { text: string; label: string }[] = [
  { text: "[N]", label: msg("Name") },
  { text: "[N1-5]", label: msg("Part of the name") },
  { text: "[E]", label: msg("Extension") },
  { text: "[C]", label: msg("Counter") },
  { text: "[Y]-[M]-[D]", label: msg("Date") },
  { text: "[h][m][s]", label: msg("Time") },
]

export const CASES: readonly { value: RenamePlan["case"]; label: string }[] = [
  { value: "", label: msg("Unchanged") },
  { value: "lower", label: msg("all lowercase") },
  { value: "upper", label: msg("ALL UPPERCASE") },
  { value: "first", label: msg("First letter uppercase") },
  { value: "words", label: msg("First Letter Of Each Word") },
]

export type PlanField = "nameMask" | "extMask" | "search" | "case" | "counter"

export interface RenameDialogState {
  side: Side
  source: SelectionDescriptor
  /** "notes.txt" or "12 items". */
  what: string
  plan: RenamePlan
  /** The batch as Go last named it; null before the first answer. */
  counts: Omit<RenamePreviewResult, "rows" | "offset"> | null
  /** The plan cannot be compiled: the field and Go's reason. The rows shown are the last good ones. */
  problem: { field: PlanField | ""; message: string } | null
  /** Changes whenever preview rows arrived (they live outside React state). */
  revision: number
  /** What the last multi-rename left to undo. */
  undo: RenameUndoInfo | null
  busy: boolean
  error: string | null
}

interface RenameState {
  dialog: RenameDialogState | null
}

export const useRenameStore = create<RenameState>(() => ({ dialog: null }))

const set = useRenameStore.setState
const get = useRenameStore.getState

const errorText = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

// The preview's rows: pages of the current plan, outside React state. Rows of
// an older plan stay visible until their page is named again, so the table
// never blanks while typing.
interface Page {
  generation: number
  rows: RenamePreviewRow[]
}
const pages = new Map<number, Page>()
/** Changes with every plan (and every dialog). */
let generation = 0
/** Pages the table shows, wanted in the current generation. */
let wanted: number[] = []
/** The pages the table last asked for; a new plan names these first. */
let lastShown: number[] = [0]
let inFlight = false

function patch(change: Partial<RenameDialogState>): void {
  const d = get().dialog
  if (d) set({ dialog: { ...d, ...change } })
}

/** The row at a position, if its page is loaded (from the current plan or the one before). */
export function previewRow(index: number): RenamePreviewRow | undefined {
  return pages.get(Math.floor(index / PREVIEW_PAGE))?.rows[index % PREVIEW_PAGE]
}

/** Whether a row is of the current plan (an older one shows dimmed). */
export function previewRowCurrent(index: number): boolean {
  return pages.get(Math.floor(index / PREVIEW_PAGE))?.generation === generation
}

function needPreviewRows(first: number, last: number): void {
  if (!get().dialog) return
  const next: number[] = []
  for (let p = Math.floor(first / PREVIEW_PAGE); p <= Math.floor(last / PREVIEW_PAGE); p++) {
    if (pages.get(p)?.generation !== generation) next.push(p)
  }
  wanted = next
  void pump()
}

/**
 * One request at a time: while Go names a page, newer plans only replace
 * what is wanted next, so typing never queues requests.
 */
async function pump(): Promise<void> {
  if (inFlight) return
  const d = get().dialog
  const page = wanted.shift()
  if (!d || page === undefined) return
  inFlight = true
  const asked = generation
  try {
    const res = await bridge.renamePreview(d.source, d.plan, page * PREVIEW_PAGE, PREVIEW_PAGE)
    if (asked === generation && get().dialog) {
      pages.set(page, { generation: asked, rows: res.rows })
      // Keep the pages nearest to this one.
      if (pages.size > MAX_PAGES) {
        const far = [...pages.keys()].sort((a, b) => Math.abs(b - page) - Math.abs(a - page))
        for (const p of far.slice(0, pages.size - MAX_PAGES)) pages.delete(p)
      }
      const { rows: _rows, offset: _offset, ...counts } = res
      patch({ counts, problem: null, revision: get().dialog!.revision + 1 })
    }
  } catch (error) {
    if (asked === generation && get().dialog) {
      const details = error instanceof PanelythError ? (error.details as PlanDetails) : undefined
      if (details?.reason === "plan")
        patch({ problem: { field: details.field ?? "", message: errorText(error) } })
      else patch({ error: previewError(error, details?.reason) })
      wanted = []
    }
  } finally {
    inFlight = false
  }
  // A newer plan, or another page of this one.
  if (get().dialog && wanted.length > 0) void pump()
}

interface PlanDetails {
  reason?: string
  field?: PlanField
}

function previewError(error: unknown, reason?: string): string {
  if (reason === "tooMany") return t("Multi-rename takes at most 100,000 entries at a time.")
  return errorText(error)
}

/** Ctrl+M: opens the tool for the marks, or the cursor entry. */
export function openMultiRename(side: Side): void {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t(READ_ONLY))
    return
  }
  const source = operand(side)
  if (!source) return
  pages.clear()
  generation++
  wanted = [0]
  set({
    dialog: {
      side,
      source,
      what: describeOperand(side, source),
      plan: DEFAULT_PLAN,
      counts: null,
      problem: null,
      revision: 0,
      undo: null,
      busy: false,
      error: null,
    },
  })
  void pump()
  void refreshUndo()
}

async function refreshUndo(): Promise<void> {
  try {
    const undo = await bridge.renameUndoInfo()
    patch({ undo: undo.count > 0 ? undo : null })
  } catch {
    // The button stays hidden.
  }
}

/** A field changed: every page is of an older plan now; the shown ones are named again. */
export function updatePlan(change: Partial<RenamePlan>): void {
  const d = get().dialog
  if (!d) return
  generation++
  const shown = [...new Set([...wanted, ...lastShown])]
  wanted = shown.length > 0 ? shown : [0]
  set({ dialog: { ...d, plan: { ...d.plan, ...change }, error: null } })
  void pump()
}

/** The table shows rows first..last: their pages are named if they are not current. */
export function showPreviewRows(first: number, last: number): void {
  lastShown = []
  for (let p = Math.floor(first / PREVIEW_PAGE); p <= Math.floor(last / PREVIEW_PAGE); p++)
    lastShown.push(p)
  needPreviewRows(first, last)
}

export function closeMultiRename(): void {
  generation++
  pages.clear()
  wanted = []
  lastShown = [0]
  set({ dialog: null })
}

/** Start: the plan the preview shows runs as one job in the queue. */
export async function startMultiRename(): Promise<boolean> {
  const d = get().dialog
  if (!d || d.busy) return false
  patch({ busy: true, error: null })
  try {
    const job = await bridge.startJob({
      kind: "multiRename",
      source: { selection: d.source },
      plan: d.plan,
    })
    watch(job.jobId, "multiRename")
  } catch (error) {
    const details = error instanceof PanelythError ? (error.details as PlanDetails) : undefined
    if (details?.reason === "plan")
      patch({ busy: false, problem: { field: details.field ?? "", message: errorText(error) } })
    else patch({ busy: false, error: errorText(error) })
    return false
  }
  const marked = marksDescriptor(d.side) !== null
  closeMultiRename()
  if (marked) markNone(d.side)
  notice(t("Renaming {what}; progress is in the queue (Ctrl+J).", { what: d.what }))
  return true
}

/** Undo last: from the dialog's button, or as a command of its own. */
export async function undoMultiRename(): Promise<boolean> {
  try {
    const info = await bridge.renameUndoInfo()
    if (info.count === 0) {
      notice(t("There is no multi-rename to undo."))
      patch({ undo: null })
      return false
    }
    const job = await bridge.startJob({ kind: "undoRename" })
    watch(job.jobId, "undoRename")
    notice(
      t("Undoing the rename of {count, plural, one {# item} other {# items}}…", {
        count: info.count,
      }),
    )
  } catch (error) {
    if (get().dialog) patch({ error: errorText(error) })
    else notice(errorText(error))
    return false
  }
  if (get().dialog) closeMultiRename()
  return true
}

type Watched = "multiRename" | "undoRename" | "setAttributes"

/** Jobs started here, announced when they end. */
const watched = new Map<number, Watched>()

/** Follows a job to its end; one that ended before it was watched is taken from the queue. */
export function watch(jobId: number, kind: Watched): void {
  watched.set(jobId, kind)
  const known = useQueueStore.getState().jobs.find((j) => j.jobId === jobId)
  if (known && !ACTIVE.has(known.state)) onWatchedJob(known)
}

/** What a finished job did, for the status line. */
export function renameResult(kind: Watched, job: JobSnapshot): string {
  if (job.state === "cancelled")
    return t("Stopped after {done} of {total}.", { done: job.done, total: job.total })
  if (job.state === "failed") return job.error || t("The operation failed.")
  const count = job.done
  const rest = { done: job.done, total: job.total }
  switch (kind) {
    case "multiRename":
      return job.failed === 0
        ? t("Renamed {count, plural, one {# item} other {# items}}.", { count })
        : t(
            "Renamed {done} of {total, plural, one {# item} other {# items}}; the rest is listed.",
            rest,
          )
    case "undoRename":
      return job.failed === 0
        ? t("{count, plural, one {# name is} other {# names are}} back.", { count })
        : t(
            "{done} of {total, plural, one {# name is} other {# names are}} back; the rest is listed.",
            rest,
          )
    case "setAttributes":
      return job.failed === 0
        ? t("Changed {count, plural, one {# item} other {# items}}.", { count })
        : t(
            "Changed {done} of {total, plural, one {# item} other {# items}}; the rest is listed.",
            rest,
          )
  }
}

function onWatchedJob(job: JobSnapshot): void {
  const kind = watched.get(job.jobId)
  if (!kind || ACTIVE.has(job.state)) return
  watched.delete(job.jobId)
  notice(renameResult(kind, job))
  // What was not renamed or changed is the result list.
  if (job.failed > 0) void showDetails(job.jobId)
}

/** Follows the jobs started from the multi-rename and attribute dialogs. */
export function startRenameEvents(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return bridge.on("job.progress", onWatchedJob)
}

/** Tests. */
export function resetRename(): void {
  generation++
  pages.clear()
  wanted = []
  lastShown = [0]
  inFlight = false
  watched.clear()
  set({ dialog: null })
}
