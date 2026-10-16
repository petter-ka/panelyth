import type { GitChange } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { Button, DialogWindow, fieldClass, fieldLook, Spinner } from "@panelyth/ui"
import { useEffect, useRef, useState } from "react"
import { bridge } from "../bridge"
import { notice } from "../features/files"
import { formatListDate } from "../features/format"
import {
  closeCommit,
  closeDiscard,
  closeHistory,
  closeNewBranch,
  commitNow,
  commitPlan,
  confirmDiscard,
  createBranch,
  GIT_LETTER,
  GIT_TONE,
  repoOf,
  setAmend,
  setCommitMessage,
  stageRows,
  useGitStore,
} from "../features/git"

// The Git dialogs (ADR-0043): commit, discard, a new branch and the history.

/** Rows a section of the commit dialog shows; the rest is counted. */
const SHOWN = 400

/** A row of the change list: a tick that stages, the letter, the path. */
function ChangeRow({
  change,
  index,
  busy,
  pending,
}: {
  change: GitChange
  index: number
  busy: boolean
  /** Ticked or unticked, its run not answered yet. */
  pending: boolean | undefined
}) {
  const path = change.path.replace(/\/$/, "")
  const cut = path.lastIndexOf("/")
  const folder = cut >= 0 ? path.slice(0, cut + 1) : ""
  const name = cut >= 0 ? path.slice(cut + 1) : path
  const partly = pending === undefined && change.staged && change.unstaged
  const ticked = pending ?? (change.staged && !change.unstaged)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = partly
  }, [partly])
  const color = GIT_TONE[change.state]
  return (
    <label
      className="flex h-7 cursor-default items-center gap-2 rounded px-2 hover:bg-raised"
      data-testid="git-change"
      data-path={change.path}
    >
      <input
        ref={box}
        type="checkbox"
        disabled={busy && pending === undefined}
        checked={ticked}
        onChange={() => stageRows([index], !ticked)}
        aria-label={t("Stage {path}", { path })}
        className="accent-[var(--accent)]"
      />
      <span
        className="w-3 shrink-0 text-center font-mono text-[0.6875rem] font-semibold"
        style={{ color }}
        aria-hidden="true"
      >
        {GIT_LETTER[change.state]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[0.75rem]">
        <span style={{ color }}>{name}</span>
        {folder && <span className="ml-2 text-muted">{folder}</span>}
        {change.orig && <span className="ml-2 text-muted">← {change.orig}</span>}
      </span>
    </label>
  )
}

function Section({
  title,
  rows,
  busy,
  action,
  pending,
}: {
  title: string
  rows: { change: GitChange; index: number }[]
  busy: boolean
  action: { label: string; stage: boolean } | null
  pending: ReadonlyMap<number, boolean>
}) {
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-[1] flex h-7 items-center gap-2 bg-chrome px-2 text-2xs font-semibold tracking-wide text-muted uppercase">
        <span>{title}</span>
        <span className="rounded-full bg-raised px-1.5 font-normal normal-case tabular-nums">
          {rows.length}
        </span>
        <span className="flex-1" />
        {action && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              stageRows(
                rows.map((r) => r.index),
                action.stage,
              )
            }
            className="rounded px-1.5 py-0.5 font-medium text-accent normal-case hover:bg-raised disabled:opacity-50"
          >
            {action.label}
          </button>
        )}
      </div>
      {rows.slice(0, SHOWN).map((r) => (
        <ChangeRow
          key={r.change.path}
          change={r.change}
          index={r.index}
          busy={busy}
          pending={pending.get(r.index)}
        />
      ))}
      {rows.length > SHOWN && (
        <p className="px-2 py-1 text-2xs text-muted">
          {t("And {count} more", { count: rows.length - SHOWN })}
        </p>
      )}
    </div>
  )
}

/**
 * Commit (Ctrl+Shift+G): the changes in two lists, staged and not (a tick
 * stages or unstages), the message, Amend, and Commit or Commit and push.
 * With nothing staged, Commit stages everything first, and says so.
 */
