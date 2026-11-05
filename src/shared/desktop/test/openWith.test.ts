import type { ContentItem, JobSnapshot } from "@panelyth/contracts"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  DELETE_WAIT_MS,
  fileArgument,
  JOB_POLL_MS,
  LISTING_GRACE_MS,
  LISTING_RETRY_MS,
  OpenWithSession,
  PASTE_WAIT_MS,
} from "../src/main/openWith"

// "Open with" (ADR-0033 amended): which argument is the file, and how a
// media window without an app behind it finds its items.

describe("fileArgument", () => {
  const files = new Set([resolve("/pics/a.jpg"), resolve("/work/b.png"), resolve("/app/main.cjs")])
  const isFile = (path: string): boolean => files.has(path)

  it("is the first argument that is an existing file", () => {
    // Packaged: the program, then the file.
    expect(fileArgument(["Panelyth.exe", resolve("/pics/a.jpg")], "/", isFile)).toBe(
      resolve("/pics/a.jpg"),
    )
    // Unpackaged: the app's folder comes first and is no file.
    expect(fileArgument(["electron", resolve("/app"), resolve("/pics/a.jpg")], "/", isFile)).toBe(
      resolve("/pics/a.jpg"),
    )
  })

  it("skips switches, the app's own script and what is not there", () => {
    expect(
      fileArgument(
        ["electron", "--inspect=9229", "--original-process-start-time=1", resolve("/pics/a.jpg")],
        "/",
        isFile,
      ),
    ).toBe(resolve("/pics/a.jpg"))
    expect(
      fileArgument(["electron", resolve("/app/main.cjs"), resolve("/pics/a.jpg")], "/", isFile, [
        resolve("/app/main.cjs"),
      ]),
    ).toBe(resolve("/pics/a.jpg"))
    expect(fileArgument(["Panelyth.exe", resolve("/pics/gone.jpg")], "/", isFile)).toBeNull()
    expect(fileArgument(["Panelyth.exe"], "/", isFile)).toBeNull()
    expect(fileArgument(["Panelyth.exe", ""], "/", isFile)).toBeNull()
  })

  it("resolves a relative name against the folder the launch came from", () => {
    expect(fileArgument(["Panelyth.exe", "b.png"], resolve("/work"), isFile)).toBe(
      resolve("/work/b.png"),
    )
    expect(fileArgument(["Panelyth.exe", "b.png"], resolve("/elsewhere"), isFile)).toBeNull()
  })
})

const item = (id: number, name: string) => ({ id, kind: "image", name }) as ContentItem

/**
 * A sidecar with one folder: the session's rows in order, some of them
 * hidden. `live`: a session follows `rows` as they grow (a listing under way).
 */
function sidecar(rows: ContentItem[], hidden: number[] = [], live = false) {
  // A session that still grows stands for a folder whose listing is not complete.
  const closed: number[] = []
  let nextQuery = 0
  const sessions = new Map<number, ContentItem[]>()
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "entry.fromPath":
        return { dirId: 5, entryId: 2, kind: "image", listed: !live }
      case "query.open": {
        const shown = live
          ? rows
          : rows.filter((r) => params.showHidden === true || !hidden.includes(r.id))
        sessions.set(++nextQuery, shown)
        return { queryId: nextQuery, version: 1, total: shown.length }
      }
      case "query.indexOf":
        return {
          index: sessions.get(params.queryId as number)!.findIndex((r) => r.id === params.entryId),
          version: 1,
        }
      case "query.page": {
        const all = sessions.get(params.queryId as number)!
        const offset = params.offset as number
        return {
          queryId: params.queryId,
          version: 1,
          total: all.length,
          offset,
          items: all.slice(offset, offset + 1),
        }
      }
      case "query.close":
        closed.push(params.queryId as number)
        return { closed: true }
      case "clip.set":
        return { mode: params.mode, count: 1 }
      case "clip.paste":
      case "jobs.start":
        return job(1, "running")
      case "jobs.list":
        return { jobs: [job(1, "completed")] }
      case "fs.canTrash":
        return { trash: true }
    }
    throw new Error(`unexpected ${method}`)
  })
  return { call, closed }
}

