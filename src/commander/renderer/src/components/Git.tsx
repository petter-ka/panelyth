import type { GitMark, GitRepo } from "@panelyth/contracts"
import { msg, t } from "@panelyth/i18n"
import { formatChord } from "@panelyth/renderer-core"
import { Spinner, Tooltip } from "@panelyth/ui"
import { memo, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { bridge } from "../bridge"
import { formatListDate } from "../features/format"
import {
  branchMenuJustClosed,
  cancelRun,
  closeBranchMenu,
  dismissRun,
  GIT_LETTER,
  GIT_TONE,
  gitDiscard,
  gitFetch,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  openBranchMenu,
  openCommit,
  openHistory,
  openNewBranch,
  refreshGit,
  runOf,
  setBranchFilter,
  switchBranch,
  useGitStore,
  type GitRunView,
} from "../features/git"
import { useKeymapStore } from "../features/keymap"
import { openPath } from "../features/listing"
import { notice } from "../features/files"
import type { Side } from "../features/panels"
import { PopupMenu, type MenuEntry } from "./PopupMenu"

// Git in the commander (ADR-0043): the path bar's badge, the rows' marks,
// the Git bar at the bottom of a panel and its branch menu.

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const

/** A branch: two commits joined, the shape Git tools use. */
export const BranchIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <circle cx="4.5" cy="3.5" r="1.75" />
    <circle cx="4.5" cy="12.5" r="1.75" />
    <circle cx="11.5" cy="5" r="1.75" />
    <path d="M4.5 5.25v5.5M11.5 6.75c0 3-7 2-7 4" />
  </svg>
)

const ArrowDownIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <path d="M8 2.5v11M3.5 9 8 13.5 12.5 9" />
  </svg>
)
const ArrowUpIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <path d="M8 13.5v-11M3.5 7 8 2.5 12.5 7" />
  </svg>
)
const CloudUpIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <path d="M4.5 12.5h-.25a3 3 0 0 1-.4-5.97A4.5 4.5 0 0 1 12.6 6a2.75 2.75 0 0 1-.6 6.5h-.5M8 14V8.5M5.75 10.5 8 8.25l2.25 2.25" />
  </svg>
)
const SyncedIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
  </svg>
)
const MoreIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.25" />
    <circle cx="8" cy="8" r="1.25" />
    <circle cx="12.5" cy="8" r="1.25" />
  </svg>
)
const ChevronIcon = ({ size = 10 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" {...stroke} aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
)

const tint = (color: string, share = 14): CSSProperties => ({
  background: `color-mix(in srgb, ${color} ${share}%, transparent)`,
})

/** The branch as the badge and the bar name it: the branch, or the commit when detached. */
export function branchLabel(repo: GitRepo): string {
  if (repo.branch) return repo.branch
  return repo.head ? t("{commit} (detached)", { commit: repo.head }) : t("No branch")
}

const changesOf = (repo: GitRepo): number =>
  repo.counts.staged + repo.counts.changed + repo.counts.untracked + repo.counts.conflicted

// --- Rows ---------------------------------------------------------------------------

/** Words for a mark, for tooltips and assistive technology. */
export function markText(mark: GitMark): string {
  const state = {
    conflicted: t("Conflicted"),
    modified: t("Modified"),
    deleted: t("Deleted"),
    added: t("Added"),
    renamed: t("Renamed"),
    untracked: t("Untracked"),
    ignored: t("Ignored"),
  }[mark.state]
  if (mark.below) return t("Changes inside: {state}", { state })
  if (mark.staged && !mark.unstaged) return t("{state}, staged", { state })
  if (mark.staged && mark.unstaged) return t("{state}, partly staged", { state })
  return state
}

/** The name's colour for a row's mark; a marked row keeps the accent of its mark. */
export function gitNameStyle(mark: GitMark | null, marked: boolean): CSSProperties | undefined {
  if (!mark || marked) return undefined
  if (mark.state === "ignored") return { opacity: 0.55 }
  return { color: GIT_TONE[mark.state] }
}

/**
 * The status at the end of a row's name: a letter (staged changes on a soft
 * tint of their colour), or a dot for a folder with changes inside.
 */
export const GitRowMark = memo(function GitRowMark({
  mark,
  inline = false,
}: {
  mark: GitMark
  /** Right after the name (a tile), not at the end of the row. */
  inline?: boolean
}) {
  if (mark.state === "ignored") return null
  const place = inline ? "ml-1" : "ml-auto"
  const color = GIT_TONE[mark.state]
  const text = markText(mark)
  if (mark.below) {
    return (
      <span
        role="img"
        aria-label={text}
        data-git={mark.state}
        data-tooltip-content={text}
        className={`${place} size-1.5 shrink-0 rounded-full`}
        style={{
          background: color,
          boxShadow: `0 0 4px color-mix(in srgb, ${color} 60%, transparent)`,
        }}
      />
    )
  }
  const staged = mark.staged && !mark.unstaged
  return (
    <span
      role="img"
      aria-label={text}
      data-git={mark.state}
      data-staged={staged}
      data-tooltip-content={text}
      className={`${place} grid h-3.5 min-w-3.5 shrink-0 place-items-center rounded-[3px] px-0.5 font-mono text-[0.625rem] leading-none font-semibold`}
      style={{ color, ...(staged ? tint(color, 22) : {}) }}
    >
      {GIT_LETTER[mark.state]}
    </span>
  )
})

// --- The path bar's badge ----------------------------------------------------------

/** "In a Git repository" at a glance: the branch, a dot when there are changes. */
export function GitBadge({ side }: { side: Side }) {
  const repo = useGitStore((s) => s[side].status?.repo ?? null)
  const menu = useGitStore((s) => s.branchMenu?.side === side && s.branchMenu.from === "path")
  if (!repo) return null
  const changes = changesOf(repo)
  const tone =
    repo.counts.conflicted > 0 ? "var(--danger)" : changes > 0 ? "var(--warning)" : "var(--success)"
  const summary = [
    t("Git repository {name}", { name: repo.name }),
    t("Branch: {branch}", { branch: branchLabel(repo) }),
    changes > 0 ? t("Changes: {count}", { count: changes }) : t("No changes"),
  ].join(" · ")
  return (
    <span className="relative ml-1 shrink-0">
      <Tooltip content={summary}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={summary}
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid={`git-badge-${side}`}
          onClick={() => {
            if (!branchMenuJustClosed()) void openBranchMenu(side, "path")
          }}
          className="glass-pill flex h-6 max-w-44 items-center gap-1.5 rounded-full border border-accent/30 px-2 text-2xs font-medium text-accent hover:border-accent/60"
          style={tint("var(--accent)", 10)}
        >
          <BranchIcon size={12} />
          <span className="truncate">{branchLabel(repo)}</span>
          <span
            aria-hidden="true"
            className="size-1.5 shrink-0 rounded-full"
            style={{ background: tone, boxShadow: `0 0 4px ${tone}` }}
          />
        </button>
      </Tooltip>
      {menu && <BranchMenu side={side} className="top-full left-0 mt-1" />}
    </span>
  )
}

// --- The branch menu ------------------------------------------------------------------

export function BranchMenu({ side, className }: { side: Side; className: string }) {
  const menu = useGitStore((s) => s.branchMenu)
  const repo = useGitStore((s) => s[side].status?.repo ?? null)
  const entries = useMemo((): MenuEntry[] => {
    if (!menu) return []
    const filter = menu.filter.trim().toLowerCase()
    const match = (name: string): boolean => filter === "" || name.toLowerCase().includes(filter)
    const out: MenuEntry[] = []
    if (menu.error) {
      out.push({ id: "error", label: menu.error, disabled: true })
    } else if (!menu.branches) {
      out.push({ id: "loading", label: t("Loading branches…"), disabled: true })
    } else {
      const local = menu.branches.filter((b) => !b.remote && match(b.name))
      const remote = menu.branches.filter((b) => b.remote && match(b.name))
      if (local.length > 0) out.push({ id: "h-local", label: t("Branches"), heading: true })
      for (const b of local) {
        out.push({
          id: `l-${b.name}`,
          label: b.name,
          ...(b.when > 0 && { detail: formatListDate(b.when, "locale", true) }),
          checked: b.current,
          ...(!b.current && { onSelect: () => switchBranch(side, b.name) }),
        })
      }
      if (remote.length > 0)
        out.push({ id: "h-remote", label: t("Remote branches"), heading: true })
      for (const b of remote) {
        out.push({
          id: `r-${b.name}`,
          label: b.name,
          ...(b.when > 0 && { detail: formatListDate(b.when, "locale", true) }),
          onSelect: () => switchBranch(side, b.name),
        })
      }
      if (local.length + remote.length === 0)
        out.push({ id: "none", label: t("No branch matches"), disabled: true })
    }
    out.push({ id: "sep", label: "", separator: true })
    out.push({ id: "new", label: t("New branch…"), onSelect: () => openNewBranch(side) })
    return out
  }, [menu, side])
  if (!menu || menu.side !== side) return null
  return (
    <PopupMenu
      label={repo ? t("Branches of {name}", { name: repo.name }) : t("Branches")}
      testId={`git-branches-${side}`}
      entries={entries}
      onClose={closeBranchMenu}
      className={className}
      search={{ value: menu.filter, onChange: setBranchFilter, label: t("Find a branch") }}
    />
  )
}

// --- The Git bar ------------------------------------------------------------------------

const barButton =
  "glass-pill flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-text hover:bg-raised disabled:opacity-50"
const keepFocus = (e: { preventDefault(): void }): void => e.preventDefault()

const RUNNING: Record<GitRunView["op"], string> = {
  stage: msg("Staging…"),
  unstage: msg("Unstaging…"),
  discard: msg("Discarding changes…"),
  commit: msg("Committing…"),
  pull: msg("Pulling…"),
  push: msg("Pushing…"),
  fetch: msg("Fetching…"),
  switch: msg("Switching branch…"),
  createBranch: msg("Creating the branch…"),
}

const FAILED: Record<GitRunView["op"], string> = {
  stage: msg("Staging failed"),
  unstage: msg("Unstaging failed"),
  discard: msg("Discarding failed"),
  commit: msg("The commit failed"),
  pull: msg("Pull failed"),
  push: msg("Push failed"),
  fetch: msg("Fetch failed"),
  switch: msg("Switching failed"),
  createBranch: msg("The branch was not created"),
}

/** What a failure means, in words, when Git's own are not enough. */
function explain(run: GitRunView): string {
  switch (run.reason) {
    case "auth":
      return t("Git couldn't sign in to the remote. Check your credentials or SSH key.")
    case "diverged":
      return run.op === "push"
        ? t("The remote has commits you don't have. Pull first, then push.")
        : t("Your branch and the remote have both moved on. Pull with rebase or merge.")
    case "dirty":
      return t("Local changes are in the way. Commit or stash them first.")
    case "conflict":
      return t("There are conflicts. Resolve them, stage the files, then commit.")
    case "noRemote":
      return t("This repository has no remote.")
    case "noUpstream":
      return t("This branch has no upstream branch on a remote.")
    case "unsafe":
      return t("Git doesn't trust this folder: it belongs to another user.")
    default:
      return ""
  }
}

function RunLine({ side, run }: { side: Side; run: GitRunView }) {
  if (run.state === "running") {
    const pct = run.percent >= 0 ? run.percent : null
    return (
      <>
        <span className="flex min-w-0 flex-1 items-center gap-1.5" role="status">
          <Spinner size={12} />
          <span className="shrink-0 text-text">{t(RUNNING[run.op])}</span>
          {run.phase && (
            <span className="min-w-0 truncate">
              {run.phase}
              {pct !== null && ` ${pct}%`}
            </span>
          )}
        </span>
        {(run.op === "pull" || run.op === "push" || run.op === "fetch" || run.op === "commit") && (
          <button
            type="button"
            tabIndex={-1}
            onMouseDown={keepFocus}
            onClick={() => cancelRun(run.repoId)}
            className={barButton}
            data-testid={`git-stop-${side}`}
          >
            {t("Stop")}
          </button>
        )}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
          style={tint("var(--accent)", 18)}
        >
          <span
            className={`block h-full bg-accent ${pct === null ? "git-indeterminate w-1/3" : "chart-ease"}`}
            style={pct === null ? undefined : { width: `${pct}%` }}
          />
        </span>
      </>
    )
  }
  const cancelled = run.state === "cancelled"
  const why = explain(run)
  return (
    <>
      <span
        role="alert"
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${cancelled ? "text-muted" : "text-danger"}`}
        data-testid={`git-failed-${side}`}
      >
        <span className="shrink-0 font-medium">{cancelled ? t("Stopped") : t(FAILED[run.op])}</span>
        <span
          className="min-w-0 truncate text-muted"
          title={[why, run.message].filter(Boolean).join("\n")}
        >
          {why || run.message}
        </span>
      </span>
      {run.reason === "diverged" && run.op === "pull" && (
        <>
          <button
            type="button"
            tabIndex={-1}
            className={barButton}
            onClick={() => gitPull(side, "rebase")}
          >
            {t("Pull with rebase")}
          </button>
          <button
            type="button"
            tabIndex={-1}
            className={barButton}
            onClick={() => gitPull(side, "merge")}
          >
            {t("Pull with merge")}
          </button>
        </>
      )}
      {run.reason === "diverged" && run.op === "push" && (
        <button type="button" tabIndex={-1} className={barButton} onClick={() => gitPull(side)}>
          {t("Pull")}
        </button>
      )}
      <Tooltip content={t("Dismiss")}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("Dismiss")}
          onMouseDown={keepFocus}
          onClick={() => dismissRun(run.repoId)}
          className={`${barButton} w-5 justify-center px-0 text-muted`}
        >
          ✕
        </button>
      </Tooltip>
    </>
  )
}

/** Ahead and behind, and what a click does about it. */
function SyncButton({ side, repo }: { side: Side; repo: GitRepo }) {
  let icon: ReactNode
  let label: string
  let action: () => void
  if (!repo.branch) return null
  if (!repo.upstream) {
    icon = <CloudUpIcon />
    label = t("Publish branch")
    action = () => gitPush(side)
    return (
      <Tooltip content={t("Push {branch} and set its upstream", { branch: repo.branch })}>
        <button
          type="button"
          tabIndex={-1}
          onMouseDown={keepFocus}
          onClick={action}
          className={barButton}
          data-testid={`git-sync-${side}`}
        >
          {icon}
          <span className="hidden @[26rem]:inline">{label}</span>
        </button>
      </Tooltip>
    )
  }
  if (repo.behind > 0) {
    label = t("Commits to pull from {upstream}: {count}", {
      count: repo.behind,
      upstream: repo.upstream,
    })
    action = () => gitPull(side)
  } else if (repo.ahead > 0) {
    label = t("Commits to push to {upstream}: {count}", {
      count: repo.ahead,
      upstream: repo.upstream,
    })
    action = () => gitPush(side)
  } else {
    label = t("Up to date with {upstream}. Click to fetch.", { upstream: repo.upstream })
    action = () => gitFetch(side)
  }
  const synced = repo.ahead === 0 && repo.behind === 0
  return (
    <Tooltip content={label}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onMouseDown={keepFocus}
        onClick={action}
        className={`${barButton} prose-nums ${synced ? "text-muted" : ""}`}
        data-testid={`git-sync-${side}`}
      >
        {synced ? (
          <SyncedIcon />
        ) : (
          <>
            {repo.behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDownIcon />
                {repo.behind}
              </span>
            )}
            {repo.ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUpIcon />
                {repo.ahead}
              </span>
            )}
          </>
        )}
      </button>
    </Tooltip>
  )
}

/** The counts: conflicts, changes, staged, new; a click opens the commit dialog. */
function Counts({ side, repo }: { side: Side; repo: GitRepo }) {
  const c = repo.counts
  const parts: { key: string; n: number; color: string; label: string; glyph: string }[] = [
    {
      key: "conflicted",
      n: c.conflicted,
      color: "var(--danger)",
      label: t("Conflicts: {count}", { count: c.conflicted }),
      glyph: "!",
    },
    {
      key: "changed",
      n: c.changed,
      color: "var(--warning)",
      label: t("Changed: {count}", { count: c.changed }),
      glyph: "●",
    },
    {
      key: "staged",
      n: c.staged,
      color: "var(--success)",
      label: t("Staged: {count}", { count: c.staged }),
      glyph: "✓",
    },
    {
      key: "untracked",
      n: c.untracked,
      color: "var(--muted)",
      label: t("Untracked: {count}", { count: c.untracked }),
      glyph: "+",
    },
  ].filter((p) => p.n > 0)
  if (parts.length === 0) {
    return <span className="min-w-0 truncate text-muted">{t("No changes")}</span>
  }
  const label = parts.map((p) => p.label).join(", ")
  return (
    <Tooltip content={t("{counts}. Click to commit.", { counts: label })}>
      <button
        type="button"
        tabIndex={-1}
        aria-label={label}
        onMouseDown={keepFocus}
        onClick={() => openCommit(side)}
        className={`${barButton} prose-nums`}
        data-testid={`git-counts-${side}`}
      >
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-0.5" style={{ color: p.color }}>
            <span aria-hidden="true" className="text-[0.625rem]">
              {p.glyph}
            </span>
            <span className="text-text">{p.n}</span>
          </span>
        ))}
      </button>
    </Tooltip>
  )
}

const OPERATION: Record<Exclude<GitRepo["operation"], "">, string> = {
  merging: msg("Merging"),
  rebasing: msg("Rebasing"),
  cherryPicking: msg("Cherry-picking"),
  reverting: msg("Reverting"),
  bisecting: msg("Bisecting"),
}

function MoreMenu({ side, repo, onClose }: { side: Side; repo: GitRepo; onClose(): void }) {
  const entries: MenuEntry[] = [
    { id: "stage", label: t("Stage"), onSelect: () => gitStage(side) },
    { id: "unstage", label: t("Unstage"), onSelect: () => gitUnstage(side) },
    { id: "discard", label: t("Discard changes…"), onSelect: () => gitDiscard(side) },
    { id: "s1", label: "", separator: true },
    { id: "pull", label: t("Pull"), onSelect: () => gitPull(side) },
    { id: "pull-rebase", label: t("Pull with rebase"), onSelect: () => gitPull(side, "rebase") },
    { id: "pull-merge", label: t("Pull with merge"), onSelect: () => gitPull(side, "merge") },
    { id: "push", label: t("Push"), onSelect: () => gitPush(side) },
    { id: "fetch", label: t("Fetch"), onSelect: () => gitFetch(side) },
    { id: "s2", label: "", separator: true },
    {
      id: "branches",
      label: t("Switch branch…"),
      onSelect: () => void openBranchMenu(side, "bar"),
    },
    { id: "new-branch", label: t("New branch…"), onSelect: () => openNewBranch(side) },
    { id: "history", label: t("History…"), onSelect: () => void openHistory(side) },
    { id: "s3", label: "", separator: true },
    { id: "refresh", label: t("Refresh Git status"), onSelect: () => void refreshGit(side, true) },
    {
      id: "copy-branch",
      label: t("Copy branch name"),
      disabled: !repo.branch,
      onSelect: () =>
        void bridge
          .copyText(repo.branch)
          .then(() => notice(t("Copied: {text}", { text: repo.branch })))
          .catch(() => undefined),
    },
    {
      id: "root",
      label: t("Go to the top folder"),
      disabled: repo.rel === "",
      onSelect: () => void openPath(side, repo.root),
    },
  ]
  return (
    <PopupMenu
      label={t("Git")}
      testId={`git-more-${side}`}
      entries={entries}
      onClose={onClose}
      className="right-2 bottom-full"
    />
  )
}

/**
 * The Git bar at the bottom of a panel in a repository: the branch (a menu),
 * ahead and behind (a click pulls, pushes or fetches), the changes (a click
 * commits), Commit, and More. A run shows its progress and Stop here; a
 * failure stays with what it means until it is dismissed.
 */
export function GitBar({ side }: { side: Side }) {
  const status = useGitStore((s) => s[side].status)
  const run = useGitStore((s) => runOf(s, side))
  const branchMenu = useGitStore((s) => s.branchMenu?.side === side && s.branchMenu.from === "bar")
  const commitChord = useKeymapStore((s) => s.keymap.chords["git.commit"]?.[0])
  const [more, setMore] = useState(false)
  // A click on the button of an open menu closes it (the menu closes on the
  // press); it must not open it again on the release.
  const moreClosedAt = useRef(0)
  const repo = status?.repo
  if (!repo) return null
  const problem = status.problem
  const changes = changesOf(repo)
  return (
    <div
      className="@container relative flex h-7 shrink-0 items-center gap-1 border-t border-border bg-chrome px-1.5 text-2xs text-muted"
      data-testid={`git-bar-${side}`}
      aria-label={t("Git")}
      role="toolbar"
    >
      <Tooltip content={t("Switch branch")}>
        <button
          type="button"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={branchMenu}
          onMouseDown={keepFocus}
          onClick={() => {
            if (!branchMenuJustClosed()) void openBranchMenu(side, "bar")
          }}
          className={`${barButton} max-w-[40%] font-medium`}
          data-testid={`git-branch-${side}`}
        >
          <span className="text-accent">
            <BranchIcon size={12} />
          </span>
          <span className="truncate">{branchLabel(repo)}</span>
          {repo.unborn && (
            <span className="hidden truncate text-muted @[30rem]:inline">
              {t("(no commits yet)")}
            </span>
          )}
          <ChevronIcon />
        </button>
      </Tooltip>
      {branchMenu && <BranchMenu side={side} className="bottom-full left-1.5" />}
      {repo.operation && (
        <span
          className="shrink-0 rounded px-1.5 py-0.5 font-medium text-danger"
          style={tint("var(--danger)", 14)}
          data-testid={`git-operation-${side}`}
        >
          {t(OPERATION[repo.operation])}
        </span>
      )}
      {run && (run.state === "running" || run.state === "failed" || run.state === "cancelled") ? (
        <RunLine side={side} run={run} />
      ) : problem ? (
        <span role="alert" className="min-w-0 flex-1 truncate text-danger" title={problem.message}>
          {problem.reason === "unsafe"
            ? t("Git doesn't trust this folder: it belongs to another user.")
            : problem.message}
        </span>
      ) : (
        <>
          <SyncButton side={side} repo={repo} />
          <Counts side={side} repo={repo} />
          <span className="flex-1" />
          <Tooltip
            content={
              commitChord ? t("Commit… ({key})", { key: formatChord(commitChord) }) : t("Commit…")
            }
          >
            <button
              type="button"
              tabIndex={-1}
              disabled={changes === 0}
              onMouseDown={keepFocus}
              onClick={() => openCommit(side)}
              className="glass-pill flex h-5 shrink-0 items-center rounded bg-accent px-2 font-medium text-accent-foreground disabled:opacity-40"
              data-testid={`git-commit-${side}`}
            >
              {t("Commit")}
            </button>
          </Tooltip>
        </>
      )}
      {problem && !run && <span className="flex-1" />}
      <Tooltip content={t("More Git commands")}>
        <button
          type="button"
          tabIndex={-1}
          aria-label={t("More Git commands")}
          aria-haspopup="menu"
          aria-expanded={more}
          onMouseDown={keepFocus}
          onClick={() => {
            if (Date.now() - moreClosedAt.current > 250) setMore(true)
          }}
          className={`${barButton} w-6 justify-center px-0 text-muted`}
          data-testid={`git-more-button-${side}`}
        >
          <MoreIcon />
        </button>
      </Tooltip>
      {more && (
        <MoreMenu
          side={side}
          repo={repo}
          onClose={() => {
            moreClosedAt.current = Date.now()
            setMore(false)
          }}
        />
      )}
    </div>
  )
}