export function CommitDialog() {
  const c = useGitStore((s) => s.commit)
  const run = useGitStore((s) => (s.commit ? (s.runs[s.commit.repoId] ?? null) : null))
  if (!c) return null
  const entries = c.changes?.entries ?? []
  // A row stays in its section until the list is read again, so it does not
  // jump away under the pointer while its tick is answered.
  const stagedCount = entries.filter((e, i) => c.pending.get(i) ?? (e.staged && !e.unstaged)).length
  const staged = entries
    .map((change, index) => ({ change, index }))
    .filter((r) => r.change.staged && !r.change.unstaged)
  const unstaged = entries
    .map((change, index) => ({ change, index }))
    .filter((r) => !(r.change.staged && !r.change.unstaged))
  const busy = run?.state === "running"
  const committing = busy && run.op === "commit"
  const failed = run?.state === "failed" && run.op === "commit" ? run : null
  const plan = commitPlan(c)
  const summary = c.message.split("\n")[0] ?? ""
  const canCommit = !busy && plan !== "nothing" && (c.message.trim() !== "" || c.amend)
  const planText =
    plan === "all"
      ? t("Nothing is staged: all {count} changes will be staged and committed.", {
          count: entries.length,
        })
      : plan === "staged"
        ? c.amend && stagedCount === 0
          ? t("The last commit gets the new message.")
          : t("Staged changes to commit: {count}", { count: stagedCount })
        : t("There is nothing to commit.")
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeCommit()
      }}
      title={t("Commit to {branch}", { branch: c.branch })}
      contentClassName="w-[min(44rem,calc(100vw-2rem))]"
    >
      <form
        data-testid="git-commit-dialog"
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          if (canCommit) commitNow(false)
        }}
      >
        <div
          className="relative max-h-[min(18rem,40vh)] min-h-24 overflow-y-auto rounded-md border border-border bg-canvas py-1"
          aria-busy={c.loading || busy}
        >
          {c.loading && !c.changes ? (
            <p className="flex items-center gap-2 px-3 py-2 text-muted">
              <Spinner size={12} /> {t("Reading the changes…")}
            </p>
          ) : c.error ? (
            <p className="px-3 py-2 text-danger">{c.error}</p>
          ) : entries.length === 0 ? (
            <p className="px-3 py-2 text-muted">{t("No changes")}</p>
          ) : (
            <>
              <Section
                title={t("Staged")}
                rows={staged}
                busy={busy}
                pending={c.pending}
                action={{ label: t("Unstage all"), stage: false }}
              />
              <Section
                title={t("Changes")}
                rows={unstaged}
                busy={busy}
                pending={c.pending}
                action={{ label: t("Stage all"), stage: true }}
              />
            </>
          )}
          {c.changes?.truncated && (
            <p className="px-3 py-1 text-2xs text-muted">
              {t("Only the first changes are listed.")}
            </p>
          )}
        </div>
        <label className="flex flex-col gap-1">
          <span className="flex items-baseline justify-between text-muted">
            <span>{t("Message")}</span>
            {summary.length > 72 && (
              <span className="text-2xs text-warning">
                {t("The first line is {count} characters; 72 or fewer reads best.", {
                  count: summary.length,
                })}
              </span>
            )}
          </span>
          <textarea
            autoFocus
            rows={4}
            value={c.message}
            maxLength={16_000}
            spellCheck
            placeholder={t("Summary on the first line, details below")}
            onChange={(e) => setCommitMessage(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                if (canCommit) commitNow(e.shiftKey)
              }
            }}
            className={`resize-y px-2 py-1.5 text-xs leading-relaxed ${fieldLook}`}
            data-testid="git-commit-message"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={c.amend}
            onChange={(e) => setAmend(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span>{t("Amend the last commit")}</span>
        </label>
        {failed && (
          <p
            role="alert"
            className="max-h-24 overflow-y-auto rounded-md px-2 py-1.5 whitespace-pre-wrap text-danger bg-danger/10"
          >
            {failed.message}
          </p>
        )}
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-2xs text-muted" data-testid="git-commit-plan">
            {committing ? (
              <span className="flex items-center gap-1.5">
                <Spinner size={12} /> {run.phase || t("Committing…")}
              </span>
            ) : (
              planText
            )}
          </p>
          <Button onClick={closeCommit}>{t("Cancel")}</Button>
          <Button
            disabled={!canCommit}
            onClick={() => commitNow(true)}
            title={t("Commit, then push (Ctrl+Shift+Enter)")}
            data-testid="git-commit-push"
          >
            {t("Commit and push")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!canCommit}
            title={t("Commit (Ctrl+Enter)")}
            data-testid="git-commit-submit"
          >
            {plan === "all" ? t("Stage all and commit") : t("Commit")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

/** Discard asks first: tracked files go back to their last commit. */
export function DiscardDialog() {
  const d = useGitStore((s) => s.discard)
  if (!d) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeDiscard()
      }}
      title={t("Discard changes to {what}?", { what: d.what })}
      description={t(
        "Tracked files go back to their last committed state. Untracked files are kept. This can't be undone.",
      )}
    >
      <form
        data-testid="git-discard-dialog"
        className="flex justify-end gap-2 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          confirmDiscard()
        }}
      >
        <Button onClick={closeDiscard}>{t("Cancel")}</Button>
        <Button type="submit" variant="danger" autoFocus>
          {t("Discard changes")}
        </Button>
      </form>
    </DialogWindow>
  )
}

