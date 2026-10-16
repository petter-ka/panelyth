import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { removeTemp } from "../../launch"
import { commanderOf, cursorTo, goTo, launch } from "./helpers"

// Git in the commander (ADR-0043), with the installed Git on a repository
// made for the test: the badge, the rows' marks, the Git bar, a commit, a
// new branch, a change noticed as it happens, and discard.

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim()
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "panelyth-git-"))
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.name", "Panelyth Test")
  git(root, "config", "user.email", "test@example.com")
  git(root, "config", "commit.gpgsign", "false")
  git(root, "config", "core.autocrlf", "false")
  writeFileSync(join(root, "alpha.txt"), "one\n")
  mkdirSync(join(root, "src"))
  writeFileSync(join(root, "src", "beta.txt"), "two\n")
  writeFileSync(join(root, ".gitignore"), "*.log\n")
  git(root, "add", "-A")
  git(root, "commit", "-q", "-m", "First")
  // Changed, new, inside a folder, and ignored.
  writeFileSync(join(root, "alpha.txt"), "changed\n")
  writeFileSync(join(root, "notes.txt"), "new\n")
  writeFileSync(join(root, "src", "beta.txt"), "changed too\n")
  writeFileSync(join(root, "debug.log"), "x\n")
  return root
}

const row = (c: Page, name: string) =>
  c.getByTestId("grid-left").locator("[data-id]", { hasText: name }).first()

test.describe("Git in the commander (ADR-0043)", () => {
  test.skip(!hasGit, "Git is not installed")

  test("shows a repository's status and commits, branches and discards from the panel", async () => {
    test.setTimeout(120_000)
    const root = repository()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)

      // The badge says it is a repository, on main, with changes.
      const badge = c.getByTestId("git-badge-left")
      await expect(badge).toContainText("main", { timeout: 15_000 })
      const bar = c.getByTestId("git-bar-left")
      await expect(bar.getByTestId("git-counts-left")).toHaveAccessibleName(
        "Changed: 2, Untracked: 1",
      )
      // The rows: modified, untracked, a folder with changes inside, nothing for ignored.
      await expect(row(c, "alpha").locator("[data-git]")).toHaveAttribute("data-git", "modified")
      await expect(row(c, "notes").locator("[data-git]")).toHaveAttribute("data-git", "untracked")
      await expect(row(c, "src").locator("[data-git]")).toHaveAccessibleName(
        "Changes inside: Modified",
      )
      await expect(row(c, "debug").locator("[data-git]")).toHaveCount(0)
      await c.screenshot({ path: test.info().outputPath("git-panel.png") })

      // Commit: nothing is staged, so everything is staged first.
      await bar.getByTestId("git-commit-left").click()
      const dialog = c.getByTestId("git-commit-dialog")
      await expect(dialog.getByTestId("git-change")).toHaveCount(3)
      await expect(dialog.getByTestId("git-commit-plan")).toContainText(
        "all 3 changes will be staged and committed",
      )
      // A tick stages one file; the plan follows.
      await dialog.getByLabel("Stage alpha.txt").check()
      await expect(dialog.getByTestId("git-commit-plan")).toHaveText(
        "Staged changes to commit: 1",
        { timeout: 10_000 },
      )
      await dialog.getByTestId("git-commit-message").fill("Change alpha")
      await c.screenshot({ path: test.info().outputPath("git-commit.png") })
      await dialog.getByTestId("git-commit-message").press("Control+Enter")
      await expect(dialog).toHaveCount(0, { timeout: 15_000 })
      expect(git(root, "log", "-1", "--format=%s")).toBe("Change alpha")
      await expect(row(c, "alpha").locator("[data-git]")).toHaveCount(0, { timeout: 10_000 })
      await expect(bar.getByTestId("git-counts-left")).toHaveAccessibleName(
        "Changed: 1, Untracked: 1",
      )

      // A new branch from the branch menu.
      await bar.getByTestId("git-branch-left").click()
      const menu = c.getByTestId("git-branches-left")
      await expect(menu.getByRole("menuitemcheckbox", { name: /main/ })).toBeVisible()
      await menu.getByText("New branch…").click()
      const create = c.getByTestId("git-new-branch-dialog")
      await create.getByLabel("Branch name").fill("topic one")
      await create.getByRole("button", { name: "Create and switch" }).click()
      await expect(badge).toContainText("topic-one", { timeout: 15_000 })
      expect(git(root, "branch", "--show-current")).toBe("topic-one")

      // A change made outside the app shows up by itself.
      writeFileSync(join(root, "alpha.txt"), "changed again\n")
      await expect(row(c, "alpha").locator("[data-git]")).toHaveAttribute("data-git", "modified", {
        timeout: 15_000,
      })

      // Discard it from the More menu, after confirming; the untracked file stays.
      await cursorTo(c, "left", "alpha")
      await bar.getByTestId("git-more-button-left").click()
      await c.getByTestId("git-more-left").getByText("Discard changes…").click()
      await c
        .getByTestId("git-discard-dialog")
        .getByRole("button", { name: "Discard changes" })
        .click()
      await expect(row(c, "alpha").locator("[data-git]")).toHaveCount(0, { timeout: 15_000 })
      expect(readFileSync(join(root, "alpha.txt"), "utf8")).toBe("changed\n")
      await expect(row(c, "notes").locator("[data-git]")).toHaveAttribute("data-git", "untracked")

      // Outside the repository nothing shows.
      const outside = mkdtempSync(join(tmpdir(), "panelyth-nogit-"))
      writeFileSync(join(outside, "plain.txt"), "x")
      await goTo(c, "left", outside)
      await expect(badge).toHaveCount(0)
      await expect(bar).toHaveCount(0)
      removeTemp(outside)
    } finally {
      await app.close()
      removeTemp(root)
    }
  })

  test("a push without a remote says why", async () => {
    test.setTimeout(60_000)
    const root = repository()
    const { app } = await launch("commander")
    try {
      const c = await commanderOf(app)
      await goTo(c, "left", root)
      const bar = c.getByTestId("git-bar-left")
      // No upstream: the sync button publishes the branch.
      await bar.getByTestId("git-sync-left").click()
      await expect(bar.getByTestId("git-failed-left")).toContainText("Push failed", {
        timeout: 15_000,
      })
      await expect(bar.getByTestId("git-failed-left")).toContainText(
        "This repository has no remote.",
      )
      await bar.getByRole("button", { name: "Dismiss" }).click()
      await expect(bar.getByTestId("git-failed-left")).toHaveCount(0)
    } finally {
      await app.close()
      removeTemp(root)
    }
  })
})
