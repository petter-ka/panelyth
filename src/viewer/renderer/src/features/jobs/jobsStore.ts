import type {
  ClipState,
  JobKind,
  JobSnapshot,
  JobStartParams,
  SelectionDescriptor,
} from "@panelyth/contracts"
import { isSelectionDescriptor } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, PanelythError, isBridgeAvailable } from "../../bridge"
import { formatCount } from "../../lib/format"
import { useFolderStore } from "../folder/folderStore"
import { useSettingsStore } from "../settings/settingsStore"
import { labelName } from "../labels/labels"
import { singleSelectedId } from "../properties/propertiesStore"
import { getItem } from "../tiles/pageStore"
import { selectionCount, toDescriptor, useSelectionStore } from "../tiles/selectionStore"
import { msg, t } from "@panelyth/i18n"

/**
 * Batch operations (ADR-0021). Go runs the jobs and pushes coalesced
 * job.progress snapshots (≤ 4 Hz per job), so this store holds one small
 * snapshot per job, never per-item state. Items are always sent as a
 * selection descriptor; the renderer never builds id lists.
 */

export type JobDialog =
  | { kind: "rename"; id: number; name: string; isDir: boolean }
  | { kind: "batchRename"; selection: SelectionDescriptor; count: number; samples: Sample[] }
  | {
      kind: "replacePaste"
      destination: string
      folderName: string
      count: number
      mode: "copy" | "cut"
    }
  | {
      kind: "dropTransfer"
      selection: SelectionDescriptor
      count: number
      destination: string
      folderName: string
    }
  | { kind: "delete"; selection: SelectionDescriptor; count: number }
  | { kind: "tag"; selection: SelectionDescriptor; count: number }
  | { kind: "errors"; jobId: number }

/** A selected item shown in the batch-rename preview. */
export interface Sample {
  name: string
  isDir: boolean
}

interface JobsState {
  /** Active and recently finished jobs, oldest first. */
  jobs: JobSnapshot[]
  /** Edit jobs whose results were sent to the trash again (Stage 16). */
  undone: ReadonlySet<number>
  /** Job ids the user closed in the panel. */
  dismissed: ReadonlySet<number>
  /** What the job does in words ("Copying 12 items to Trip"), by job id. */
  labels: ReadonlyMap<number, string>
  clip: ClipState
  dialog: JobDialog | null
  /** Last start failure (BUSY, invalid input…), shown in the panel. */
  error: string | null
}

const initial = (): JobsState => ({
  jobs: [],
  undone: new Set(),
  dismissed: new Set(),
  labels: new Map(),
  clip: { mode: "", count: 0 },
  dialog: null,
  error: null,
})

export const useJobsStore = create<JobsState>(initial)

const set = useJobsStore.setState
const get = useJobsStore.getState

export function resetJobsStore(): void {
  set(initial(), true)
}

export function isActive(job: JobSnapshot): boolean {
  return job.state !== "completed" && job.state !== "cancelled" && job.state !== "failed"
}

/** Jobs the panel shows: active ones and finished ones not yet dismissed. */
export function visibleJobs(jobs: JobSnapshot[], dismissed: ReadonlySet<number>): JobSnapshot[] {
  return jobs.filter((j) => isActive(j) || !dismissed.has(j.jobId))
}

function upsert(snap: JobSnapshot): void {
  set((s) => {
    const i = s.jobs.findIndex((j) => j.jobId === snap.jobId)
    if (i >= 0) {
      const current = s.jobs[i]!
      // Out-of-order safety: a finished job never goes back to running.
      if (!isActive(current) && isActive(snap)) return s
      const jobs = s.jobs.slice()
      jobs[i] = snap
      return { jobs }
    }
    // Keep the list short: drop the oldest finished jobs beyond 20.
    const jobs = [...s.jobs, snap].sort((a, b) => a.jobId - b.jobId)
    while (jobs.length > 20) {
      const k = jobs.findIndex((j) => !isActive(j))
      if (k < 0) break
      jobs.splice(k, 1)
    }
    return { jobs }
  })
  if (snap.state === "completed" && snap.kind === "move") void refreshClip()
}

