import type { EntryKind, StoredPrograms } from "@panelyth/contracts"
import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  programInvocation,
  programName,
  programProblem,
  programsHandlers,
  type ProgramStat,
  type ProgramsDeps,
} from "../src/main/programs"

vi.mock("electron", () => ({}))

const ev = {} as IpcMainInvokeEvent
const exe: ProgramStat = { kind: "file", executable: true }

interface Setup {
  platform?: NodeJS.Platform
  stored?: unknown
  entry?: { path: string; kind: EntryKind; program: boolean }
  picked?: string | null
  stats?: Record<string, ProgramStat>
  canOpen?: boolean
  canEdit?: boolean
}

function setup(o: Setup = {}) {
  const settings: Record<string, unknown> = { "shared.programs": o.stored }
  const entry = o.entry ?? { path: "/photos/a.jpg", kind: "image", program: false }
  const stats = o.stats ?? { "/usr/bin/gimp": exe }
  const deps: ProgramsDeps = {
    call: vi.fn(async (method: string, params: { key?: string; value?: unknown }) => {
      if (method === "library.get") return { settings: { ...settings } }
      if (method === "library.setSetting") {
        settings[params.key!] = params.value
        return { ok: true }
      }
      return entry
    }) as unknown as ProgramsDeps["call"],
    pick: vi.fn(async () => (o.picked === undefined ? "/usr/bin/gimp" : o.picked)),
    launch: vi.fn(async () => undefined),
    statOf: vi.fn(async (path: string) => stats[path] ?? null),
    canOpen: vi.fn(() => o.canOpen ?? true),
    canEdit: vi.fn(() => o.canEdit ?? true),
    changed: vi.fn(),
    log: vi.fn(),
    platform: o.platform ?? "linux",
  }
  return { deps, settings, h: programsHandlers(deps) }
}

const gimp = (target = "both"): StoredPrograms =>
  ({
    v: 1,
    programs: [{ id: "gimp1", name: "GIMP", path: "/usr/bin/gimp", target }],
  }) as StoredPrograms

describe("programs.add", () => {
  it("adds the program picked in main's dialog, named after its file", async () => {
    const { h, deps, settings } = setup()
    const r = await h["programs.add"](ev, {}, "viewer")
    expect(r.programs).toEqual([
      { id: r.added, name: "gimp", path: "/usr/bin/gimp", target: "both" },
    ])
    expect(settings["shared.programs"]).toEqual({ v: 1, programs: r.programs })
    expect(deps.changed).toHaveBeenCalledWith({ v: 1, programs: r.programs })
  })

  it("adds nothing when the dialog is cancelled, and a program once", async () => {
    const cancelled = setup({ picked: null })
    expect(await cancelled.h["programs.add"](ev, {}, "viewer")).toEqual({
      programs: [],
      added: null,
    })
    expect(cancelled.deps.call).not.toHaveBeenCalledWith("library.setSetting", expect.anything())

    const again = setup({ stored: gimp() })
    expect(await again.h["programs.add"](ev, {}, "commander")).toMatchObject({ added: "gimp1" })
    expect(again.deps.changed).not.toHaveBeenCalled()
  })

  it("refuses what cannot be started without a shell", async () => {
    const folder = setup({ stats: { "/usr/bin/gimp": { kind: "dir", executable: true } } })
    await expect(folder.h["programs.add"](ev, {}, "viewer")).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { reason: "program" },
    })
    const script = setup({
      platform: "win32",
      picked: "C:\\tools\\run.cmd",
      stats: { "C:\\tools\\run.cmd": exe },
    })
    await expect(script.h["programs.add"](ev, {}, "viewer")).rejects.toThrow(/\.exe/)
    expect(script.deps.changed).not.toHaveBeenCalled()
  })

  it("takes at most 20 programs", async () => {
    const programs = Array.from({ length: 20 }, (_, i) => ({
      id: `p${i}`,
      name: `P${i}`,
      path: `/usr/bin/p${i}`,
      target: "both",
    }))
    const { h, deps } = setup({ stored: { v: 1, programs } })
    await expect(h["programs.add"](ev, {}, "viewer")).rejects.toMatchObject({
      details: { reason: "full" },
    })
    expect(deps.pick).not.toHaveBeenCalled()
  })

  it("comes from the app's own view or its settings window only", async () => {
    const { h, deps } = setup({ canEdit: false })
    await expect(h["programs.add"](ev, {}, "viewer")).rejects.toMatchObject({
      details: { reason: "hidden" },
    })
    expect(deps.pick).not.toHaveBeenCalled()
  })
})

