import type { Crumb, GitProgress } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { resetCarry, startPanels } from "./features/carry"
import { runPanelAction } from "./features/commands"
import { GIT_DEBOUNCE_MS, resetGit, startGit, useGitStore } from "./features/git"
import { resetListing } from "./features/listing"
import { usePanelsStore } from "./features/panels"
import { SETTINGS_KEY, updateSettings } from "./features/settings"
import { folder, gitMark, gitStatus, installFakeCommander, type FakeGit } from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Git in the commander (ADR-0043): the badge, the rows' marks, the Git bar,
// commit, discard, branches and runs with their progress.

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const REPO: Crumb = { name: "repo", path: "C:\\repo" }
const OTHER: Crumb = { name: "other", path: "C:\\other" }

// repo: dir000000, dir000001, file000000.txt..file000002.txt.
const repo = () => folder(10, REPO.path, [ROOT, REPO], 2, 3)
const other = () => folder(20, OTHER.path, [ROOT, OTHER], 0, 2)

const dirty = () =>
  gitStatus({ counts: { staged: 1, changed: 1, untracked: 1, conflicted: 0 }, ahead: 2 }, [
    gitMark("file000000.txt", "modified"),
    gitMark("file000001.txt", "added", { staged: true, unstaged: false }),
    gitMark("dir000000", "untracked", { below: true }),
    gitMark("file000002.txt", "ignored"),
  ])

let stops: (() => void)[] = []

async function start(git: FakeGit | undefined, path = REPO.path) {
  const fake = installFakeCommander({
    folders: [repo(), other()],
    home: path,
    volumes: [],
    settings: { [SETTINGS_KEY]: { v: 3 } },
    ...(git && { git }),
  })
  render(<AppShell />)
  await act(async () => {
    stops = [await startPanels(), startGit()]
  })
  await waitFor(() => expect(rows("left").length).toBeGreaterThan(2))
  return fake
}

const grid = (side: "left" | "right") => screen.getByTestId(`grid-${side}`)
const rows = (side: "left" | "right") => grid(side).querySelectorAll("[data-row]")
const rowOf = (name: string) =>
  [...grid("left").querySelectorAll<HTMLElement>("[data-row]")].find((r) =>
    r.textContent?.includes(name.replace(/\.txt$/, "")),
  )!

const progress = (p: Partial<GitProgress>): GitProgress => ({
  opId: 1,
  repoId: 1,
  op: "pull",
  state: "running",
  phase: "",
  percent: -1,
  message: "",
  reason: "",
  restored: 0,
  left: 0,
  ...p,
})

beforeEach(() => {
  mockViewport(900, 600)
  resetListing()
  resetCarry()
  resetGit()
  resetBridgeCache()
  updateSettings({ showGit: true })
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
})

describe("a folder in a repository", () => {
  it("shows the branch in the path bar and the Git bar", async () => {
    await start({ statuses: { 10: dirty() } })
    const badge = await screen.findByTestId("git-badge-left")
    expect(badge).toHaveTextContent("main")
    expect(badge).toHaveAccessibleName(/Git repository repo · Branch: main · Changes: 3/)
    const bar = screen.getByTestId("git-bar-left")
    expect(within(bar).getByTestId("git-branch-left")).toHaveTextContent("main")
    // Ahead by two: a click pushes them.
    expect(within(bar).getByTestId("git-sync-left")).toHaveAccessibleName(
      "Commits to push to origin/main: 2",
    )
    expect(within(bar).getByTestId("git-counts-left")).toHaveAccessibleName(
      "Changed: 1, Staged: 1, Untracked: 1",
    )
  })

  it("marks the rows: a letter per file, a dot for a folder with changes inside, nothing for ignored", async () => {
    await start({ statuses: { 10: dirty() } })
    await screen.findByTestId("git-badge-left")
    await waitFor(() =>
      expect(rowOf("file000000").querySelector("[data-git]")).toHaveAttribute(
        "data-git",
        "modified",
      ),
    )
    const added = rowOf("file000001").querySelector("[data-git]")!
    expect(added).toHaveTextContent("A")
    expect(added).toHaveAttribute("data-staged", "true")
    expect(added).toHaveAccessibleName("Added, staged")
    const dir = rowOf("dir000000").querySelector("[data-git]")!
    expect(dir).toHaveAccessibleName("Changes inside: Untracked")
    expect(dir).toHaveTextContent("")
    expect(rowOf("file000002").querySelector("[data-git]")).toBeNull()
    expect(rowOf("dir000001").querySelector("[data-git]")).toBeNull()
  })

  it("shows nothing outside a repository, or without Git", async () => {
    const fake = await start({ statuses: {} })
    await waitFor(() => expect(fake.api.git.status).toHaveBeenCalled())
    expect(screen.queryByTestId("git-badge-left")).toBeNull()
    expect(screen.queryByTestId("git-bar-left")).toBeNull()
  })

  it("is off when Git is not installed", async () => {
    const fake = await start(undefined)
    await waitFor(() => expect(useGitStore.getState().available).toBe(false))
    expect(screen.queryByTestId("git-badge-left")).toBeNull()
    const calls = fake.api.git.status.mock.calls.length
    // Nothing more is asked once Git is known to be missing.
    await act(async () => {
      runPanelAction("left", "view.refresh")
    })
    expect(fake.api.git.status.mock.calls.length).toBe(calls)
  })

  it("can be switched off in Settings", async () => {
    await start({ statuses: { 10: dirty() } })
    await screen.findByTestId("git-badge-left")
    await act(async () => updateSettings({ showGit: false }))
    await waitFor(() => expect(screen.queryByTestId("git-badge-left")).toBeNull())
    expect(screen.queryByTestId("git-bar-left")).toBeNull()
    expect(rowOf("file000000").querySelector("[data-git]")).toBeNull()
  })

  it("reads the status again when the folder's entries change", async () => {
    const fake = await start({ statuses: { 10: dirty() } })
    await screen.findByTestId("git-badge-left")
    const before = fake.api.git.status.mock.calls.length
    await act(async () => fake.relist(10))
    await waitFor(() => expect(fake.api.git.status.mock.calls.length).toBeGreaterThan(before), {
      timeout: GIT_DEBOUNCE_MS + 1000,
    })
    // Read afresh: the files changed.
    expect(fake.api.git.status.mock.calls.at(-1)).toEqual([10, true])
  })
})

