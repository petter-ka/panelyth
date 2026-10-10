import type { ConflictDecision, JobConflictSide, JobSnapshot } from "@panelyth/contracts"
import { Button, DialogWindow, Tooltip } from "@panelyth/ui"
import { useState } from "react"
import { formatBytes, formatCount, formatDate } from "../features/format"
import {
  answer,
  cancel,
  closeDetails,
  deferQuestion,
  dismissFinished,
  dismissJob,
  isActiveJob,
  openQuestion,
  pause,
  resume,
  setQueueExpanded,
  showDetails,
  startNow,
  toggleQueue,
  useQueueStore,
  visibleJobs,
} from "../features/queue"

const VERBS: Partial<Record<JobSnapshot["kind"], [string, string]>> = {
  copy: ["Copying", "Copied"],
  move: ["Moving", "Moved"],
  trash: ["Moving to the trash", "Moved to the trash"],
  delete: ["Deleting", "Deleted"],
  rename: ["Renaming", "Renamed"],
}

/** "Copying 1,204 items to Backup" / "Copied 1,204 items to Backup". */
export function describeJob(j: JobSnapshot): string {
  const [doing, done] = VERBS[j.kind] ?? ["Working on", "Worked on"]
  const items = `${formatCount(j.total)} ${j.total === 1 ? "item" : "items"}`
  const to = j.destination ? ` to ${j.destination}` : ""
  return `${isActiveJob(j) ? doing : done} ${items}${to}`
}

