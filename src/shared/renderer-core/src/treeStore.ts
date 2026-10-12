import type { Crumb, ListDirsResult, Volume } from "@panelyth/contracts"
import { create, type StoreApi, type UseBoundStore } from "zustand"

/**
 * A lazy folder tree, shared by the viewer's sidebar and the commander's
 * tree pane (Stage C10.5). It reads the filesystem through `listDirs`, not
 * the index: a node's children are listed only when it is expanded, one
 * level at a time, never recursively. Nodes are kept in a map outside
 * React; components subscribe to `version` and flatten the visible rows.
 * `createTreeStore` makes an independent tree (the commander shows up to
 * two).
 */
export interface TreeNode {
  path: string
  name: string
  /** False only when the folder is known to have no subfolders. */
  hasChildren: boolean
  /** Child keys once listed; null = not listed yet. */
  children: string[] | null
  loading: boolean
  error: string | null
  truncated: boolean
}

export interface TreeRow {
  key: string
  node: TreeNode
  depth: number
  expanded: boolean
}

export interface TreeState {
  roots: string[]
  expanded: ReadonlySet<string>
  /** Key of the open folder's node, when it is in the tree. */
  activeKey: string | null
  /** Increments when the view should scroll the active node into view. */
  revealToken: number
  /** Increments on every node change (listing, loading, error). */
  version: number
}

export interface TreeStoreOptions {
  /** Lists a folder's immediate subfolders. */
  listDirs(path: string): Promise<ListDirsResult>
  /** An error as the tree shows it under the node that could not be listed. */
  describeError(error: unknown): string
}

export interface TreeStore {
  useStore: UseBoundStore<StoreApi<TreeState>>
  getNode(key: string): TreeNode | undefined
  reset(): void
  setRoots(volumes: readonly Volume[]): void
  /** Lists a node's immediate subfolders (again, when `force`). */
  loadChildren(key: string, force?: boolean): Promise<void>
  expand(key: string): Promise<void>
  collapse(key: string): void
  toggle(key: string): void
  /** Visible rows in display order. O(visible nodes). */
  flatten(roots: readonly string[], expanded: ReadonlySet<string>): TreeRow[]
  /**
   * Shows the open folder in the tree: expands each ancestor (listing it
   * lazily if needed), marks the folder active and asks the view to scroll
   * to it. A root missing from the volumes (a network share) is added.
   */
  reveal(crumbs: readonly Crumb[]): Promise<void>
  /** Re-lists an expanded node so new or removed subfolders show. */
  refreshNode(path: string): Promise<void>
  /** Re-lists every node that was listed (the hidden-files setting changed). */
  refreshAll(): Promise<void>
}

// Windows and macOS file systems are case-insensitive by default; keys fold
// case there so "C:\Photos" from a dialog and "C:\photos" from a listing meet.
const foldCase = typeof navigator !== "undefined" && /Windows|Mac/i.test(navigator.userAgent ?? "")

export function treeNodeKey(path: string): string {
  return foldCase ? path.toLowerCase() : path
}

function volumeName(v: Volume): string {
  return v.label ? `${v.label} (${v.path.replace(/[\\/]+$/, "") || v.path})` : v.path
}

const emptyState = (): TreeState => ({
  roots: [],
  expanded: new Set(),
  activeKey: null,
  revealToken: 0,
  version: 0,
})

