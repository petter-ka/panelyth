import type {
  GitBranch,
  GitChangesResult,
  GitLogEntry,
  GitMark,
  GitOp,
  GitProgress,
  GitPullMode,
  GitRepo,
  GitRunParams,
  GitState,
  GitStatusResult,
} from "@panelyth/contracts"
import { hasMarks, markCount } from "@panelyth/renderer-core"
import { t } from "@panelyth/i18n"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { notice, operand } from "./files"
import { pageStoreOf, parentRows, useListingStore, type PanelState } from "./listing"
import { marksOf } from "./marks"
import type { Side } from "./panels"
import { useSettingsStore } from "./settings"

/**
 * Git in the commander (ADR-0043): the status of each panel's folder (the
 * path bar's badge, the Git bar, the rows' marks) and the runs started from
 * them. Status is read when a panel's folder or listing changes, when the
 * commander comes back, when the window gets the focus and after a run;
 * nothing polls.
 */

const SIDES: readonly Side[] = ["left", "right"]

export interface GitSide {
  /** The folder the status is of; null when the panel has none Git can read. */
  dirId: number | null
  status: GitStatusResult | null
  /** The rows' marks by name, and by lowercase name (file systems that ignore case). */
  marks: ReadonlyMap<string, GitMark>
  folded: ReadonlyMap<string, GitMark>
  /** Rows show marks: a folder's own listing (not search results, a branch view…). */
  rows: boolean
}

/** A run, from its start until it is dismissed (a failure stays until then). */
export interface GitRunView {
  opId: number
  repoId: number
  op: GitOp
  side: Side
  state: GitProgress["state"]
  phase: string
  percent: number
  message: string
  reason: string
  /** The branch it was about, for the messages. */
  branch: string
}

export interface CommitDraft {
  side: Side
  dirId: number
  repoId: number
  branch: string
  changes: GitChangesResult | null
  loading: boolean
  error: string | null
  message: string
  amend: boolean
  /**
   * Rows ticked or unticked whose run has not answered yet: they show what
   * was asked for at once, until the list is read again.
   */
  pending: ReadonlyMap<number, boolean>
}

export interface BranchMenu {
  side: Side
  /** Where it opened: the path bar's badge or the Git bar's branch. */
  from: "path" | "bar"
  branches: GitBranch[] | null
  error: string | null
  filter: string
}

interface GitStore {
  /** Git was found; false hides every Git UI. null until the first answer. */
  available: boolean | null
  left: GitSide
  right: GitSide
  /** Runs by repository: one at a time per repository. */
  runs: Readonly<Record<number, GitRunView>>
  commit: CommitDraft | null
  discard: { side: Side; what: string } | null
  newBranch: Side | null
  branchMenu: BranchMenu | null
  history: { side: Side; entries: GitLogEntry[] | null; error: string | null } | null
}

const emptySide = (): GitSide => ({
  dirId: null,
  status: null,
  marks: new Map(),
  folded: new Map(),
  rows: false,
})

export const useGitStore = create<GitStore>(() => ({
  available: null,
  left: emptySide(),
  right: emptySide(),
  runs: {},
  commit: null,
  discard: null,
  newBranch: null,
  branchMenu: null,
  history: null,
}))

const get = useGitStore.getState
const set = useGitStore.setState
const panel = (side: Side): PanelState => useListingStore.getState()[side]

/** Messages of the drafts per repository, kept while the app runs. */
const drafts = new Map<number, string>()

const messageOf = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

/** The folder whose status a panel shows; null in an archive, on a server or with no folder. */
export function gitDirOf(p: PanelState): number | null {
  if (p.dirId === null || p.archive || p.remote || p.disconnected) return null
  return p.dirId
}

const rowsOf = (p: PanelState): boolean => !p.find && !p.branch

const enabled = (): boolean =>
  isBridgeAvailable() && useSettingsStore.getState().settings.showGit && get().available !== false

function marksOfStatus(status: GitStatusResult): Pick<GitSide, "marks" | "folded"> {
  const marks = new Map<string, GitMark>()
  const folded = new Map<string, GitMark>()
  for (const m of status.marks) {
    marks.set(m.name, m)
    folded.set(m.name.toLowerCase(), m)
  }
  return { marks, folded }
}

