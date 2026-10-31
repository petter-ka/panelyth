import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test, type Page } from "@playwright/test"
import { removeTemp } from "../launch"
import { commanderOf, cursorTo, goTo, launch } from "./commander/helpers"

// Each app lists the jobs it started (ADR-0031, amended 2026-10-31): the jobs
// run in one queue, but the commander's queue does not show the viewer's
// jobs, nor the viewer's job list the commander's, and neither hears of the
// other's job events.

/** Records the job ids whose events reach a page. */
const listen = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __heard: number[] }
    w.__heard = []
    window.panelyth!.onEvent("job.progress", (p) => w.__heard.push(p.jobId))
  })
const heard = (page: Page) =>
  page.evaluate(() => (window as unknown as { __heard: number[] }).__heard)

test("each app lists the jobs it started, and hears only of those", async () => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), "panelyth-jobs-app-"))
  const src = join(root, "src")
  const dst = join(root, "dst")
  mkdirSync(src)
  mkdirSync(dst)
  writeFileSync(join(src, "a.txt"), "a\n")
  writeFileSync(join(src, "p.jpg"), "not really a picture")
  writeFileSync(join(dst, "keep.txt"), "") // goTo waits for a row
  const { app, page: viewer } = await launch("commander")
  try {
    const c = await commanderOf(app)
    await listen(viewer)
    await listen(c)

    // The commander copies a file (F5).
    await goTo(c, "right", dst)
    await goTo(c, "left", src)
    await cursorTo(c, "left", "a")
    await c.keyboard.press("F5")
    await expect(c.getByTestId("copy-dialog")).toBeVisible()
    await c.keyboard.press("Enter")
    await expect.poll(() => existsSync(join(dst, "a.txt"))).toBe(true)
    const copy = await c.evaluate(async () => {
      const api = window.panelyth as unknown as {
        files: { list(): Promise<{ ok: boolean; r: { jobs: { jobId: number; kind: string }[] } }> }
      }
      const res = await api.files.list()
      return res.r.jobs.find((j) => j.kind === "copy")?.jobId ?? 0
    })
    expect(copy).toBeGreaterThan(0)
    await expect.poll(() => heard(c)).toContain(copy)
    await expect(c.getByTestId("queue").locator("li[data-state]")).toHaveCount(1)

    // The viewer neither lists it nor heard of it.
    const viewerJobs = () =>
      viewer.evaluate(async () => {
        const res = await window.panelyth!.jobs.list()
        if (!res.ok) throw new Error(res.e.message)
        return res.r.jobs.map((j) => j.jobId)
      })
    expect(await viewerJobs()).not.toContain(copy)
    expect(await heard(viewer)).not.toContain(copy)

    // The viewer marks a picture as a favorite: a job of its own.
    const favorite = await viewer.evaluate(async (path) => {
      const api = window.panelyth!
      for (let attempt = 0; attempt < 100; attempt++) {
        const dir = await api.dir.open({ path, recursive: false })
        if (!dir.ok) throw new Error(dir.e.message)
        const q = await api.query.open({
          dirId: dir.r.dirId,
          recursive: false,
          sort: [],
          kinds: [],
          search: "",
          exts: [],
          favorite: false,
          minRating: 0,
          tags: [],
        })
        if (!q.ok) throw new Error(q.e.message)
        if (q.r.total > 0) {
          const selection = {
            queryId: q.r.queryId,
            version: q.r.version,
            ranges: [[0, 1]] as [number, number][],
            include: [],
            exclude: [],
          }
          const job = await api.jobs.start({
            kind: "favorite",
            source: { selection },
            favorite: true,
          })
          if (!job.ok) throw new Error(job.e.message)
          return job.r.jobId
        }
        await api.query.close(q.r.queryId)
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error("the folder was not listed")
    }, src)
    await expect.poll(() => heard(viewer)).toContain(favorite)
    expect(await viewerJobs()).toContain(favorite)

    // The commander neither lists it nor heard of it.
    const commanderJobs = await c.evaluate(async () => {
      const api = window.panelyth as unknown as {
        files: { list(): Promise<{ ok: boolean; r: { jobs: { jobId: number }[] } }> }
      }
      return (await api.files.list()).r.jobs.map((j) => j.jobId)
    })
    expect(commanderJobs).toContain(copy)
    expect(commanderJobs).not.toContain(favorite)
    expect(await heard(c)).not.toContain(favorite)
    await expect(c.getByTestId("queue").locator("li[data-state]")).toHaveCount(1)
  } finally {
    await app.close().catch(() => undefined)
    removeTemp(root)
  }
})