/** A new branch from HEAD; spaces become dashes as they are typed. */
export function NewBranchDialog() {
  const side = useGitStore((s) => s.newBranch)
  const [name, setName] = useState("")
  if (!side) return null
  const repo = repoOf(side)
  const from = repo ? repo.branch || repo.head : ""
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) {
          setName("")
          closeNewBranch()
        }
      }}
      title={t("New branch")}
      {...(from && {
        description: t("It starts from {branch} and becomes the current branch.", { branch: from }),
      })}
    >
      <form
        data-testid="git-new-branch-dialog"
        className="flex flex-col gap-3 text-xs"
        onSubmit={(e) => {
          e.preventDefault()
          createBranch(name)
          setName("")
        }}
      >
        <input
          autoFocus
          aria-label={t("Branch name")}
          placeholder={t("feature/my-change")}
          value={name}
          maxLength={250}
          spellCheck={false}
          onChange={(e) => setName(e.target.value.replace(/\s+/g, "-"))}
          onKeyDown={(e) => e.stopPropagation()}
          className={`${fieldClass} font-mono`}
        />
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => {
              setName("")
              closeNewBranch()
            }}
          >
            {t("Cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={name.trim() === "" || name.startsWith("-")}
          >
            {t("Create and switch")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

/** The last commits: a click copies a commit's hash. */
export function HistoryDialog() {
  const h = useGitStore((s) => s.history)
  if (!h) return null
  const repo = repoOf(h.side)
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeHistory()
      }}
      title={repo ? t("History of {name}", { name: repo.name }) : t("History")}
      contentClassName="w-[min(46rem,calc(100vw-2rem))]"
    >
      <div
        data-testid="git-history"
        className="max-h-[min(28rem,60vh)] overflow-y-auto rounded-md border border-border bg-canvas text-xs"
      >
        {h.entries === null ? (
          <p className="flex items-center gap-2 px-3 py-2 text-muted">
            <Spinner size={12} /> {t("Reading the history…")}
          </p>
        ) : h.error ? (
          <p className="px-3 py-2 text-danger">{h.error}</p>
        ) : h.entries.length === 0 ? (
          <p className="px-3 py-2 text-muted">{t("No commits yet")}</p>
        ) : (
          <ol>
            {h.entries.map((e, i) => (
              <li key={e.hash}>
                <button
                  type="button"
                  onClick={() =>
                    void bridge
                      .copyText(e.hash)
                      .then(() => notice(t("Copied: {text}", { text: e.hash })))
                      .catch(() => undefined)
                  }
                  title={t("Copy the commit's hash")}
                  className="group flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-raised"
                  data-testid="git-commit-row"
                >
                  {/* A line of commits: a dot per commit, joined. */}
                  <span
                    aria-hidden="true"
                    className="relative mt-1 flex w-2.5 shrink-0 justify-center self-stretch"
                  >
                    {i < h.entries!.length - 1 && (
                      <span className="absolute top-2.5 -bottom-3 w-px bg-border" />
                    )}
                    <span
                      className={`relative size-2.5 rounded-full border-2 ${i === 0 ? "border-accent bg-accent" : "border-muted bg-canvas"}`}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="min-w-0 truncate font-medium text-text">{e.subject}</span>
                      {e.refs
                        .split(",")
                        .map((r) => r.trim().replace(/^HEAD -> /, ""))
                        .filter((r) => r && r !== "HEAD")
                        .slice(0, 3)
                        .map((r) => (
                          <span
                            key={r}
                            className="shrink-0 rounded-full px-1.5 text-2xs font-medium text-accent bg-accent/12"
                          >
                            {r.replace(/^tag: /, "🏷 ")}
                          </span>
                        ))}
                    </span>
                    <span className="mt-0.5 block truncate text-2xs text-muted">
                      {e.author} · {formatListDate(e.when, "relative")}
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-2xs text-muted group-hover:text-accent">
                    {e.hash}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </DialogWindow>
  )
}