describe("programs.update", () => {
  it("renames, retargets, reorders and removes, keeping the stored paths", async () => {
    const stored = {
      v: 1,
      programs: [
        { id: "a", name: "A", path: "/usr/bin/a", target: "both" },
        { id: "b", name: "B", path: "/usr/bin/b", target: "both" },
        { id: "c", name: "C", path: "/usr/bin/c", target: "both" },
      ],
    }
    const { h, settings } = setup({ stored })
    const r = await h["programs.update"](
      ev,
      {
        programs: [
          { id: "c", name: " Viewer C ", target: "folders" },
          { id: "a", name: "A", target: "files" },
          { id: "zz", name: "Unknown", target: "both" },
        ],
      },
      "commander",
    )
    expect(r.programs).toEqual([
      { id: "c", name: "Viewer C", path: "/usr/bin/c", target: "folders" },
      { id: "a", name: "A", path: "/usr/bin/a", target: "files" },
    ])
    expect(settings["shared.programs"]).toEqual({ v: 1, programs: r.programs })
  })

  it("applies two quick edits one after the other", async () => {
    const { h, settings } = setup({ stored: gimp() })
    await Promise.all([
      h["programs.update"](
        ev,
        { programs: [{ id: "gimp1", name: "One", target: "files" }] },
        "viewer",
      ),
      h["programs.update"](
        ev,
        { programs: [{ id: "gimp1", name: "Two", target: "folders" }] },
        "viewer",
      ),
    ])
    expect(settings["shared.programs"]).toMatchObject({
      programs: [{ name: "Two", target: "folders" }],
    })
  })
})

describe("programs.open", () => {
  it("starts the program with the entry's path as its only argument", async () => {
    const { h, deps } = setup({ stored: gimp() })
    await expect(
      h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer"),
    ).resolves.toEqual({ ok: true })
    expect(deps.call).toHaveBeenCalledWith("entry.path", { entryId: 3 })
    expect(deps.launch).toHaveBeenCalledWith("/usr/bin/gimp", ["/photos/a.jpg"])
  })

  it("offers a program for files, folders or both", async () => {
    const folder = { path: "/photos", kind: "dir" as const, program: false }
    const files = setup({ stored: gimp("files"), entry: folder })
    await expect(
      files.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "target" } })
    const folders = setup({ stored: gimp("folders") })
    await expect(
      folders.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "target" } })
    const both = setup({ stored: gimp("folders"), entry: folder })
    await both.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer")
    expect(both.deps.launch).toHaveBeenCalledWith("/usr/bin/gimp", ["/photos"])
  })

  it("hands the viewer's folders and media only, never a program; the commander any entry", async () => {
    for (const entry of [
      { path: "/x/notes.txt", kind: "file" as const, program: false },
      { path: "/x/run.sh", kind: "file" as const, program: true },
      { path: "/Applications/X.app", kind: "dir" as const, program: true },
    ]) {
      const viewer = setup({ stored: gimp(), entry })
      await expect(
        viewer.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer"),
      ).rejects.toMatchObject({ details: { reason: "kind" } })
      expect(viewer.deps.launch).not.toHaveBeenCalled()
      const commander = setup({ stored: gimp(), entry })
      await commander.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "commander")
      expect(commander.deps.launch).toHaveBeenCalledWith("/usr/bin/gimp", [entry.path])
    }
  })

  it("refuses a hidden app, an unknown program and one that is gone", async () => {
    const hidden = setup({ stored: gimp(), canOpen: false })
    await expect(
      hidden.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "commander"),
    ).rejects.toMatchObject({ details: { reason: "hidden" } })
    expect(hidden.deps.call).not.toHaveBeenCalled()

    const unknown = setup({ stored: gimp() })
    await expect(
      unknown.h["programs.open"](ev, { programId: "other", entryId: 3 }, "viewer"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })

    const gone = setup({ stored: gimp(), stats: {} })
    await expect(
      gone.h["programs.open"](ev, { programId: "gimp1", entryId: 3 }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "missing" } })
    expect(gone.deps.launch).not.toHaveBeenCalled()
  })

  it("opens through a macOS app bundle with open -a", async () => {
    const { h, deps } = setup({
      platform: "darwin",
      stored: {
        v: 1,
        programs: [
          { id: "px", name: "Pixelmator", path: "/Applications/Pixelmator.app", target: "both" },
        ],
      },
      stats: { "/Applications/Pixelmator.app": { kind: "dir", executable: true } },
    })
    await h["programs.open"](ev, { programId: "px", entryId: 3 }, "viewer")
    expect(deps.launch).toHaveBeenCalledWith("/usr/bin/open", [
      "-a",
      "/Applications/Pixelmator.app",
      "/photos/a.jpg",
    ])
  })
})