function patchSide(side: Side, patch: Partial<GitSide>): void {
  set((s) => ({ [side]: { ...s[side], ...patch } }) as Partial<GitStore>)
}

function clearSide(side: Side): void {
  const s = get()[side]
  if (s.status !== null || s.dirId !== null || s.marks.size > 0) set({ [side]: emptySide() })
}

const requests: Record<Side, number> = { left: 0, right: 0 }

/** Reads a panel's status (again). `force` skips the sidecar's moment-old answer. */
export async function refreshGit(side: Side, force = false): Promise<void> {
  const p = panel(side)
  const dirId = gitDirOf(p)
  if (!enabled() || dirId === null) {
    requests[side]++
    clearSide(side)
    return
  }
  const n = ++requests[side]
  // Another folder: its rows must not show the last folder's marks meanwhile.
  if (get()[side].dirId !== dirId) patchSide(side, { dirId, marks: new Map(), folded: new Map() })
  try {
    const status = await bridge.gitStatus(dirId, force)
    if (n !== requests[side]) return
    if (!status.available) {
      set({ available: false, [side]: emptySide() })
      return
    }
    if (get().available !== true) set({ available: true })
    if (!status.repo) {
      patchSide(side, { ...emptySide(), dirId })
      return
    }
    patchSide(side, { dirId, status, rows: rowsOf(panel(side)), ...marksOfStatus(status) })
  } catch {
    if (n === requests[side]) clearSide(side)
  }
}

/** Both panels, or those in one repository. */
function refreshRepo(repoId: number | null, force = true): void {
  for (const side of SIDES) {
    if (repoId === null || get()[side].status?.repo?.repoId === repoId) void refreshGit(side, force)
  }
}

/** The repository a panel shows; null when none. */
export const repoOf = (side: Side): GitRepo | null => get()[side].status?.repo ?? null

/** The run of the panel's repository, if any. */
export function runOf(s: GitStore, side: Side): GitRunView | null {
  const repo = s[side].status?.repo
  return repo ? (s.runs[repo.repoId] ?? null) : null
}

// Marks of whole folders: one object per state, so selectors stay stable.
const INHERITED = Object.fromEntries(
  (["untracked", "ignored"] as const).map((state) => [
    state,
    { name: "", state, staged: false, unstaged: state === "untracked", below: false },
  ]),
) as Record<"untracked" | "ignored", GitMark>

/** A row's mark: its own, the folder's when the folder is untracked or ignored, else null. */
export function markOf(s: GitStore, side: Side, name: string | undefined): GitMark | null {
  const g = s[side]
  if (!name || !g.rows || !g.status) return null
  const own = g.marks.get(name) ?? g.folded.get(name.toLowerCase())
  if (own) return own
  const inherited = g.status.inherited
  return inherited === "untracked" || inherited === "ignored" ? INHERITED[inherited] : null
}

/** The mark of a row, for row components (stable between renders). */
export const useGitMark = (side: Side, name: string | undefined): GitMark | null =>
  useGitStore((s) => markOf(s, side, name))

// --- Runs ------------------------------------------------------------------

function setRun(run: GitRunView): void {
  set((s) => ({ runs: { ...s.runs, [run.repoId]: run } }))
}

/** Dismisses a finished run's message. */
export function dismissRun(repoId: number): void {
  const runs = { ...get().runs }
  if (runs[repoId]?.state === "running") return
  delete runs[repoId]
  set({ runs })
}

export function cancelRun(repoId: number): void {
  const run = get().runs[repoId]
  if (run?.state === "running" && run.opId > 0)
    void bridge.gitCancel(run.opId).catch(() => undefined)
}

