import type { JobSnapshot, SelectionDescriptor } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import type { Side } from "./panels"

// Folder sizes (Stage C02): Space on a folder, or Alt+Shift+Enter for all
// folders of the panel, starts a cancellable dirSize job in Go. Results land
// in the index (ContentItem.dirSizeBytes) and reach the panel through the
// normal session invalidation; the status line shows the running job.

export const useSizeJobs = create<Record<Side, JobSnapshot | null>>(() => ({
  left: null,
  right: null,
}))

const FINISHED = new Set(["completed", "cancelled", "failed"])

export async function calculateSizes(side: Side, selection: SelectionDescriptor): Promise<void> {
  const previous = useSizeJobs.getState()[side]
  if (previous && !FINISHED.has(previous.state))
    void bridge.cancelJob(previous.jobId).catch(() => undefined)
  const job = await bridge.dirSize(selection)
  useSizeJobs.setState({ [side]: job })
}

export function stopSizes(side: Side): void {
  const job = useSizeJobs.getState()[side]
  if (job && !FINISHED.has(job.state)) void bridge.cancelJob(job.jobId).catch(() => undefined)
}

export const isRunning = (job: JobSnapshot | null): boolean =>
  job !== null && !FINISHED.has(job.state)

/** Follows job.progress for the panels' size jobs. */
export function startSizeJobs(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return bridge.on("job.progress", (snap) => {
    const jobs = useSizeJobs.getState()
    for (const side of ["left", "right"] as const) {
      if (jobs[side]?.jobId === snap.jobId) useSizeJobs.setState({ [side]: snap })
    }
  })
}

/** Ctrl+U: the running jobs follow their panels. */
export function swapSizeJobs(): void {
  const { left, right } = useSizeJobs.getState()
  useSizeJobs.setState({ left: right, right: left })
}
