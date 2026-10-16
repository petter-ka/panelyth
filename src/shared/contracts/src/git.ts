// Git in the commander (ADR-0043). The sidecar runs the installed Git; a
// renderer names folders by id and files by a selection or by rows of a
// change list, never by path.
import type { SelectionDescriptor } from "./rpc"

/** What Git says of a path, strongest first for a folder. */
export type GitState =
  "conflicted" | "modified" | "deleted" | "added" | "renamed" | "untracked" | "ignored"

export const GIT_STATES: readonly GitState[] = [
  "conflicted",
  "modified",
  "deleted",
  "added",
  "renamed",
  "untracked",
  "ignored",
]

/** One child of the panel's folder with a status. */
export interface GitMark {
  name: string
  state: GitState
  /** The index has a change (it will be in the next commit). */
  staged: boolean
  /** The working tree has a change not in the index. */
  unstaged: boolean
  /** A folder: its state comes from what is inside it. */
  below: boolean
}

export interface GitCounts {
  staged: number
  changed: number
  untracked: number
  conflicted: number
}

/** What the repository is in the middle of. */
export type GitOperation = "" | "merging" | "rebasing" | "cherryPicking" | "reverting" | "bisecting"

export interface GitRepo {
  /** The repository's id for this run of the app (progress events name it). */
  repoId: number
  /** The working tree's top folder (shown, and opened by "Go to the top folder"). */
  root: string
  name: string
  /** The panel's folder inside the working tree; "" at the top. */
  rel: string
  /** "" when HEAD is detached. */
  branch: string
  /** The commit, short; "" before the first commit. */
  head: string
  unborn: boolean
  upstream: string
  ahead: number
  behind: number
  stashes: number
  operation: GitOperation
  counts: GitCounts
}

export interface GitDirParams {
  dirId: number
  /** Read the status again instead of one a moment old. */
  force?: boolean
}

export interface GitStatusResult {
  /** Git was found on this computer; without it there is no Git UI. */
  available: boolean
  /** null: the folder is not in a repository. */
  repo: GitRepo | null
  marks: GitMark[]
  /** The whole folder is untracked or ignored, and so is everything in it; "" when not. */
  inherited: GitState | ""
  truncated: boolean
  /** The folder is in a repository, but Git would not give its status. */
  problem: { message: string; reason: string } | null
}

/** A row of the commit dialog's change list. */
export interface GitChange {
  /** Relative to the working tree, with "/"; a folder listed whole ends in "/". */
  path: string
  /** Where a rename came from; "" otherwise. */
  orig: string
  state: GitState
  staged: boolean
  unstaged: boolean
}

export interface GitChangesResult {
  /** Names this list in git.run (`items` are its row indexes). */
  changesId: number
  entries: GitChange[]
  truncated: boolean
}

export const MAX_GIT_CHANGES = 2000
/** The marks of one folder (the rest is `truncated`). */
export const MAX_GIT_MARKS = 5000
export const MAX_GIT_ITEMS = 10_000
export const MAX_COMMIT_MESSAGE_CHARS = 16_000
export const MAX_BRANCH_NAME_CHARS = 250

export type GitOp =
  "stage" | "unstage" | "discard" | "commit" | "pull" | "push" | "fetch" | "switch" | "createBranch"

export const GIT_OPS: readonly GitOp[] = [
  "stage",
  "unstage",
  "discard",
  "commit",
  "pull",
  "push",
  "fetch",
  "switch",
  "createBranch",
]

/** How a pull joins diverged histories: fast-forward only (the default), rebase or merge. */
export type GitPullMode = "ffOnly" | "rebase" | "merge"

export interface GitRunParams {
  dirId: number
  op: GitOp
  /** stage, unstage, discard: the panel's selection… */
  selection?: SelectionDescriptor
  /** …or rows of a change list. */
  changesId?: number
  items?: number[]
  /** commit */
  message?: string
  amend?: boolean
  /** Stage every change before committing. */
  stageAll?: boolean
  /** Push after the commit. */
  push?: boolean
  /** pull */
  mode?: GitPullMode
  /** switch, createBranch */
  branch?: string
}

export interface GitRunResult {
  opId: number
}

export interface GitOpIdParams {
  opId: number
}

export interface GitCancelResult {
  cancelled: boolean
}

export interface GitBranch {
  name: string
  remote: boolean
  current: boolean
  upstream: string
  /** The last commit's subject and time (Unix ms). */
  subject: string
  when: number
}

export interface GitBranchesResult {
  branches: GitBranch[]
  truncated: boolean
}

export interface GitLogParams {
  dirId: number
  limit?: number
}

export interface GitLogEntry {
  hash: string
  author: string
  when: number
  subject: string
  /** Branches and tags at the commit ("HEAD -> main, origin/main"). */
  refs: string
}

export interface GitLogResult {
  entries: GitLogEntry[]
}

export type GitRunState = "running" | "completed" | "failed" | "cancelled"

/** A run's progress (`git.progress`); the final state is always delivered. */
export interface GitProgress {
  opId: number
  repoId: number
  op: GitOp
  state: GitRunState
  /** Git's phase ("Receiving objects"); "" when it said none. */
  phase: string
  /** 0..100, or -1 when unknown. */
  percent: number
  /** Git's last line when done, its error when failed. */
  message: string
  /**
   * Why a run failed, when known: "unsafe", "auth", "diverged", "conflict",
   * "dirty", "noUpstream", "noRemote", "badName".
   */
  reason: string
  /** discard: paths restored, and untracked ones left alone. */
  restored: number
  left: number
}
