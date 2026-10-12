import type { ListDirsResult } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { createTreeStore, treeNodeKey } from "./treeStore"

// The folder tree shared by the viewer's sidebar and the commander's tree
// pane (Stage C10.5).

const FS: Record<string, string[]> = {
  "/": ["home", "var"],
  "/home": ["me", "you"],
  "/home/me": ["docs"],
  "/home/me/docs": [],
  "/home/you": [],
  "/var": [],
}

const join = (parent: string, name: string): string =>
  parent === "/" ? `/${name}` : `${parent}/${name}`

function listing(path: string): ListDirsResult {
  const names = FS[path]
  if (!names) throw new Error(`no such folder: ${path}`)
  return {
    path,
    dirs: names.map((name) => ({
      name,
      path: join(path, name),
      hasChildren: (FS[join(path, name)] ?? []).length > 0,
    })),
    truncated: false,
  }
}

function tree() {
  const listDirs = vi.fn(async (path: string) => listing(path))
  const store = createTreeStore({ listDirs, describeError: (e) => `failed: ${String(e)}` })
  store.setRoots([{ path: "/", label: "", kind: "fixed" }])
  return { store, listDirs }
}

const names = (store: ReturnType<typeof createTreeStore>): string[] => {
  const s = store.useStore.getState()
  return store.flatten(s.roots, s.expanded).map((r) => `${"  ".repeat(r.depth)}${r.node.name}`)
}

describe("the shared folder tree", () => {
  it("lists a node's subfolders only when it is expanded, one level at a time", async () => {
    const { store, listDirs } = tree()
    expect(names(store)).toEqual(["/"])
    expect(listDirs).not.toHaveBeenCalled()

    await store.expand(treeNodeKey("/"))
    expect(listDirs).toHaveBeenCalledTimes(1)
    expect(names(store)).toEqual(["/", "  home", "  var"])
    // "var" is known to have no subfolders; "home" may have some.
    expect(store.getNode(treeNodeKey("/var"))?.hasChildren).toBe(false)
    expect(store.getNode(treeNodeKey("/home"))?.children).toBeNull()

    await store.expand(treeNodeKey("/home"))
    expect(listDirs).toHaveBeenCalledTimes(2)
    expect(names(store)).toEqual(["/", "  home", "    me", "    you", "  var"])

    // Collapsing keeps what was listed; expanding again asks nothing.
    store.collapse(treeNodeKey("/home"))
    expect(names(store)).toEqual(["/", "  home", "  var"])
    await store.expand(treeNodeKey("/home"))
    expect(listDirs).toHaveBeenCalledTimes(2)
  })

  it("lists a node once however often it is asked while the listing runs", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const listDirs = vi.fn(async (path: string) => {
      await gate
      return listing(path)
    })
    const store = createTreeStore({ listDirs, describeError: String })
    store.setRoots([{ path: "/", label: "", kind: "fixed" }])
    const key = treeNodeKey("/")
    const a = store.expand(key)
    const b = store.expand(key)
    store.toggle(key) // collapses; the listing still finishes
    expect(store.getNode(key)?.loading).toBe(true)
    release()
    await Promise.all([a, b])
    expect(listDirs).toHaveBeenCalledTimes(1)
    expect(store.getNode(key)?.loading).toBe(false)
  })

  it("reveals a folder: every ancestor expands and the folder becomes the active node", async () => {
    const { store, listDirs } = tree()
    const before = store.useStore.getState().revealToken
    await store.reveal([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
      { name: "docs", path: "/home/me/docs" },
    ])
    expect(names(store)).toEqual(["/", "  home", "    me", "      docs", "    you", "  var"])
    // The folder itself is not listed: only what leads to it.
    expect(listDirs.mock.calls.map((c) => c[0])).toEqual(["/", "/home", "/home/me"])
    const s = store.useStore.getState()
    expect(s.activeKey).toBe(treeNodeKey("/home/me/docs"))
    expect(s.revealToken).toBe(before + 1)
  })

  it("adds a folder its parent's listing does not have, and a root that is not a volume", async () => {
    const { store } = tree()
    await store.reveal([
      { name: "/", path: "/" },
      { name: ".hidden", path: "/.hidden" },
    ])
    expect(names(store)).toContain("  .hidden")
    FS["//server/share"] = []
    await store.reveal([{ name: "share", path: "//server/share" }])
    expect(store.useStore.getState().roots).toContain(treeNodeKey("//server/share"))
    delete FS["//server/share"]
  })

  it("keeps the error of a folder that could not be listed, as an empty node", async () => {
    const listDirs = vi.fn(async () => {
      throw new Error("denied")
    })
    const store = createTreeStore({ listDirs, describeError: (e) => `failed: ${String(e)}` })
    store.setRoots([{ path: "/", label: "Disk", kind: "fixed" }])
    await store.expand(treeNodeKey("/"))
    const node = store.getNode(treeNodeKey("/"))!
    expect(node.name).toBe("Disk (/)")
    expect(node.children).toEqual([])
    expect(node.error).toBe("failed: Error: denied")
    expect(node.loading).toBe(false)
  })

  it("re-lists what was listed, at most four folders at a time", async () => {
    const { store } = tree()
    await store.reveal([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
      { name: "docs", path: "/home/me/docs" },
    ])
    let running = 0
    let most = 0
    const slow = createTreeStore({
      listDirs: async (path) => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, 1))
        running--
        return listing(path)
      },
      describeError: String,
    })
    slow.setRoots([{ path: "/", label: "", kind: "fixed" }])
    for (const path of ["/", "/home", "/home/me", "/home/me/docs", "/home/you", "/var"]) {
      await slow.expand(treeNodeKey(path))
    }
    most = 0
    FS["/var"] = ["log"]
    await slow.refreshAll()
    expect(most).toBeLessThanOrEqual(4)
    expect(names(slow)).toContain("    log")
    FS["/var"] = []
    // One node alone: only when it was listed before.
    const { store: fresh, listDirs } = tree()
    await fresh.refreshNode("/")
    expect(listDirs).not.toHaveBeenCalled()
  })

  it("keeps two trees apart, and a reset forgets a tree's nodes and late answers", async () => {
    const a = tree()
    const b = tree()
    await a.store.expand(treeNodeKey("/"))
    expect(names(a.store)).toHaveLength(3)
    expect(names(b.store)).toEqual(["/"])

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const late = createTreeStore({
      listDirs: async (path) => {
        await gate
        return listing(path)
      },
      describeError: String,
    })
    late.setRoots([{ path: "/", label: "", kind: "fixed" }])
    const pending = late.expand(treeNodeKey("/"))
    late.reset()
    release()
    await pending
    expect(late.useStore.getState()).toMatchObject({ roots: [], version: 0 })
    expect(late.getNode(treeNodeKey("/home"))).toBeUndefined()
  })
})