function duration(ms: number): string {
  const s = Math.ceil(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}

function percent(j: JobSnapshot): number {
  if (j.bytesTotal > 0) return Math.min(100, (j.bytesDone / j.bytesTotal) * 100)
  if (j.total > 0) return Math.min(100, ((j.done + j.failed + j.skipped) / j.total) * 100)
  return isActiveJob(j) ? 0 : 100
}

/** "2.1 of 6.3 GB · 412 MB/s · 0:12 left", or the state. */
function progressText(j: JobSnapshot): string {
  const parts: string[] = []
  if (j.bytesTotal > 0) parts.push(`${formatBytes(j.bytesDone)} of ${formatBytes(j.bytesTotal)}`)
  else parts.push(`${formatCount(j.done)} of ${formatCount(j.total)}`)
  switch (j.state) {
    case "queued":
      parts.push("waiting")
      break
    case "paused":
      parts.push("paused")
      break
    case "asking":
      parts.push("needs your decision")
      break
    case "running":
      if (j.bytesPerSec > 0) parts.push(`${formatBytes(j.bytesPerSec)}/s`)
      if (j.etaMs > 0) parts.push(`${duration(j.etaMs)} left`)
      break
    case "completed":
      parts.push(j.failed > 0 ? `${formatCount(j.failed)} failed` : "done")
      break
    case "cancelled":
      parts.push("cancelled")
      break
    case "failed":
      parts.push(j.error || "failed")
      break
  }
  if (j.skipped > 0 && !isActiveJob(j)) parts.push(`${formatCount(j.skipped)} skipped`)
  return parts.join(" · ")
}

function JobRow({ j }: { j: JobSnapshot }) {
  const active = isActiveJob(j)
  const tone =
    j.state === "failed" || j.failed > 0
      ? "bg-danger"
      : j.state === "paused" || j.state === "asking"
        ? "bg-muted"
        : "bg-accent"
  return (
    <li
      data-testid={`job-${j.jobId}`}
      data-state={j.state}
      className="flex min-w-0 items-center gap-3 px-3 py-1.5"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-text">{describeJob(j)}</span>
          <span className="shrink-0 truncate text-[0.6875rem] text-muted tabular-nums">
            {progressText(j)}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
          <div className={`h-full ${tone}`} style={{ width: `${percent(j)}%` }} />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {j.state === "asking" && (
          <Button size="sm" variant="primary" onClick={() => openQuestion(j.jobId)}>
            Needs your decision
          </Button>
        )}
        {j.state === "queued" && (
          <Button size="sm" onClick={() => void startNow(j.jobId)}>
            Start now
          </Button>
        )}
        {(j.state === "running" || j.state === "queued") && (
          <Button size="sm" onClick={() => void pause(j.jobId)}>
            Pause
          </Button>
        )}
        {j.state === "paused" && (
          <Button size="sm" onClick={() => void resume(j.jobId)}>
            Resume
          </Button>
        )}
        {active && (
          <Button size="sm" onClick={() => void cancel(j.jobId)}>
            Cancel
          </Button>
        )}
        {!active && j.failed > 0 && (
          <Button size="sm" onClick={() => void showDetails(j.jobId)}>
            Details
          </Button>
        )}
        {!active && (
          <Button size="sm" aria-label="Close" onClick={() => dismissJob(j.jobId)}>
            ×
          </Button>
        )}
      </div>
    </li>
  )
}

/**
 * The queue panel (Stage C04, UX-DESIGN "Queue panel"): a strip with the
 * running job while jobs exist; Ctrl+J or a click expands it into the list.
 * Progress updates arrive at most 4 Hz per job (coalesced in Go).
 */
export function QueuePanel() {
  const jobs = useQueueStore((s) => s.jobs)
  const dismissed = useQueueStore((s) => s.dismissed)
  const expanded = useQueueStore((s) => s.expanded)
  const list = visibleJobs(jobs, dismissed)
  if (list.length === 0) return null
  const active = list.filter(isActiveJob)
  const head =
    active.find((j) => j.state === "asking") ??
    active.find((j) => j.state === "running") ??
    active[0] ??
    list.at(-1)!
  return (
    <section
      aria-label="Operation queue"
      data-testid="queue"
      data-expanded={expanded}
      className="shrink-0 border-t border-border bg-chrome text-xs"
    >
      {expanded ? (
        <div className="flex max-h-56 flex-col">
          <div className="flex h-7 items-center gap-2 border-b border-border px-3 text-muted">
            <span className="flex-1">
              {formatCount(active.length)} running or waiting ·{" "}
              {formatCount(list.length - active.length)} finished
            </span>
            <Button size="sm" onClick={dismissFinished}>
              Clear finished
            </Button>
            <Button size="sm" onClick={() => setQueueExpanded(false)} title="Ctrl+J">
              Collapse
            </Button>
          </div>
          <ul className="min-h-0 overflow-y-auto" aria-live="off">
            {list.map((j) => (
              <JobRow key={j.jobId} j={j} />
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex items-center" aria-live="polite">
          <div className="min-w-0 flex-1">
            <ul>
              <JobRow j={head} />
            </ul>
          </div>
          {list.length > 1 && (
            <Tooltip content="Show all operations (Ctrl+J)">
              <button
                type="button"
                tabIndex={-1}
                onClick={toggleQueue}
                className="h-7 shrink-0 px-3 text-muted hover:text-text"
              >
                +{list.length - 1} more
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </section>
  )
}

function Side({
  title,
  side,
  newer,
  name,
}: {
  title: string
  side: JobConflictSide
  newer: boolean
  name: string
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded-md border border-border p-3">
      <span className="text-[0.6875rem] font-semibold tracking-wide text-muted uppercase">
        {title}
      </span>
      <Tooltip content={name}>
        <span className="truncate text-text">{name}</span>
      </Tooltip>
      <span className="text-muted tabular-nums">
        {side.isDir ? "Folder" : formatBytes(side.size)}
      </span>
      <span className="text-muted tabular-nums">
        {formatDate(side.modifiedMs)}
        {newer && <span className="ml-1.5 rounded bg-accent/20 px-1 text-accent">newer</span>}
      </span>
    </div>
  )
}

/**
 * The conflict question of a job with the "ask" policy (Stage C04): source
 * and target side by side, the newer one marked. Only this job waits; Esc
 * leaves the question in the queue ("Needs your decision").
 */
export function ConflictDialog() {
  const id = useQueueStore((s) => s.answering)
  const job = useQueueStore((s) => s.jobs.find((j) => j.jobId === s.answering))
  const [all, setAll] = useState(false)
  const c = job?.conflict
  if (id === null || !job || !c) return null
  const decide = (d: ConflictDecision | "cancel", applyToAll = all): void => {
    setAll(false)
    void answer(d, applyToAll)
  }
  const srcNewer = c.source.modifiedMs > c.target.modifiedMs
  const dstNewer = c.target.modifiedMs > c.source.modifiedMs
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) deferQuestion()
      }}
      title={`“${c.name}” already exists`}
      description={describeJob(job)}
      contentClassName="w-[min(36rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="conflict-dialog">
        <div className="flex gap-3">
          <Side title="New" side={c.source} newer={srcNewer} name={c.name} />
          <Side title="Existing" side={c.target} newer={dstNewer} name={c.name} />
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
          Apply to all conflicts in this job
        </label>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="primary" onClick={() => decide("replace")} autoFocus>
            Overwrite
          </Button>
          <Button
            onClick={() => decide("replaceOlder", true)}
            title="This and every later conflict of this job"
          >
            Overwrite all older
          </Button>
          <Button onClick={() => decide("skip")}>Skip</Button>
          <Button onClick={() => decide("renameNew")}>Rename</Button>
          <Button onClick={() => decide("renameExisting")}>Rename existing</Button>
          <Button variant="danger" onClick={() => decide("cancel")}>
            Cancel job
          </Button>
        </div>
      </div>
    </DialogWindow>
  )
}

/** Details of a finished job's failures (jobs.errors). */
export function JobDetailsDialog() {
  const d = useQueueStore((s) => s.details)
  if (!d) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeDetails()
      }}
      title={`${formatCount(d.total)} ${d.total === 1 ? "item" : "items"} failed`}
      contentClassName="w-[min(40rem,calc(100vw-2rem))]"
    >
      <ul className="max-h-80 overflow-y-auto text-xs" data-testid="job-details">
        {d.errors.map((e, i) => (
          <li key={i} className="flex gap-3 border-b border-border py-1.5">
            <Tooltip content={e.name}>
              <span className="w-48 shrink-0 truncate text-text">{e.name || "—"}</span>
            </Tooltip>
            <span className="min-w-0 flex-1 text-muted">{e.message}</span>
          </li>
        ))}
      </ul>
      {d.total > d.errors.length && (
        <p className="mt-2 text-xs text-muted">
          The first {formatCount(d.errors.length)} are shown.
        </p>
      )}
    </DialogWindow>
  )
}