const job = (jobId: number, state: JobSnapshot["state"], failed = 0) =>
  ({ jobId, state, failed }) as JobSnapshot

describe("OpenWithSession", () => {
  const rows = [item(1, "a.jpg"), item(2, "b.jpg"), item(3, "c.mp4")]

  it("asks once more when a neighbour is missing just after opening (the folder is still being listed)", async () => {
    // The session has only the opened file at first; the listing brings the rest.
    const listed = [item(2, "b.jpg")]
    const { call } = sidecar(listed, [], true)
    let clock = 0
    const sleeps: number[] = []
    const session = new OpenWithSession(
      call as never,
      "/pics/b.jpg",
      vi.fn(),
      () => clock,
      async (ms) => {
        sleeps.push(ms)
        clock += ms
        listed.push(item(3, "c.mp4"))
      },
    )
    expect(await session.step(0)).toEqual(listed[0])
    expect(await session.step(1)).toEqual(item(3, "c.mp4"))
    expect(sleeps).toEqual([LISTING_RETRY_MS])

    // Later, the end of the folder is the end: no waiting.
    clock += LISTING_GRACE_MS
    expect(await session.step(1)).toBeNull()
    expect(sleeps).toEqual([LISTING_RETRY_MS])
  })

  it("shows the file itself first, then its neighbours in the folder by name", async () => {
    const { call } = sidecar(rows)
    // The folder is listed: the ends of it answer at once, also right after opening.
    const sleep = vi.fn(async () => undefined)
    const session = new OpenWithSession(call as never, "/pics/b.jpg", vi.fn(), () => 0, sleep)
    expect(session.current()).toBeNull()
    expect(await session.step(0)).toEqual(rows[1])
    // The path went to the sidecar once; the session asks for pictures and videos only.
    expect(call).toHaveBeenCalledWith("entry.fromPath", { path: "/pics/b.jpg" })
    expect(call).toHaveBeenCalledWith(
      "query.open",
      expect.objectContaining({
        dirId: 5,
        scope: "media",
        kinds: ["image", "video"],
        sort: [{ field: "name", direction: "asc" }],
        recursive: false,
      }),
    )
    expect(session.current()).toEqual({ dirId: 5, entryId: 2 })

    expect(await session.step(1)).toEqual(rows[2])
    expect(session.current()).toEqual({ dirId: 5, entryId: 3 })
    // The end of the folder: nothing, and the current item stays.
    expect(await session.step(1)).toBeNull()
    expect(session.current()).toEqual({ dirId: 5, entryId: 3 })
    expect(await session.step(-1)).toEqual(rows[1])
    expect(await session.step(-1)).toEqual(rows[0])
    expect(await session.step(-1)).toBeNull()
    expect(call.mock.calls.filter((c) => c[0] === "entry.fromPath")).toHaveLength(1)
    expect(call.mock.calls.filter((c) => c[0] === "query.open")).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("jumps to the folder's first and last file, and steps on from there", async () => {
    const { call } = sidecar(rows)
    const session = new OpenWithSession(call as never, "/pics/b.jpg", vi.fn(), () => 0, vi.fn())
    expect(await session.step(0)).toEqual(rows[1])
    expect(await session.step("last")).toEqual(rows[2])
    expect(session.current()).toEqual({ dirId: 5, entryId: 3 })
    expect(await session.step("first")).toEqual(rows[0])
    expect(await session.step(1)).toEqual(rows[1])
  })

  it("finds a hidden file by listing hidden files too", async () => {
    const { call, closed } = sidecar(rows, [2])
    const session = new OpenWithSession(call as never, "/pics/b.jpg", vi.fn())
    expect(await session.step(0)).toEqual(rows[1])
    expect(closed).toEqual([1])
    expect(call).toHaveBeenLastCalledWith("query.page", expect.objectContaining({ queryId: 2 }))
  })

  it("passes on why a file can't be shown, and closes its session with the window", async () => {
    const refusing = vi.fn(async () => {
      throw new Error("not an image or a video")
    })
    await expect(
      new OpenWithSession(refusing as never, "/notes.txt", vi.fn()).step(0),
    ).rejects.toThrow("not an image or a video")

    const { call, closed } = sidecar(rows)
    const session = new OpenWithSession(call as never, "/pics/b.jpg", vi.fn())
    await session.step(0)
    session.close()
    await vi.waitFor(() => expect(closed).toEqual([1]))
    expect(await session.step(1)).toBeNull()
  })
})

describe("OpenWithSession: the window's file keys (no opener carries them out)", () => {
  const video = { id: 3, kind: "video", name: "c.mp4" } as ContentItem
  const rows = [item(1, "a.jpg"), item(2, "b.jpg"), video]
  const only = (id: number) => ({ queryId: 1, version: 1, ranges: [], include: [id], exclude: [] })

  type Calls = ReturnType<typeof sidecar>["call"]

  /** A session on b.jpg; `sleep` moves its clock. */
  function open(calls: Calls) {
    let clock = 0
    const copyImage = vi.fn(async () => undefined)
    const session = new OpenWithSession(
      calls as never,
      "/pics/b.jpg",
      copyImage,
      () => clock,
      async (ms) => {
        clock += ms
      },
    )
    return { session, copyImage }
  }

  /** The sidecar with one method answering differently. */
  const override = (base: Calls, method: string, answer: () => unknown): Calls =>
    vi.fn(async (m: string, p: Record<string, unknown>) =>
      m === method ? answer() : base(m, p),
    ) as unknown as Calls

  it("Ctrl+C on a picture: the file clipboard and the OS clipboard", async () => {
    const { call } = sidecar(rows)
    const { session, copyImage } = open(call)
    await session.step(0)
    expect(await session.command("copy")).toEqual({ item: rows[1], done: true })
    expect(call).toHaveBeenCalledWith("clip.set", { selection: only(2), mode: "copy" })
    expect(copyImage).toHaveBeenCalledWith(2)
  })

  it("Ctrl+C on a video and Ctrl+X: the file clipboard only", async () => {
    const { call } = sidecar(rows)
    const { session, copyImage } = open(call)
    await session.step(0)
    await session.step(1)
    expect(await session.command("copy")).toEqual({ item: rows[2], done: true })
    expect(call).toHaveBeenCalledWith("clip.set", { selection: only(3), mode: "copy" })
    expect(await session.command("cut")).toEqual({ item: rows[2], done: true })
    expect(call).toHaveBeenCalledWith("clip.set", { selection: only(3), mode: "cut" })
    expect(copyImage).not.toHaveBeenCalled()
  })

  it("selects from the session as it is now: the listing moves its version on", async () => {
    const { call } = sidecar(rows)
    const moved = vi.fn(async (m: string, p: Record<string, unknown>) => {
      const answer = await call(m, p)
      return m === "query.page" ? { ...(answer as object), version: 7 } : answer
    })
    const { session } = open(moved as unknown as Calls)
    await session.step(0)
    await session.command("cut")
    expect(moved).toHaveBeenCalledWith("clip.set", {
      selection: { ...only(2), version: 7 },
      mode: "cut",
    })
  })

  it("a picture that can't go on the OS clipboard is an error the window can say", async () => {
    const { call } = sidecar(rows)
    const { session, copyImage } = open(call)
    copyImage.mockRejectedValueOnce(new Error("cannot decode"))
    await session.step(0)
    await expect(session.command("copy")).rejects.toThrow("cannot decode")
  })

  it("Ctrl+V pastes into the file's folder and, with nobody to ask, keeps both files", async () => {
    const { call } = sidecar(rows)
    const { session } = open(call)
    await session.step(0)
    expect(await session.command("paste")).toEqual({ item: rows[1], done: true })
    expect(call).toHaveBeenCalledWith("clip.paste", { destinationDirId: 5, conflict: "keepBoth" })
  })

  it("a paste that fails is reported; a long one goes on behind the window", async () => {
    const { call } = sidecar(rows)
    const failing = override(call, "jobs.list", () => ({ jobs: [job(1, "failed")] }))
    const a = open(failing)
    await a.session.step(0)
    expect((await a.session.command("paste")).done).toBe(false)

    const long = override(call, "jobs.list", () => ({ jobs: [job(1, "running")] }))
    const b = open(long)
    await b.session.step(0)
    expect(await b.session.command("paste")).toEqual({ item: rows[1], done: true })
    // Bounded by the wait, at the poll's pace.
    const polls = long.mock.calls.filter((c) => c[0] === "jobs.list")
    expect(polls.length).toBe(PASTE_WAIT_MS / JOB_POLL_MS)
  })

  it("Delete: the job ends first, then the next file, the previous at the end", async () => {
    const { call } = sidecar(rows)
    const { session } = open(call)
    await session.step(0)
    expect(await session.command("trash")).toEqual({ item: rows[2], done: true })
    expect(call).toHaveBeenCalledWith("jobs.start", {
      kind: "trash",
      source: { selection: only(2) },
    })
    expect(call).toHaveBeenCalledWith("jobs.list", {})
    // Now on the next file, at the folder's end; the mocked listing still has the first.
    expect(session.current()).toEqual({ dirId: 5, entryId: 3 })
    expect(await session.command("delete")).toEqual({ item: rows[1], done: true })
    expect(call).toHaveBeenCalledWith("jobs.start", {
      kind: "delete",
      source: { selection: only(3) },
    })
  })

  it("the last file: nothing to show, once its job has ended", async () => {
    const { call } = sidecar([rows[1]!])
    const { session } = open(call)
    await session.step(0)
    expect(await session.command("delete")).toEqual({ item: null, done: true })
    // The app ends with this window, which would cancel a job still running.
    const order = call.mock.calls.map((c) => c[0])
    expect(order.indexOf("jobs.list")).toBeGreaterThan(order.indexOf("jobs.start"))
  })

  it("keeps the file on screen when the delete failed", async () => {
    const { call } = sidecar(rows)
    const partly = override(call, "jobs.list", () => ({ jobs: [job(1, "completed", 1)] }))
    const { session } = open(partly)
    await session.step(0)
    expect(await session.command("delete")).toEqual({ item: rows[1], done: false })
    expect(session.current()).toEqual({ dirId: 5, entryId: 2 })
  })

  it("a delete still queued after the wait: the window goes on", async () => {
    const { call } = sidecar(rows)
    const queued = override(call, "jobs.list", () => ({ jobs: [job(1, "queued")] }))
    const { session } = open(queued)
    await session.step(0)
    expect(await session.command("delete")).toEqual({ item: rows[2], done: true })
    const polls = queued.mock.calls.filter((c) => c[0] === "jobs.list")
    expect(polls.length).toBe(DELETE_WAIT_MS / JOB_POLL_MS)
  })

  it("a drive without a trash refuses, before any job starts", async () => {
    const { call } = sidecar(rows)
    const noTrash = override(call, "fs.canTrash", () => ({ trash: false }))
    const { session } = open(noTrash)
    await session.step(0)
    expect(await session.command("trash")).toEqual({ item: rows[1], done: false })
    expect(noTrash).not.toHaveBeenCalledWith("jobs.start", expect.anything())
  })

  it("does nothing once the window closed", async () => {
    const { call } = sidecar(rows)
    const { session } = open(call)
    await session.step(0)
    session.close()
    expect(await session.command("delete")).toEqual({ item: null, done: false })
    expect(call).not.toHaveBeenCalledWith("jobs.start", expect.anything())
  })
})