/** Starts a run in the panel's repository; its progress arrives as events. */
async function start(side: Side, params: Omit<GitRunParams, "dirId">): Promise<void> {
  const dirId = gitDirOf(panel(side))
  const repo = repoOf(side)
  if (dirId === null || !repo) return
  if (get().runs[repo.repoId]?.state === "running") {
    notice(t("Another Git operation is running in this repository."))
    return
  }
  const base: GitRunView = {
    opId: 0,
    repoId: repo.repoId,
    op: params.op,
    side,
    state: "running",
    phase: "",
    percent: -1,
    message: "",
    reason: "",
    branch: params.branch ?? repo.branch,
  }
  setRun(base)
  try {
    const opId = await bridge.gitRun({ dirId, ...params })
    // Its end may have come first.
    const now = get().runs[repo.repoId]
    if (now && now.opId === 0) setRun({ ...now, opId })
  } catch (error) {
    const reason =
      error instanceof PanelythError
        ? (((error.details as { reason?: unknown } | undefined)?.reason as string) ?? "")
        : ""
    setRun({ ...base, state: "failed", message: messageOf(error), reason })
  }
}

const SUCCESS: Partial<Record<GitOp, (r: GitRunView, p: GitProgress) => string>> = {
  commit: (_r, p) => t("Committed: {summary}", { summary: p.message }),
  push: (r) => t("Pushed {branch}", { branch: r.branch }),
  pull: (r, p) =>
    /up to date/i.test(p.message)
      ? t("{branch} is up to date", { branch: r.branch })
      : t("Pulled {branch}", { branch: r.branch }),
  fetch: () => t("Fetched from the remotes"),
  switch: (r) => t("Switched to {branch}", { branch: r.branch }),
  createBranch: (r) => t("Created and switched to {branch}", { branch: r.branch }),
  discard: (_r, p) =>
    p.left > 0
      ? t("Restored: {restored}. Untracked files kept: {left}", {
          restored: p.restored,
          left: p.left,
        })
      : t("Restored: {restored}", { restored: p.restored }),
}

function onProgress(p: GitProgress): void {
  const known = get().runs[p.repoId]
  const run: GitRunView = {
    opId: p.opId,
    repoId: p.repoId,
    op: p.op,
    side: known?.side ?? "left",
    state: p.state,
    phase: p.phase,
    percent: p.percent,
    message: p.message,
    reason: p.reason,
    branch: known?.branch ?? "",
  }
  // An old run's late report never replaces a newer one.
  if (known && known.opId !== 0 && known.opId > p.opId) return
  if (p.state === "running") {
    setRun(run)
    return
  }
  const commit = get().commit
  if (p.state === "completed") {
    const message = SUCCESS[p.op]?.(run, p)
    // A success says so once and goes; stage and unstage show in the rows.
    const runs = { ...get().runs }
    delete runs[p.repoId]
    set({ runs })
    if (message) notice(message)
    if (p.op === "commit" && commit?.repoId === p.repoId) {
      drafts.delete(p.repoId)
      set({ commit: null })
    }
  } else {
    setRun(run)
  }
  if (commit?.repoId === p.repoId && get().commit) void loadChanges()
  refreshRepo(p.repoId)
}

// --- Commands ---------------------------------------------------------------

/** "notes.txt", or "12 items" for marks. */
function operandLabel(side: Side): string {
  const marks = marksOf(side)
  if (hasMarks(marks)) return t("{count} marked", { count: markCount(marks).toLocaleString() })
  const p = panel(side)
  return pageStoreOf(side).getItem(p.cursor - parentRows(p))?.name ?? ""
}

function ready(side: Side): boolean {
  if (repoOf(side)) return true
  notice(
    get().available === false
      ? t("Git was not found on this computer.")
      : t("This folder is not in a Git repository."),
  )
  return false
}

function withOperand(side: Side, op: "stage" | "unstage"): void {
  if (!ready(side)) return
  const selection = operand(side)
  if (!selection) return notice(t("Choose the files first."))
  void start(side, { op, selection })
}

export const gitStage = (side: Side): void => withOperand(side, "stage")
export const gitUnstage = (side: Side): void => withOperand(side, "unstage")

/** Discard asks first: what it restores is lost. */
export function gitDiscard(side: Side): void {
  if (!ready(side)) return
  if (!operand(side)) return notice(t("Choose the files first."))
  set({ discard: { side, what: operandLabel(side) } })
}

export const closeDiscard = (): void => set({ discard: null })

export function confirmDiscard(): void {
  const d = get().discard
  set({ discard: null })
  if (!d) return
  const selection = operand(d.side)
  if (selection) void start(d.side, { op: "discard", selection })
}