export function createTreeStore(options: TreeStoreOptions): TreeStore {
  const nodes = new Map<string, TreeNode>()
  const useStore = create<TreeState>(emptyState)
  const set = useStore.setState
  const get = useStore.getState
  const bump = (): void => set((s) => ({ version: s.version + 1 }))

  function upsert(path: string, name: string, hasChildren: boolean): string {
    const key = treeNodeKey(path)
    const existing = nodes.get(key)
    if (existing) {
      existing.hasChildren = existing.children ? existing.children.length > 0 : hasChildren
    } else {
      nodes.set(key, {
        path,
        name,
        hasChildren,
        children: null,
        loading: false,
        error: null,
        truncated: false,
      })
    }
    return key
  }

  // One listing per node at a time; later callers await the same promise.
  const inflight = new Map<string, Promise<void>>()
  // A reset drops the answers of listings that were under way.
  let generation = 0

  function loadChildren(key: string, force = false): Promise<void> {
    const node = nodes.get(key)
    if (!node) return Promise.resolve()
    if (node.children && !force) return Promise.resolve()
    const running = inflight.get(key)
    if (running) return running
    const started = generation
    node.loading = true
    bump()
    const p = options
      .listDirs(node.path)
      .then((res) => {
        if (started !== generation) return
        node.children = res.dirs.map((d) => upsert(d.path, d.name, d.hasChildren))
        node.hasChildren = node.children.length > 0
        node.truncated = res.truncated
        node.error = null
      })
      .catch((error: unknown) => {
        if (started !== generation) return
        node.children = []
        node.error = options.describeError(error)
      })
      .finally(() => {
        if (started !== generation) return
        node.loading = false
        inflight.delete(key)
        bump()
      })
    inflight.set(key, p)
    return p
  }

  function expand(key: string): Promise<void> {
    if (!get().expanded.has(key)) set((s) => ({ expanded: new Set(s.expanded).add(key) }))
    return loadChildren(key)
  }

  function collapse(key: string): void {
    if (!get().expanded.has(key)) return
    set((s) => {
      const expanded = new Set(s.expanded)
      expanded.delete(key)
      return { expanded }
    })
  }

  let revealSeq = 0

  return {
    useStore,
    getNode: (key) => nodes.get(key),
    reset() {
      generation++
      revealSeq++
      nodes.clear()
      inflight.clear()
      set(emptyState())
    },
    setRoots(volumes) {
      const roots = volumes.map((v) => upsert(v.path, volumeName(v), true))
      set((s) => ({ roots: [...roots, ...s.roots.filter((r) => !roots.includes(r))] }))
      bump()
    },
    loadChildren,
    expand,
    collapse,
    toggle(key) {
      if (get().expanded.has(key)) collapse(key)
      else void expand(key)
    },
    flatten(roots, expanded) {
      const rows: TreeRow[] = []
      const walk = (key: string, depth: number): void => {
        const node = nodes.get(key)
        if (!node) return
        const isOpen = expanded.has(key)
        rows.push({ key, node, depth, expanded: isOpen })
        if (isOpen && node.children) for (const c of node.children) walk(c, depth + 1)
      }
      for (const r of roots) walk(r, 0)
      return rows
    },
    async reveal(crumbs) {
      const seq = ++revealSeq
      if (crumbs.length === 0) return
      const rootKey = treeNodeKey(crumbs[0]!.path)
      if (!nodes.has(rootKey) || !get().roots.includes(rootKey)) {
        upsert(crumbs[0]!.path, crumbs[0]!.name, true)
        set((s) => ({ roots: [...s.roots, rootKey] }))
      }
      for (let i = 0; i < crumbs.length - 1; i++) {
        const key = treeNodeKey(crumbs[i]!.path)
        await expand(key)
        if (seq !== revealSeq) return
        // Hidden or just created folders are not in the parent's listing yet.
        const child = treeNodeKey(crumbs[i + 1]!.path)
        const parent = nodes.get(key)
        if (parent && !nodes.has(child)) {
          upsert(crumbs[i + 1]!.path, crumbs[i + 1]!.name, true)
          parent.children = [...(parent.children ?? []), child]
          bump()
        }
      }
      set((s) => ({
        activeKey: treeNodeKey(crumbs.at(-1)!.path),
        revealToken: s.revealToken + 1,
      }))
    },
    refreshNode(path) {
      const key = treeNodeKey(path)
      return nodes.get(key)?.children ? loadChildren(key, true) : Promise.resolve()
    },
    async refreshAll() {
      const listed = [...nodes.entries()].filter(([, n]) => n.children !== null).map(([k]) => k)
      // One level at a time, a few listings in flight: never a burst per node.
      const queue = listed.slice()
      const worker = async (): Promise<void> => {
        for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
          await loadChildren(key, true)
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker))
    },
  }
}