// What each kind of job does, with the item count; main's job list names
// jobs started before a reload this way.
const KIND_LABEL: Record<JobKind, string> = {
  copy: msg("Copying {count, plural, one {# item} other {# items}}"),
  move: msg("Moving {count, plural, one {# item} other {# items}}"),
  trash: msg("Moving to trash {count, plural, one {# item} other {# items}}"),
  delete: msg("Deleting {count, plural, one {# item} other {# items}}"),
  rename: msg("Renaming {count, plural, one {# item} other {# items}}"),
  favorite: msg("Updating favorites {count, plural, one {# item} other {# items}}"),
  rating: msg("Rating {count, plural, one {# item} other {# items}}"),
  label: msg("Labeling {count, plural, one {# item} other {# items}}"),
  tag: msg("Tagging {count, plural, one {# item} other {# items}}"),
  dirSize: msg("Calculating folder sizes {count, plural, one {# item} other {# items}}"),
  // The commander's archive jobs (Stage C07), shown when they reach this queue.
  extract: msg("Extracting {count, plural, one {# item} other {# items}}"),
  pack: msg("Packing {count, plural, one {# item} other {# items}}"),
  testArchive: msg("Testing {count, plural, one {# item} other {# items}}"),
  // The commander's compare jobs (Stage C08), likewise.
  sync: msg("Synchronizing {count, plural, one {# item} other {# items}}"),
  hashCreate: msg("Creating checksums for {count, plural, one {# item} other {# items}}"),
  hashVerify: msg("Verifying {count, plural, one {# item} other {# items}}"),
  compareFiles: msg("Comparing two files by content"),
  // The commander's rename and attribute jobs (Stage C09), likewise.
  multiRename: msg("Renaming {count, plural, one {# item} other {# items}}"),
  undoRename: msg("Undoing the rename of {count, plural, one {# item} other {# items}}"),
  setAttributes: msg("Changing attributes of {count, plural, one {# item} other {# items}}"),
  // The commander's transfers to and from FTP servers (Stage C10.5), likewise.
  download: msg("Downloading {count, plural, one {# item} other {# items}}"),
  upload: msg("Uploading {count, plural, one {# item} other {# items}}"),
  remoteDelete: msg("Deleting {count, plural, one {# item} other {# items}} on the server"),
  // The image editor's save (Stage 12); its count is the save's steps.
  editSave: msg("Saving an edited picture"),
  // A recipe run over a selection, and its undo (Stage 16).
  edit: msg("Editing {count, plural, one {# picture} other {# pictures}}"),
  undoEdit: msg("Removing {count, plural, one {# edited picture} other {# edited pictures}}"),
}

export function jobLabel(s: JobsState, job: JobSnapshot): string {
  const known = s.labels.get(job.jobId)
  if (known) return known
  const action = t(KIND_LABEL[job.kind], { count: job.total })
  return job.destination
    ? t("{action} to {destination}", { action, destination: job.destination })
    : action
}

function describe(error: unknown): string {
  if (error instanceof PanelythError) {
    if (error.code === "BUSY") return t("Too many operations are waiting. Try again in a moment.")
    if (error.code === "NOT_FOUND") return t("The folder changed. Select the items again.")
    return error.message
  }
  return String(error)
}

/** The current selection as a descriptor, or null when nothing is selected. */
export function currentSelection(): { selection: SelectionDescriptor; count: number } | null {
  const query = useFolderStore.getState().query
  const sel = useSelectionStore.getState()
  const count = selectionCount(sel)
  if (!query || count === 0) return null
  return { selection: toDescriptor(sel, query.queryId, query.version), count }
}

export const SELECTION_DRAG_TYPE = "application/x-panelyth-selection"

