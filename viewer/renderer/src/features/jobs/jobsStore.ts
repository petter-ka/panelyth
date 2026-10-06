import type {
  ClipState,
  JobKind,
  JobSnapshot,
  JobStartParams,
  SelectionDescriptor,
} from "@fastview/contracts"
import { isSelectionDescriptor } from "@fastview/contracts"
import { create } from "zustand"
import { bridge, FastViewError, isBridgeAvailable } from "../../bridge"
import { formatCount, plural } from "../../lib/format"
import { useFolderStore } from "../folder/folderStore"
import { useSettingsStore } from "../settings/settingsStore"
import { labelName } from "../labels/labels"
import { singleSelectedId } from "../properties/propertiesStore"
import { getItem } from "../tiles/pageStore"
import { selectionCount, toDescriptor, useSelectionStore } from "../tiles/selectionStore"

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
  return job.state === "queued" || job.state === "running"
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

const KIND_LABEL: Record<JobKind, string> = {
  copy: "Copying",
  move: "Moving",
  trash: "Moving to trash",
  delete: "Deleting",
  rename: "Renaming",
  favorite: "Updating favorites",
  rating: "Rating",
  label: "Labeling",
  tag: "Tagging",
  dirSize: "Calculating folder sizes",
}

export function jobLabel(s: JobsState, job: JobSnapshot): string {
  const known = s.labels.get(job.jobId)
  if (known) return known
  const items = plural(job.total, "item", "items")
  const to = job.destination ? ` to ${job.destination}` : ""
  return `${KIND_LABEL[job.kind]} ${items}${to}`
}

function describe(error: unknown): string {
  if (error instanceof FastViewError) {
    if (error.code === "BUSY") return "Too many operations are waiting. Try again in a moment."
    if (error.code === "NOT_FOUND") return "The folder changed. Select the items again."
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

export const SELECTION_DRAG_TYPE = "application/x-fastview-selection"

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

export async function confirmDropTransfer(
  selection: SelectionDescriptor,
  count: number,
  destination: string,
  folderName: string,
  kind: "copy" | "move",
): Promise<void> {
  closeJobDialog()
  const verb = kind === "copy" ? "Copying" : "Moving"
  await start(
    { kind, source: { selection }, destination, conflict: "keepBoth" },
    `${verb} ${items(count)} to ${folderName}`,
  )
}

const items = (n: number) => plural(n, "item", "items")
const files = (n: number) => plural(n, "file", "files")

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
  if (useSettingsStore.getState().preferences.confirmOverwrite) {
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
    const verb = clip.mode === "cut" ? "Moving" : "Copying"
    set((s) => ({
      labels: new Map(s.labels).set(snap.jobId, `${verb} ${items(clip.count)} to ${folderName}`),
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
  const verb = kind === "copy" ? "Copying" : "Moving"
  await start(
    { kind, source: { selection: cur.selection }, destination, conflict: "keepBoth" },
    `${verb} ${items(cur.count)} to ${name}`,
  )
}

/** Delete: to the OS trash, no confirmation (it can be undone there). */
export async function trashSelection(): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "trash", source: { selection: cur.selection } },
    `Moving ${items(cur.count)} to trash`,
  )
}

/** Shift+Delete: always asks first. */
export function askDeletePermanently(): void {
  const cur = currentSelection()
  if (cur) set({ dialog: { kind: "delete", ...cur } })
}

export async function deletePermanently(selection: SelectionDescriptor, count: number) {
  closeJobDialog()
  await start({ kind: "delete", source: { selection } }, `Deleting ${items(count)}`)
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
    `Renaming ${items(count)}`,
  )
}

// User metadata --------------------------------------------------------------

export async function setFavorite(favorite: boolean): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "favorite", source: { selection: cur.selection }, favorite },
    favorite
      ? `Adding ${files(cur.count)} to favorites`
      : `Removing ${files(cur.count)} from favorites`,
  )
}

export async function setRating(rating: number): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "rating", source: { selection: cur.selection }, rating },
    rating === 0
      ? `Clearing the rating of ${files(cur.count)}`
      : `Rating ${files(cur.count)} ${"★".repeat(rating)}`,
  )
}

export async function setLabel(label: number): Promise<void> {
  const cur = currentSelection()
  if (!cur) return
  await start(
    { kind: "label", source: { selection: cur.selection }, label },
    label === 0
      ? `Clearing the label of ${files(cur.count)}`
      : `Labeling ${files(cur.count)} ${labelName(label).toLowerCase()}`,
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
    add ? `Tagging ${files(count)} “${tag}”` : `Removing “${tag}” from ${files(count)}`,
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
  const parts = [`${formatCount(job.done)} of ${formatCount(job.total)}`]
  if (job.failed > 0) parts.push(`${formatCount(job.failed)} failed`)
  if (job.skipped > 0) parts.push(`${formatCount(job.skipped)} skipped`)
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