describe("programs.openFolder (the viewer's folder tree)", () => {
  const dir: ProgramStat = { kind: "dir", executable: true }

  it("starts a folder program with the folder's path", async () => {
    const { h, deps } = setup({
      stored: gimp("folders"),
      stats: { "/usr/bin/gimp": exe, "/photos/2026": dir },
    })
    await expect(
      h["programs.openFolder"](ev, { programId: "gimp1", path: "/photos/2026" }, "viewer"),
    ).resolves.toEqual({ ok: true })
    expect(deps.launch).toHaveBeenCalledWith("/usr/bin/gimp", ["/photos/2026"])
    // No entry is resolved: the path is the tree's.
    expect(deps.call).not.toHaveBeenCalledWith("entry.path", expect.anything())
  })

  it("refuses what is not a folder, a files-only program and a hidden app", async () => {
    const file = setup({ stored: gimp(), stats: { "/usr/bin/gimp": exe, "/photos/a.jpg": exe } })
    await expect(
      file.h["programs.openFolder"](ev, { programId: "gimp1", path: "/photos/a.jpg" }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "kind" } })
    const missing = setup({ stored: gimp() })
    await expect(
      missing.h["programs.openFolder"](ev, { programId: "gimp1", path: "/gone" }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "kind" } })
    const files = setup({ stored: gimp("files"), stats: { "/usr/bin/gimp": exe, "/photos": dir } })
    await expect(
      files.h["programs.openFolder"](ev, { programId: "gimp1", path: "/photos" }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "target" } })
    const hidden = setup({ stored: gimp(), canOpen: false })
    await expect(
      hidden.h["programs.openFolder"](ev, { programId: "gimp1", path: "/photos" }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "hidden" } })
    for (const s of [file, missing, files, hidden]) expect(s.deps.launch).not.toHaveBeenCalled()
  })

  it("never hands over a macOS app bundle", async () => {
    const { h, deps } = setup({
      platform: "darwin",
      stored: gimp(),
      stats: { "/usr/bin/gimp": exe, "/Applications/X.app": dir },
    })
    await expect(
      h["programs.openFolder"](ev, { programId: "gimp1", path: "/Applications/X.app" }, "viewer"),
    ).rejects.toMatchObject({ details: { reason: "kind" } })
    expect(deps.launch).not.toHaveBeenCalled()
  })
})

describe("program helpers", () => {
  it("names a program after its file", () => {
    expect(programName("win32", "C:\\Program Files\\GIMP 3\\bin\\gimp-3.exe")).toBe("gimp-3")
    expect(programName("darwin", "/Applications/Visual Studio Code.app")).toBe("Visual Studio Code")
    expect(programName("linux", "/usr/bin/darktable")).toBe("darktable")
  })

  it("accepts what starts without a shell on each OS", () => {
    expect(programProblem("win32", "C:\\a\\x.EXE", exe)).toBeNull()
    expect(programProblem("win32", "C:\\a\\x.bat", exe)).toMatch(/\.exe/)
    expect(programProblem("linux", "/usr/bin/x", { kind: "file", executable: false })).toMatch(
      /cannot be executed/,
    )
    expect(programProblem("darwin", "/Applications/X.app", { kind: "dir", executable: true })).toBe(
      null,
    )
    expect(programProblem("linux", "/usr/bin/x", null)).toMatch(/not found/)
  })

  it("passes a hostile name as one argument, never through a shell", () => {
    const name = '/photos/a"; rm -rf ~ & echo %PATH%.jpg'
    expect(programInvocation("linux", "/usr/bin/gimp", name)).toEqual({
      file: "/usr/bin/gimp",
      args: [name],
    })
  })
})