/** Adds the current selection descriptor to an internal tile drag. */
export function beginSelectionDrag(dataTransfer: DataTransfer): boolean {
  const cur = currentSelection()
  if (!cur) return false
  dataTransfer.setData(SELECTION_DRAG_TYPE, JSON.stringify(cur.selection))
  dataTransfer.effectAllowed = "copyMove"
  return true
}

export function canAcceptSelectionDrop(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(SELECTION_DRAG_TYPE)
}

/** Opens the copy/move confirmation for a validated internal drag payload. */
export function askDropTransfer(payload: string, destination: string, folderName: string): void {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return
  }
  if (!isSelectionDescriptor(value)) return
  const count =
    value.ranges.reduce((sum, [start, end]) => sum + end - start, 0) +
    value.include.length -
    value.exclude.length
  if (!Number.isSafeInteger(count) || count < 1) return
  set({ dialog: { kind: "dropTransfer", selection: value, count, destination, folderName } })
}

async function start(params: JobStartParams, label: string): Promise<void> {
  try {
    const snap = await bridge.startJob(params)
    set((s) => ({ labels: new Map(s.labels).set(snap.jobId, label), error: null }))
    upsert(snap)
  } catch (error) {
    set({ error: describe(error) })
  }
}

/** Shows a job another store started (the batch editor), under its own words. */
export function adoptJob(snap: JobSnapshot, label: string): void {
  set((s) => ({ labels: new Map(s.labels).set(snap.jobId, label), error: null }))
  upsert(snap)
}

/** "Undo this batch": the files an edit job created go to the trash; the originals stay. */
export async function undoBatch(job: JobSnapshot): Promise<void> {
  try {
    const snap = await bridge.batchUndo(job.jobId)
    set((s) => ({ undone: new Set(s.undone).add(job.jobId) }))
    adoptJob(
      snap,
      t("Removing {count, plural, one {# edited picture} other {# edited pictures}}", {
        count: snap.total,
      }),
    )
  } catch (error) {
    // Undone before, or the job's record is gone: the button goes either way.
    set((s) => ({
      undone: new Set(s.undone).add(job.jobId),
      error:
        error instanceof PanelythError && error.code === "NOT_FOUND"
          ? t("This batch can no longer be undone.")
          : describe(error),
    }))
  }
}

/** Shows the first result of an edit job in the system file manager. */
export async function revealBatch(jobId: number): Promise<void> {
  try {
    await bridge.editReveal(jobId)
  } catch (error) {
    set({ error: describe(error) })
  }
}

export async function confirmDropTransfer(
  selection: SelectionDescriptor,
  count: number,
  destination: string,
  folderName: string,
  kind: "copy" | "move",
): Promise<void> {
  closeJobDialog()
  await start(
    { kind, source: { selection }, destination, conflict: "keepBoth" },
    movingLabel(kind, count, folderName),
  )
}

/** "Copying 12 items to Trip" / "Moving …". */
function movingLabel(kind: "copy" | "move", count: number, folder: string): string {
  return kind === "copy"
    ? t("Copying {count, plural, one {# item} other {# items}} to {folder}", { count, folder })
    : t("Moving {count, plural, one {# item} other {# items}} to {folder}", { count, folder })
}

// Clipboard ----------------------------------------------------------------

export async function refreshClip(): Promise<void> {
  try {
    set({ clip: await bridge.clip() })
  } catch {
    // The clipboard is advisory UI state.
  }
}

/** Ctrl+C / Ctrl+X: the selection goes to the internal clipboard (held in Go). */
export async function copySelection(mode: "copy" | "cut"): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  try {
    set({ clip: await bridge.setClip(cur.selection, mode), error: null })
  } catch (error) {
    set({ error: describe(error) })
  }
}

/** Ctrl+V: copy or move the clipboard into the open folder (duplicates keep both names). */
export async function paste(): Promise<void> {
  const folder = useFolderStore.getState().folder
  const clip = get().clip
  if (!folder || clip.mode === "") return
  await pasteTo(folder.path, folder.name, clip, "keepBoth")
}

