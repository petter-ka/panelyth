import type { ContentItem } from "@panelyth/contracts"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  fileArgument,
  LISTING_GRACE_MS,
  LISTING_RETRY_MS,
  OpenWithSession,
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
    }
    throw new Error(`unexpected ${method}`)
  })
  return { call, closed }
}

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
    const session = new OpenWithSession(call as never, "/pics/b.jpg", () => 0, sleep)
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

  it("finds a hidden file by listing hidden files too", async () => {
    const { call, closed } = sidecar(rows, [2])
    const session = new OpenWithSession(call as never, "/pics/b.jpg")
    expect(await session.step(0)).toEqual(rows[1])
    expect(closed).toEqual([1])
    expect(call).toHaveBeenLastCalledWith("query.page", expect.objectContaining({ queryId: 2 }))
  })

  it("passes on why a file can't be shown, and closes its session with the window", async () => {
    const refusing = vi.fn(async () => {
      throw new Error("not an image or a video")
    })
    await expect(new OpenWithSession(refusing as never, "/notes.txt").step(0)).rejects.toThrow(
      "not an image or a video",
    )

    const { call, closed } = sidecar(rows)
    const session = new OpenWithSession(call as never, "/pics/b.jpg")
    await session.step(0)
    session.close()
    await vi.waitFor(() => expect(closed).toEqual([1]))
    expect(await session.step(1)).toBeNull()
  })
})