export function gitPull(side: Side, mode: GitPullMode = "ffOnly"): void {
  if (ready(side)) void start(side, { op: "pull", mode })
}

export function gitPush(side: Side): void {
  if (ready(side)) void start(side, { op: "push" })
}

export function gitFetch(side: Side): void {
  if (ready(side)) void start(side, { op: "fetch" })
}

// --- Commit dialog -----------------------------------------------------------

export function openCommit(side: Side): void {
  if (!ready(side)) return
  const repo = repoOf(side)!
  const dirId = gitDirOf(panel(side))!
  set({
    commit: {
      side,
      dirId,
      repoId: repo.repoId,
      branch: repo.branch || repo.head,
      changes: null,
      loading: true,
      error: null,
      message: drafts.get(repo.repoId) ?? "",
      amend: false,
      pending: new Map(),
    },
  })
  void loadChanges()
}

export function closeCommit(): void {
  const c = get().commit
  if (c) drafts.set(c.repoId, c.message)
  set({ commit: null })
}

export async function loadChanges(): Promise<void> {
  const c = get().commit
  if (!c) return
  try {
    const changes = await bridge.gitChanges(c.dirId)
    const now = get().commit
    if (now?.repoId === c.repoId)
      set({ commit: { ...now, changes, loading: false, error: null, pending: new Map() } })
  } catch (error) {
    const now = get().commit
    if (now?.repoId === c.repoId)
      set({ commit: { ...now, loading: false, error: messageOf(error) } })
  }
}

export function setCommitMessage(message: string): void {
  const c = get().commit
  if (c) set({ commit: { ...c, message } })
}

export function setAmend(amend: boolean): void {
  const c = get().commit
  if (c) set({ commit: { ...c, amend } })
}

/** Stages or unstages rows of the dialog's list. */
export function stageRows(items: number[], stage: boolean): void {
  const c = get().commit
  if (!c?.changes || items.length === 0) return
  const pending = new Map(c.pending)
  for (const i of items) pending.set(i, stage)
  set({ commit: { ...c, pending } })
  void start(c.side, {
    op: stage ? "stage" : "unstage",
    changesId: c.changes.changesId,
    items,
  })
}

/** What Commit will do: commit the staged changes, or stage everything first. */
export function commitPlan(c: CommitDraft): "staged" | "all" | "nothing" {
  const entries = c.changes?.entries ?? []
  if (entries.some((e, i) => c.pending.get(i) ?? e.staged)) return "staged"
  if (c.amend) return "staged"
  return entries.length > 0 ? "all" : "nothing"
}

export function commitNow(push: boolean): void {
  const c = get().commit
  if (!c || (c.message.trim() === "" && !c.amend)) return
  const plan = commitPlan(c)
  if (plan === "nothing") return
  drafts.set(c.repoId, c.message)
  void start(c.side, {
    op: "commit",
    message: c.message,
    amend: c.amend,
    stageAll: plan === "all",
    push,
  })
}

// --- Branches ------------------------------------------------------------------

/** When the branch menu last closed: a click on its button that closed it does not reopen it. */
let branchMenuClosedAt = 0

/** The press on a menu's button closed it: its click must not open it again. */
export const branchMenuJustClosed = (): boolean => Date.now() - branchMenuClosedAt < 250

export async function openBranchMenu(side: Side, from: BranchMenu["from"]): Promise<void> {
  if (!ready(side)) return
  const dirId = gitDirOf(panel(side))!
  set({ branchMenu: { side, from, branches: null, error: null, filter: "" } })
  try {
    const { branches } = await bridge.gitBranches(dirId)
    const m = get().branchMenu
    if (m?.side === side) set({ branchMenu: { ...m, branches } })
  } catch (error) {
    const m = get().branchMenu
    if (m?.side === side) set({ branchMenu: { ...m, error: messageOf(error) } })
  }
}

export function closeBranchMenu(): void {
  branchMenuClosedAt = Date.now()
  set({ branchMenu: null })
}

export function setBranchFilter(filter: string): void {
  const m = get().branchMenu
  if (m) set({ branchMenu: { ...m, filter } })
}