/** Paste with replacement, asking first when the viewer setting is enabled. */
export function pasteReplacing(): void {
  const folder = useFolderStore.getState().folder
  const clip = get().clip
  if (!folder || clip.mode === "") return
  if (useSettingsStore.getState().settings.confirmOverwrite) {
    set({
      dialog: {
        kind: "replacePaste",
        destination: folder.path,
        folderName: folder.name,
        count: clip.count,
        mode: clip.mode,
      },
    })
    return
  }
  void pasteTo(folder.path, folder.name, clip, "replace")
}

export async function confirmPasteReplacing(
  destination: string,
  folderName: string,
  count: number,
  mode: "copy" | "cut",
): Promise<void> {
  closeJobDialog()
  await pasteTo(destination, folderName, { mode, count }, "replace")
}

async function pasteTo(
  destination: string,
  folderName: string,
  clip: Pick<ClipState, "mode" | "count">,
  conflict: "keepBoth" | "replace",
): Promise<void> {
  try {
    const snap = await bridge.paste(destination, conflict)
    set((s) => ({
      labels: new Map(s.labels).set(
        snap.jobId,
        movingLabel(clip.mode === "cut" ? "move" : "copy", clip.count, folderName),
      ),
      error: null,
    }))
    upsert(snap)
  } catch (error) {
    set({ error: describe(error) })
  }
}

// Copy to / move to / delete ---------------------------------------------

/** "Copy to…" / "Move to…": picks a folder with the native dialog. */
export async function transferSelection(kind: "copy" | "move"): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  let destination: string | null
  try {
    destination = await bridge.openFolderDialog()
  } catch (error) {
    set({ error: describe(error) })
    return
  }
  if (!destination) return
  const name = destination.split(/[\\/]/).filter(Boolean).pop() ?? destination
  await start(
    { kind, source: { selection: cur.selection }, destination, conflict: "keepBoth" },
    movingLabel(kind, cur.count, name),
  )
}

/** Delete: to the OS trash, no confirmation (it can be undone there). */
export async function trashSelection(): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "trash", source: { selection: cur.selection } },
    t("Moving {count, plural, one {# item} other {# items}} to trash", { count: cur.count }),
  )
}

/** Shift+Delete: always asks first. */
export function askDeletePermanently(): void {
  const cur = currentSelection()
  if (cur) set({ dialog: { kind: "delete", ...cur } })
}

export async function deletePermanently(selection: SelectionDescriptor, count: number) {
  closeJobDialog()
  await start({ kind: "delete", source: { selection } }, t(KIND_LABEL.delete, { count }))
}

// Rename -------------------------------------------------------------------

const SAMPLES = 5

/** F2: one item renames inline in a dialog; several open the pattern rename. */
export function renameSelection(): void {
  const cur = currentSelection()
  if (!cur) return
  const id = singleSelectedId()
  if (cur.count === 1 && id !== null) {
    const item = findLoaded(id)
    if (item) set({ dialog: { kind: "rename", id, name: item.name, isDir: item.kind === "dir" } })
    return
  }
  const samples: Sample[] = []
  for (const [a, b] of cur.selection.ranges) {
    for (let i = a; i < b && samples.length < SAMPLES; i++) {
      const it = getItem(i)
      if (it && !cur.selection.exclude.includes(it.id))
        samples.push({ name: it.name, isDir: it.kind === "dir" })
    }
  }
  set({ dialog: { kind: "batchRename", ...cur, samples } })
}

function findLoaded(id: number) {
  const focus = useSelectionStore.getState().focusIndex
  const at = getItem(focus)
  if (at?.id === id) return at
  const sel = useSelectionStore.getState()
  const index = sel.include.get(id) ?? sel.ranges[0]?.[0]
  const item = index === undefined ? undefined : getItem(index)
  return item?.id === id ? item : undefined
}

