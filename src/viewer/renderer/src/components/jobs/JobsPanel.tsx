import type { JobSnapshot } from "@panelyth/contracts"
import {
  cancelJob,
  clearJobError,
  dismissFinished,
  dismissJob,
  isActive,
  jobCounts,
  jobLabel,
  showJobErrors,
  useJobsStore,
  visibleJobs,
} from "../../features/jobs/jobsStore"
import { Tooltip } from "@panelyth/ui"
import { formatBytes } from "../../lib/format"
import { CloseIcon } from "../ui/icons"
import { msg, t } from "@panelyth/i18n"

const STATE_TEXT = {
  queued: msg("Waiting"),
  running: "",
  // Engine v2 states (Stage P03); the viewer never pauses or asks itself.
  paused: msg("Paused"),
  asking: msg("Waiting for an answer"),
  completed: msg("Done"),
  cancelled: msg("Cancelled"),
  failed: msg("Failed"),
} as const

function percent(job: JobSnapshot): number {
  if (job.bytesTotal > 0) return Math.min(100, (job.bytesDone / job.bytesTotal) * 100)
  if (job.total === 0) return isActive(job) ? 0 : 100
  return Math.min(100, ((job.done + job.failed + job.skipped) / job.total) * 100)
}

function JobRow({ job }: { job: JobSnapshot }) {
  const label = useJobsStore((s) => jobLabel(s, job))
  const active = isActive(job)
  const tone =
    job.state === "failed" || job.failed > 0
      ? "bg-danger"
      : job.state === "cancelled"
        ? "bg-muted"
        : "bg-accent"
  return (
    <li className="flex flex-col gap-1 px-3 py-2" data-testid="job" data-state={job.state}>
      <div className="flex items-center gap-2">
        <Tooltip content={label}>
          <span className="min-w-0 flex-1 truncate text-xs text-text">{label}</span>
        </Tooltip>
        {active ? (
          <button
            type="button"
            className="shrink-0 rounded px-1.5 text-[0.6875rem] text-muted hover:bg-raised hover:text-text"
            onClick={() => void cancelJob(job.jobId)}
          >
            {t("Cancel")}
          </button>
        ) : (
          <button
            type="button"
            aria-label={t("Dismiss")}
            className="grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-raised hover:text-text"
            onClick={() => dismissJob(job.jobId)}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
      {/* Width only changes ≤ 4 times a second (coalesced progress); no transition. */}
      <div className="h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
        <div className={`h-full ${tone}`} style={{ width: `${percent(job)}%` }} />
      </div>
      <div className="flex items-center gap-2 text-[0.6875rem] text-muted tabular-nums">
        <span className="min-w-0 flex-1 truncate">
          {STATE_TEXT[job.state] && <span className="mr-1">{t(STATE_TEXT[job.state])}:</span>}
          {jobCounts(job)}
          {job.bytesTotal > 0 && active && (
            <>
              {" "}
              ·{" "}
              {t("{current} of {total}", {
                current: formatBytes(job.bytesDone),
                total: formatBytes(job.bytesTotal),
              })}
            </>
          )}
          {active && job.current && (
            <Tooltip content={job.current}>
              <span> · {job.current}</span>
            </Tooltip>
          )}
        </span>
        {job.failed > 0 && !active && (
          <button
            type="button"
            className="shrink-0 rounded px-1 text-text underline-offset-2 hover:underline"
            onClick={() => showJobErrors(job.jobId)}
          >
            {t("Details")}
          </button>
        )}
      </div>
      {job.error && <p className="text-[0.6875rem] text-danger">{job.error}</p>}
    </li>
  )
}

/**
 * Non-modal progress for batch operations (UX-DESIGN "Batch bar"). It floats
 * over the content canvas so jobs starting or finishing never reflow the tile
 * view.
 */
export function JobsPanel() {
  const jobs = useJobsStore((s) => s.jobs)
  const dismissed = useJobsStore((s) => s.dismissed)
  const error = useJobsStore((s) => s.error)
  const shown = visibleJobs(jobs, dismissed)
  if (shown.length === 0 && !error) return null
  const finished = shown.filter((j) => !isActive(j)).length
  return (
    <section
      aria-label={t("Operations")}
      aria-live="polite"
      className="absolute right-3 bottom-3 z-10 flex max-h-[50%] w-80 flex-col overflow-hidden rounded-lg border border-border bg-chrome shadow-lg shadow-black/30"
      data-testid="jobs-panel"
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-[0.6875rem] text-muted">
        <span className="flex-1 font-medium text-text">{t("Operations")}</span>
        {finished > 0 && (
          <button type="button" className="rounded px-1 hover:text-text" onClick={dismissFinished}>
            {t("Clear finished")}
          </button>
        )}
      </header>
      {error && (
        <p className="flex items-start gap-2 border-b border-border px-3 py-2 text-[0.6875rem] text-danger">
          <span className="flex-1">{error}</span>
          <button
            type="button"
            aria-label={t("Dismiss")}
            className="text-muted hover:text-text"
            onClick={clearJobError}
          >
            <CloseIcon size={12} />
          </button>
        </p>
      )}
      <ul className="min-h-0 divide-y divide-border overflow-y-auto">
        {shown.map((j) => (
          <JobRow key={j.jobId} job={j} />
        ))}
      </ul>
    </section>
  )
}