export function switchBranch(side: Side, name: string): void {
  closeBranchMenu()
  if (ready(side)) void start(side, { op: "switch", branch: name })
}

export const openNewBranch = (side: Side): void => {
  if (ready(side)) set({ newBranch: side, branchMenu: null })
}
export const closeNewBranch = (): void => set({ newBranch: null })

export function createBranch(name: string): void {
  const side = get().newBranch
  set({ newBranch: null })
  if (side && name.trim()) void start(side, { op: "createBranch", branch: name.trim() })
}

// --- History ---------------------------------------------------------------------

export async function openHistory(side: Side): Promise<void> {
  if (!ready(side)) return
  const dirId = gitDirOf(panel(side))!
  set({ history: { side, entries: null, error: null } })
  try {
    const { entries } = await bridge.gitLog(dirId, 50)
    if (get().history?.side === side) set({ history: { side, entries, error: null } })
  } catch (error) {
    if (get().history?.side === side)
      set({ history: { side, entries: [], error: messageOf(error) } })
  }
}

export const closeHistory = (): void => set({ history: null })

// --- Following the panels ----------------------------------------------------------

/** Changes of a listing are read this long after the last one. */
export const GIT_DEBOUNCE_MS = 400
/** The window's focus reads again at most this often. */
const FOCUS_MS = 2000

/** Follows the panels, the runs and the app's visibility. Returns the stop. */
export function startGit(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  let shown = true
  let lastFocus = 0
  const timers: Record<Side, ReturnType<typeof setTimeout> | null> = { left: null, right: null }
  const later = (side: Side, force: boolean, ms = GIT_DEBOUNCE_MS): void => {
    if (timers[side]) clearTimeout(timers[side])
    timers[side] = setTimeout(() => {
      timers[side] = null
      if (shown) void refreshGit(side, force)
    }, ms)
  }
  const offListing = useListingStore.subscribe((s, prev) => {
    for (const side of SIDES) {
      const a = s[side]
      const b = prev[side]
      if (gitDirOf(a) !== gitDirOf(b) || rowsOf(a) !== rowsOf(b)) {
        if (timers[side]) clearTimeout(timers[side])
        if (shown) void refreshGit(side)
      } else if (a.query && b.query && a.query.queryId === b.query.queryId) {
        // The folder's entries changed (the watcher): the status may have too.
        if (a.query.version !== b.query.version) later(side, true)
      }
    }
  })
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.settings.showGit !== prev.settings.showGit) refreshRepo(null, false)
  })
  const offProgress = bridge.on("git.progress", onProgress)
  const offShown = bridge.on("app.visibility", ({ app, visible }) => {
    if (app !== "commander") return
    shown = visible
    if (visible) refreshRepo(null)
  })
  const onFocus = (): void => {
    if (!shown || Date.now() - lastFocus < FOCUS_MS) return
    lastFocus = Date.now()
    // A commit or a checkout made in a terminal meanwhile.
    refreshRepo(null)
  }
  window.addEventListener("focus", onFocus)
  for (const side of SIDES) void refreshGit(side)
  return () => {
    offListing()
    offSettings()
    offProgress()
    offShown()
    window.removeEventListener("focus", onFocus)
    for (const side of SIDES) if (timers[side]) clearTimeout(timers[side])
  }
}

/** Tests. */
export function resetGit(): void {
  drafts.clear()
  branchMenuClosedAt = 0
  requests.left++
  requests.right++
  set({
    available: null,
    left: emptySide(),
    right: emptySide(),
    runs: {},
    commit: null,
    discard: null,
    newBranch: null,
    branchMenu: null,
    history: null,
  })
}

/** The colour token of a state, for names, letters and dots. */
export const GIT_TONE: Record<GitState, string> = {
  conflicted: "var(--danger)",
  modified: "var(--warning)",
  deleted: "var(--danger)",
  added: "var(--success)",
  renamed: "var(--success)",
  untracked: "var(--success)",
  ignored: "var(--muted)",
}

/** The letter of a state (as editors show them). */
export const GIT_LETTER: Record<GitState, string> = {
  conflicted: "!",
  modified: "M",
  deleted: "D",
  added: "A",
  renamed: "R",
  untracked: "U",
  ignored: "I",
}
