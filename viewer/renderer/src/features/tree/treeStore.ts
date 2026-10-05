import type { Crumb, Volume } from "@fastview/contracts"
import { create } from "zustand"
import { bridge } from "../../bridge"
import { describeError, useFolderStore } from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"

/**
 * The sidebar folder tree. It reads the filesystem (fs.listDirs), not the
 * index, and is lazy: a node's children are listed only when it is
 * expanded, one level at a time, never recursively. Nodes are kept in a map
 * outside React; components subscribe to `version` and flatten the visible
 * rows.
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

interface TreeState {
  roots: string[]
  expanded: ReadonlySet<string>
  /** Key of the open folder's node, when it is in the tree. */
  activeKey: string | null
  /** Increments when the sidebar should scroll the active node into view. */
  revealToken: number
  /** Increments on every node change (listing, loading, error). */
  version: number
}

// Windows and macOS file systems are case-insensitive by default; keys fold
// case there so "C:\Photos" from a dialog and "C:\photos" from a listing meet.
const foldCase = typeof navigator !== "undefined" && /Windows|Mac/i.test(navigator.userAgent ?? "")

export function nodeKey(path: string): string {
  return foldCase ? path.toLowerCase() : path
}

const nodes = new Map<string, TreeNode>()

export const useTreeStore = create<TreeState>(() => ({
  roots: [],
  expanded: new Set(),
  activeKey: null,
  revealToken: 0,
  version: 0,
}))

const set = useTreeStore.setState
const get = useTreeStore.getState
const bump = (): void => set((s) => ({ version: s.version + 1 }))

export function getNode(key: string): TreeNode | undefined {
  return nodes.get(key)
}

export function resetTree(): void {
  nodes.clear()
  set({ roots: [], expanded: new Set(), activeKey: null, revealToken: 0, version: 0 })
}

function upsert(path: string, name: string, hasChildren: boolean): string {
  const key = nodeKey(path)
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

function volumeName(v: Volume): string {
  return v.label ? `${v.label} (${v.path.replace(/[\\/]+$/, "") || v.path})` : v.path
}

export function setRoots(volumes: readonly Volume[]): void {
  const roots = volumes.map((v) => upsert(v.path, volumeName(v), true))
  set((s) => ({ roots: [...roots, ...s.roots.filter((r) => !roots.includes(r))] }))
  bump()
}

// One listing per node at a time; later callers await the same promise.
const inflight = new Map<string, Promise<void>>()

/** Lists a node's immediate subfolders (again, when `force`). */
export function loadChildren(key: string, force = false): Promise<void> {
  const node = nodes.get(key)
  if (!node) return Promise.resolve()
  if (node.children && !force) return Promise.resolve()
  const running = inflight.get(key)
  if (running) return running
  node.loading = true
  bump()
  const p = bridge
    .listDirs(node.path)
    .then((res) => {
      node.children = res.dirs.map((d) => upsert(d.path, d.name, d.hasChildren))
      node.hasChildren = node.children.length > 0
      node.truncated = res.truncated
      node.error = null
    })
    .catch((error: unknown) => {
      node.children = []
      node.error = describeError(error)
    })
    .finally(() => {
      node.loading = false
      inflight.delete(key)
      bump()
    })
  inflight.set(key, p)
  return p
}

export function expand(key: string): Promise<void> {
  if (!get().expanded.has(key)) set((s) => ({ expanded: new Set(s.expanded).add(key) }))
  return loadChildren(key)
}

export function collapse(key: string): void {
  if (!get().expanded.has(key)) return
  set((s) => {
    const expanded = new Set(s.expanded)
    expanded.delete(key)
    return { expanded }
  })
}

export function toggle(key: string): void {
  if (get().expanded.has(key)) collapse(key)
  else void expand(key)
}

/** Visible rows in display order. O(visible nodes). */
export function flatten(roots: readonly string[], expanded: ReadonlySet<string>): TreeRow[] {
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
}

let revealSeq = 0

/**
 * Shows the open folder in the tree: expands each ancestor (listing it
 * lazily if needed), marks the folder active and asks the sidebar to scroll
 * to it. A root missing from the volumes (a network share) is added.
 */
export async function reveal(crumbs: readonly Crumb[]): Promise<void> {
  const seq = ++revealSeq
  if (crumbs.length === 0) return
  const rootKey = nodeKey(crumbs[0]!.path)
  if (!nodes.has(rootKey) || !get().roots.includes(rootKey)) {
    upsert(crumbs[0]!.path, crumbs[0]!.name, true)
    set((s) => ({ roots: [...s.roots, rootKey] }))
  }
  for (let i = 0; i < crumbs.length - 1; i++) {
    const key = nodeKey(crumbs[i]!.path)
    await expand(key)
    if (seq !== revealSeq) return
    // Hidden or just created folders are not in the parent's listing yet.
    const child = nodeKey(crumbs[i + 1]!.path)
    const parent = nodes.get(key)
    if (parent && !nodes.has(child)) {
      upsert(crumbs[i + 1]!.path, crumbs[i + 1]!.name, true)
      parent.children = [...(parent.children ?? []), child]
      bump()
    }
  }
  set((s) => ({ activeKey: nodeKey(crumbs.at(-1)!.path), revealToken: s.revealToken + 1 }))
}

/** F5 / "Refresh": re-lists an expanded node so new or removed subfolders show. */
export function refreshNode(path: string): Promise<void> {
  const key = nodeKey(path)
  return nodes.get(key)?.children ? loadChildren(key, true) : Promise.resolve()
}

/** Volumes become roots; every opened folder is revealed. */
export function startTreeMonitoring(): () => void {
  if (useLibraryStore.getState().volumes.length > 0) setRoots(useLibraryStore.getState().volumes)
  const offVolumes = useLibraryStore.subscribe((s, prev) => {
    if (s.volumes !== prev.volumes) setRoots(s.volumes)
  })
  const offFolder = useFolderStore.subscribe((s, prev) => {
    const crumbs = s.folder?.crumbs
    if (crumbs && crumbs !== prev.folder?.crumbs) void reveal(crumbs)
  })
  return () => {
    offVolumes()
    offFolder()
  }
}