describe("runs", () => {
  it("stages the cursor entry and discards after asking", async () => {
    const fake = await start({ statuses: { 10: dirty() } })
    await screen.findByTestId("git-badge-left")
    // From ".." to the first entry.
    await act(async () => {
      fireEvent.keyDown(grid("left"), { key: "ArrowDown" })
    })
    await act(async () => runPanelAction("left", "git.stage"))
    expect(fake.api.git.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ dirId: 10, op: "stage", selection: expect.any(Object) }),
    )
    await act(async () =>
      fake.emit("git.progress", progress({ opId: 1, op: "stage", state: "completed" })),
    )

    await act(async () => runPanelAction("left", "git.discard"))
    const dialog = screen.getByTestId("git-discard-dialog")
    expect(fake.api.git.run).toHaveBeenCalledTimes(1)
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: "discard", selection: expect.any(Object) }),
    )
    await act(async () =>
      fake.emit(
        "git.progress",
        progress({ opId: 2, op: "discard", state: "completed", restored: 2, left: 1 }),
      ),
    )
    expect(screen.getByTestId("files-notice")).toHaveTextContent(
      "Restored: 2. Untracked files kept: 1",
    )
  })

  it("shows a run's progress with Stop, and a failure with what to do", async () => {
    const fake = await start({ statuses: { 10: dirty() } })
    await screen.findByTestId("git-bar-left")
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-sync-left"))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({ dirId: 10, op: "push" })
    await act(async () =>
      fake.emit(
        "git.progress",
        progress({ opId: 1, op: "push", phase: "Writing objects", percent: 45 }),
      ),
    )
    const bar = screen.getByTestId("git-bar-left")
    expect(within(bar).getByRole("status")).toHaveTextContent(/Pushing…\s*Writing objects 45%/)
    await act(async () => {
      fireEvent.click(within(bar).getByTestId("git-stop-left"))
    })
    expect(fake.api.git.cancel).toHaveBeenCalledWith(1)

    await act(async () =>
      fake.emit(
        "git.progress",
        progress({
          opId: 1,
          op: "pull",
          state: "failed",
          reason: "diverged",
          message: "Not possible to fast-forward",
        }),
      ),
    )
    const failed = within(bar).getByTestId("git-failed-left")
    expect(failed).toHaveTextContent("Pull failed")
    expect(failed).toHaveTextContent("Pull with rebase or merge")
    await act(async () => {
      fireEvent.click(within(bar).getByRole("button", { name: "Pull with rebase" }))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({ dirId: 10, op: "pull", mode: "rebase" })
  })

  it("switches branches from the menu, and creates one", async () => {
    const fake = await start({
      statuses: { 10: dirty() },
      branches: [
        {
          name: "main",
          remote: false,
          current: true,
          upstream: "origin/main",
          subject: "x",
          when: 1,
        },
        { name: "topic", remote: false, current: false, upstream: "", subject: "y", when: 1 },
        {
          name: "origin/release",
          remote: true,
          current: false,
          upstream: "",
          subject: "z",
          when: 1,
        },
      ],
    })
    await screen.findByTestId("git-badge-left")
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-branch-left"))
    })
    const menu = await screen.findByTestId("git-branches-left")
    await waitFor(() => expect(within(menu).getByText("origin/release")).toBeInTheDocument())
    expect(within(menu).getByRole("menuitemcheckbox", { name: /main/ })).toHaveAttribute(
      "aria-checked",
      "true",
    )
    // The search field filters.
    fireEvent.change(within(menu).getByRole("searchbox"), { target: { value: "top" } })
    expect(within(menu).queryByText("origin/release")).toBeNull()
    await act(async () => {
      fireEvent.click(within(menu).getByText("topic"))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({ dirId: 10, op: "switch", branch: "topic" })
    await act(async () =>
      fake.emit("git.progress", progress({ opId: 1, op: "switch", state: "completed" })),
    )
    expect(screen.getByTestId("files-notice")).toHaveTextContent("Switched to topic")

    await act(async () => runPanelAction("left", "git.branches"))
    await act(async () => {
      fireEvent.click(
        within(await screen.findByTestId("git-branches-left")).getByText("New branch…"),
      )
    })
    const create = screen.getByTestId("git-new-branch-dialog")
    fireEvent.change(within(create).getByLabelText("Branch name"), {
      target: { value: "my new idea" },
    })
    expect(within(create).getByLabelText("Branch name")).toHaveValue("my-new-idea")
    await act(async () => {
      fireEvent.click(within(create).getByRole("button", { name: "Create and switch" }))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({
      dirId: 10,
      op: "createBranch",
      branch: "my-new-idea",
    })
  })
})

describe("the commit dialog", () => {
  const changes = [
    { path: "src/app.ts", orig: "", state: "modified" as const, staged: true, unstaged: false },
    { path: "README.md", orig: "", state: "modified" as const, staged: false, unstaged: true },
    { path: "notes/", orig: "", state: "untracked" as const, staged: false, unstaged: true },
  ]

  it("lists staged and other changes; a tick stages; Ctrl+Enter commits", async () => {
    const fake = await start({ statuses: { 10: dirty() }, changes })
    await screen.findByTestId("git-bar-left")
    await act(async () => {
      fireEvent.click(screen.getByTestId("git-commit-left"))
    })
    const dialog = screen.getByTestId("git-commit-dialog")
    await waitFor(() => expect(within(dialog).getAllByTestId("git-change")).toHaveLength(3))
    expect(within(dialog).getByTestId("git-commit-plan")).toHaveTextContent(
      "Staged changes to commit: 1",
    )
    await act(async () => {
      fireEvent.click(within(dialog).getByLabelText("Stage README.md"))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({
      dirId: 10,
      op: "stage",
      changesId: 7,
      items: [1],
    })
    await act(async () =>
      fake.emit("git.progress", progress({ opId: 1, op: "stage", state: "completed" })),
    )
    // The list is read again after the run.
    expect(fake.api.git.changes.mock.calls.length).toBeGreaterThanOrEqual(2)

    const message = within(dialog).getByTestId("git-commit-message")
    expect(within(dialog).getByTestId("git-commit-submit")).toBeDisabled()
    fireEvent.change(message, { target: { value: "Fix the reader" } })
    await act(async () => {
      fireEvent.keyDown(message, { key: "Enter", ctrlKey: true })
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith({
      dirId: 10,
      op: "commit",
      message: "Fix the reader",
      amend: false,
      stageAll: false,
      push: false,
    })
    await act(async () =>
      fake.emit(
        "git.progress",
        progress({
          opId: 2,
          op: "commit",
          state: "completed",
          message: "[main 9f8e7d6] Fix the reader",
        }),
      ),
    )
    expect(screen.queryByTestId("git-commit-dialog")).toBeNull()
    expect(screen.getByTestId("files-notice")).toHaveTextContent(
      "Committed: [main 9f8e7d6] Fix the reader",
    )
  })

  it("stages everything first when nothing is staged, and keeps a failed commit's message", async () => {
    const fake = await start({
      statuses: { 10: dirty() },
      changes: changes.map((c) => ({ ...c, staged: false, unstaged: true })),
    })
    await screen.findByTestId("git-bar-left")
    await act(async () => runPanelAction("left", "git.commit"))
    const dialog = screen.getByTestId("git-commit-dialog")
    await waitFor(() =>
      expect(within(dialog).getByTestId("git-commit-plan")).toHaveTextContent(
        "Nothing is staged: all 3 changes will be staged and committed.",
      ),
    )
    expect(within(dialog).getByTestId("git-commit-submit")).toHaveTextContent(
      "Stage all and commit",
    )
    fireEvent.change(within(dialog).getByTestId("git-commit-message"), {
      target: { value: "Everything" },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByTestId("git-commit-push"))
    })
    expect(fake.api.git.run).toHaveBeenLastCalledWith(
      expect.objectContaining({ op: "commit", stageAll: true, push: true }),
    )
    await act(async () =>
      fake.emit(
        "git.progress",
        progress({ opId: 1, op: "commit", state: "failed", message: "pre-commit hook failed" }),
      ),
    )
    expect(within(dialog).getByRole("alert")).toHaveTextContent("pre-commit hook failed")
    // Closed and opened again: the message is still there.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    })
    await act(async () => runPanelAction("left", "git.commit"))
    expect(
      within(screen.getByTestId("git-commit-dialog")).getByTestId("git-commit-message"),
    ).toHaveValue("Everything")
  })
})
