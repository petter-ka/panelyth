import type { ConflictDecision, JobItemError, JobSnapshot } from "@fastview/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

// The operation queue (Stage C04, CFR-13): every job of the shared queue
// (the viewer's too), from job.progress snapshots; conflict questions from
// job.conflict (and the snapshot's `conflict`, so a question asked while
// the commander was hidden is still answered). Folder-size jobs belong to
// the status line and are left out.

export const ACTIVE = new Set(["queued", "running", "paused", "asking"])
export const isActiveJob = (j: JobSnapshot): boolean => ACTIVE.has(j.state)

interface QueueState {
  jobs: JobSnapshot[]
  /** Ctrl+J: the list instead of the one-line strip. */
  expanded: boolean
  /** Finished jobs the user closed. */
  dismissed: ReadonlySet<number>
  /** The job whose conflict dialog is open. */
  answering: number | null
  /** Jobs whose question the user put aside (answered later from the queue). */
  deferred: ReadonlySet<number>
  /** Item errors shown in the Details dialog. */
  details: { jobId: number; errors: JobItemError[]; total: number } | null
}

export const useQueueStore = create<QueueState>(() => ({
  jobs: [],
  expanded: false,
  dismissed: new Set(),
  answering: null,
  deferred: new Set(),
  details: null,
}))

const set = useQueueStore.setState
const get = useQueueStore.getState

const shown = (j: JobSnapshot): boolean => j.kind !== "dirSize"

function upsert(snap: JobSnapshot): void {
  if (!shown(snap)) return
  const jobs = get().jobs.slice()
  const i = jobs.findIndex((j) => j.jobId === snap.jobId)
  if (i >= 0) jobs[i] = snap
  else jobs.push(snap)
  // Keep the newest 50 (finished ones go first).
  while (jobs.length > 50) {
    const old = jobs.findIndex((j) => !isActiveJob(j))
    jobs.splice(old >= 0 ? old : 0, 1)
  }
  set({ jobs })
  // A job that asks gets its dialog unless one is open or it was put aside.
  if (
    snap.state === "asking" &&
    snap.conflict &&
    get().answering === null &&
    !get().deferred.has(snap.jobId)
  ) {
    set({ answering: snap.jobId })
  }
  if (get().answering === snap.jobId && snap.state !== "asking")
    set({ answering: nextAsking(snap.jobId) })
}

/** Another job still asking (one dialog at a time). */
function nextAsking(except: number): number | null {
  const j = get().jobs.find(
    (x) => x.jobId !== except && x.state === "asking" && x.conflict && !get().deferred.has(x.jobId),
  )
  return j?.jobId ?? null
}

/** The queue as it shows: active jobs, then finished ones not yet closed. */
export function visibleJobs(
  jobs: readonly JobSnapshot[],
  dismissed: ReadonlySet<number>,
): JobSnapshot[] {
  return jobs.filter((j) => isActiveJob(j) || !dismissed.has(j.jobId))
}

export const toggleQueue = (): void => set({ expanded: !get().expanded })
export const setQueueExpanded = (expanded: boolean): void => set({ expanded })

export function dismissJob(jobId: number): void {
  set({ dismissed: new Set([...get().dismissed, jobId]) })
}

export function dismissFinished(): void {
  set({
    dismissed: new Set([
      ...get().dismissed,
      ...get()
        .jobs.filter((j) => !isActiveJob(j))
        .map((j) => j.jobId),
    ]),
  })
}

export const pause = (jobId: number): Promise<void> => bridge.pauseJob(jobId).catch(() => undefined)
export const resume = (jobId: number): Promise<void> =>
  bridge.resumeJob(jobId).catch(() => undefined)
export const startNow = (jobId: number): Promise<void> =>
  bridge.startJobNow(jobId).catch(() => undefined)
export const cancel = (jobId: number): Promise<void> =>
  bridge.cancelJob(jobId).catch(() => undefined)

/** "Needs your decision" in the queue: the job's dialog again. */
export function openQuestion(jobId: number): void {
  const deferred = new Set(get().deferred)
  deferred.delete(jobId)
  set({ answering: jobId, deferred })
}

/** Esc on the conflict dialog: the job keeps waiting; the queue shows it. */
export function deferQuestion(): void {
  const id = get().answering
  if (id === null) return
  set({ deferred: new Set([...get().deferred, id]), answering: nextAsking(id) })
}

/** A conflict decision (or "Cancel job"). */
export async function answer(
  decision: ConflictDecision | "cancel",
  applyToAll: boolean,
): Promise<void> {
  const id = get().answering
  if (id === null) return
  set({ answering: nextAsking(id) })
  if (decision === "cancel") await cancel(id)
  else await bridge.resolveJob(id, decision, applyToAll).catch(() => false)
}

export async function showDetails(jobId: number): Promise<void> {
  const res = await bridge.jobErrors(jobId, 0, 200).catch(() => null)
  if (res) set({ details: { jobId, errors: res.errors, total: res.total } })
}

export const closeDetails = (): void => set({ details: null })

/** Follows the shared queue; reads it once. */
export function startQueue(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  void bridge
    .listJobs()
    .then((jobs) => jobs.forEach(upsert))
    .catch(() => undefined)
  const offProgress = bridge.on("job.progress", upsert)
  const offConflict = bridge.on("job.conflict", ({ jobId, conflict }) => {
    const j = get().jobs.find((x) => x.jobId === jobId)
    if (j) upsert({ ...j, state: "asking", conflict })
  })
  return () => {
    offProgress()
    offConflict()
  }
}

/** Tests. */
export function resetQueue(): void {
  set({
    jobs: [],
    expanded: false,
    dismissed: new Set(),
    answering: null,
    deferred: new Set(),
    details: null,
  })
}