/** Renames one entry; resolves to an error message, or null on success. */
export async function renameOne(id: number, name: string): Promise<string | null> {
  try {
    await bridge.rename(id, name)
    return null
  } catch (error) {
    return describe(error)
  }
}

export async function batchRename(
  selection: SelectionDescriptor,
  count: number,
  pattern: string,
  first: number,
): Promise<void> {
  closeJobDialog()
  await start(
    { kind: "rename", source: { selection }, pattern, start: first },
    t(KIND_LABEL.rename, { count }),
  )
}

// User metadata --------------------------------------------------------------

export async function setFavorite(favorite: boolean): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "favorite", source: { selection: cur.selection }, favorite },
    favorite
      ? t("Adding {count, plural, one {# file} other {# files}} to favorites", { count: cur.count })
      : t("Removing {count, plural, one {# file} other {# files}} from favorites", {
          count: cur.count,
        }),
  )
}

export async function setRating(rating: number): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "rating", source: { selection: cur.selection }, rating },
    rating === 0
      ? t("Clearing the rating of {count, plural, one {# file} other {# files}}", {
          count: cur.count,
        })
      : t("Rating {count, plural, one {# file} other {# files}} {stars}", {
          count: cur.count,
          stars: "★".repeat(rating),
        }),
  )
}

export async function setLabel(label: number): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "label", source: { selection: cur.selection }, label },
    label === 0
      ? t("Clearing the label of {count, plural, one {# file} other {# files}}", {
          count: cur.count,
        })
      : t("Labeling {count, plural, one {# file} other {# files}} {label}", {
          count: cur.count,
          label: labelName(label).toLowerCase(),
        }),
  )
}

export function askTags(): void {
  const cur = currentSelection()
  if (cur) set({ dialog: { kind: "tag", ...cur } })
}

export async function tagSelection(
  selection: SelectionDescriptor,
  count: number,
  tag: string,
  add: boolean,
): Promise<void> {
  await start(
    { kind: "tag", source: { selection }, tag, add },
    add
      ? t("Tagging {count, plural, one {# file} other {# files}} “{tag}”", { count, tag })
      : t("Removing “{tag}” from {count, plural, one {# file} other {# files}}", { count, tag }),
  )
}

// Panel ----------------------------------------------------------------------

export async function cancelJob(jobId: number): Promise<void> {
  try {
    await bridge.cancelJob(jobId)
  } catch (error) {
    set({ error: describe(error) })
  }
}

export function dismissJob(jobId: number): void {
  set((s) => ({ dismissed: new Set(s.dismissed).add(jobId) }))
}

export function dismissFinished(): void {
  set((s) => ({
    dismissed: new Set([...s.dismissed, ...s.jobs.filter((j) => !isActive(j)).map((j) => j.jobId)]),
    error: null,
  }))
}

export function clearJobError(): void {
  set({ error: null })
}

export function showJobErrors(jobId: number): void {
  set({ dialog: { kind: "errors", jobId } })
}

export function closeJobDialog(): void {
  set({ dialog: null })
}

/** "3 of 12 done, 1 failed". */
export function jobCounts(job: JobSnapshot): string {
  const parts = [
    t("{current} of {total}", { current: formatCount(job.done), total: formatCount(job.total) }),
  ]
  if (job.failed > 0) parts.push(t("{count} failed", { count: formatCount(job.failed) }))
  if (job.skipped > 0) parts.push(t("{count} skipped", { count: formatCount(job.skipped) }))
  return parts.join(", ")
}

/** Subscribes to job.progress and picks up jobs started before a reload. */
export function startJobMonitoring(): () => void {
  if (!isBridgeAvailable()) return () => {}
  const off = bridge.on("job.progress", upsert)
  void bridge
    .listJobs()
    .then((jobs) => {
      for (const j of jobs) {
        upsert(j)
        // Jobs that finished before this renderer started are history, not news.
        if (!isActive(j)) dismissJob(j.jobId)
      }
    })
    .catch(() => undefined)
  void refreshClip()
  return off
}
