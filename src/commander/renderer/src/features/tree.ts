import { createTreeStore, treeNodeKey, type TreeRow, type TreeStore } from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { useDrivesStore } from "./drives"
import { notice } from "./files"
import { openPath, toPanelError, useListingStore } from "./listing"
import { setActivePanel, usePanelsStore, type Side, type TreeMode } from "./panels"
import { useSettingsStore } from "./settings"
import { newTab } from "./tabs"
import { t } from "@panelyth/i18n"

// The folder tree beside the panels (Stage C10.5, CFR-30): the tree shared
// with the viewer's sidebar (createTreeStore), in up to two instances. It
// lists drives and, under a node that is expanded, that folder's subfolders
// (fs.listDirs, one level at a time). It follows its panel's folder after
// the panel has painted, and never the other way round: nothing in a panel
// waits for the tree.

/** The single tree that follows the active panel, or the tree beside a panel. */
export type TreeId = "one" | Side

export const visibleTrees = (mode: TreeMode): readonly TreeId[] =>
  mode === "one" ? ["one"] : mode === "two" ? ["left", "right"] : []

/** The panel a tree works for. */
export const treeSide = (id: TreeId): Side => (id === "one" ? usePanelsStore.getState().active : id)

const panel = (id: TreeId) => useListingStore.getState()[treeSide(id)]

const make = (id: TreeId): TreeStore =>
  createTreeStore({
    // The tree shows hidden folders when its panel shows hidden files.
    listDirs: (path) =>
      bridge.listDirs(path, panel(id).showHidden, !useSettingsStore.getState().settings.showSystem),
    describeError: (error) => toPanelError(error).message,
  })

export const trees: Record<TreeId, TreeStore> = {
  one: make("one"),
  left: make("left"),
  right: make("right"),
}

export interface TreeMenu {
  id: TreeId
  key: string
  /** Position inside the tree pane. */
  left: number
  top: number
}

interface TreeUiState {
  /** The tree's own cursor (a node key); the panel's folder is the tree's active node. */
  cursor: Record<TreeId, string | null>
  /** Increments to ask a tree to take the keys. */
  focusToken: Record<TreeId, number>
  menu: TreeMenu | null
}

export const useTreeUiStore = create<TreeUiState>(() => ({
  cursor: { one: null, left: null, right: null },
  focusToken: { one: 0, left: 0, right: 0 },
  menu: null,
}))

const setUi = useTreeUiStore.setState

export function setTreeCursor(id: TreeId, key: string | null): void {
  if (useTreeUiStore.getState().cursor[id] === key) return
  setUi((s) => ({ cursor: { ...s.cursor, [id]: key } }))
}

/** Shift+Tab from a panel: the keys go to that panel's tree (the one tree, or its own). */
export function focusTree(side: Side): boolean {
  const mode = usePanelsStore.getState().tree
  if (mode === "off") return false
  const id: TreeId = mode === "one" ? "one" : side
  setUi((s) => ({ focusToken: { ...s.focusToken, [id]: s.focusToken[id] + 1 } }))
  return true
}

export const openTreeMenu = (menu: TreeMenu): void => setUi({ menu })
export const closeTreeMenu = (): void => setUi({ menu: null })

/** The visible rows of a tree, with a note under a folder that could not be listed or is cut. */
export type TreePaneRow =
  (TreeRow & { type: "node" }) | { type: "note"; key: string; depth: number; label: string }

export function treeRows(id: TreeId): TreePaneRow[] {
  const tree = trees[id]
  const { roots, expanded } = tree.useStore.getState()
  const rows: TreePaneRow[] = []
  for (const row of tree.flatten(roots, expanded)) {
    rows.push({ ...row, type: "node" })
    if (!row.expanded || row.node.loading) continue
    if (row.node.error) {
      rows.push({
        type: "note",
        key: `error:${row.key}`,
        depth: row.depth + 1,
        label: row.node.error,
      })
    } else if (row.node.truncated) {
      rows.push({
        type: "note",
        key: `more:${row.key}`,
        depth: row.depth + 1,
        label: t("… more folders than the tree lists"),
      })
    }
  }
  return rows
}

// Following the panel ---------------------------------------------------------------

let visible = true
const pending = new Set<TreeId>()

/** After the next paint, so a folder change shows in the panel first (invariant 1). */
const afterPaint = (fn: () => void): void => {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(fn, 0))
  else setTimeout(fn, 0)
}

/** The tree shows its panel's folder: its ancestors expand, the folder becomes the active node. */
function follow(id: TreeId): void {
  if (pending.has(id)) return
  pending.add(id)
  afterPaint(() => {
    pending.delete(id)
    if (!visible || !visibleTrees(usePanelsStore.getState().tree).includes(id)) return
    // The crumbs as they are now: a newer folder change needs no second run.
    const { crumbs } = panel(id)
    if (crumbs.length > 0) void trees[id].reveal(crumbs)
  })
}

function showTrees(mode: TreeMode): void {
  const { volumes } = useDrivesStore.getState()
  for (const id of visibleTrees(mode)) {
    if (volumes.length > 0) trees[id].setRoots(volumes)
    follow(id)
  }
}

/** Follows the panels, the drives and the layout; started once by the app. */
export function startTree(): () => void {
  showTrees(usePanelsStore.getState().tree)
  const offPanels = usePanelsStore.subscribe((s, prev) => {
    if (s.tree !== prev.tree) showTrees(s.tree)
    else if (s.active !== prev.active && s.tree === "one") {
      // The one tree now works for the other panel, whose hidden setting may differ.
      const { left, right } = useListingStore.getState()
      if (left.showHidden !== right.showHidden) void trees.one.refreshAll()
      follow("one")
    }
  })
  const offDrives = useDrivesStore.subscribe((s, prev) => {
    if (s.volumes === prev.volumes) return
    for (const id of visibleTrees(usePanelsStore.getState().tree)) trees[id].setRoots(s.volumes)
  })
  // Settings → Show system files: the trees list their folders again.
  const offSystem = useSettingsStore.subscribe((s, prev) => {
    if (s.settings.showSystem === prev.settings.showSystem) return
    for (const id of visibleTrees(usePanelsStore.getState().tree)) void trees[id].refreshAll()
  })
  const offListing = useListingStore.subscribe((s, prev) => {
    for (const id of visibleTrees(usePanelsStore.getState().tree)) {
      const side = treeSide(id)
      if (s[side].crumbs !== prev[side].crumbs) follow(id)
      if (s[side].showHidden !== prev[side].showHidden) void trees[id].refreshAll()
    }
  })
  // A hidden app lists nothing (docs/shared/APP-SWITCHING.md); it catches up when shown.
  const offVisibility = isBridgeAvailable()
    ? bridge.on("app.visibility", ({ app, visible: shown }) => {
        if (app !== "commander") return
        visible = shown
        if (shown) for (const id of visibleTrees(usePanelsStore.getState().tree)) follow(id)
      })
    : () => undefined
  return () => {
    offPanels()
    offDrives()
    offListing()
    offSystem()
    offVisibility()
  }
}

// Commands of a node ------------------------------------------------------------------

/** Enter or a click on a node: its folder opens in the tree's panel. */
export function openTreeNode(id: TreeId, key: string): Promise<void> {
  const node = trees[id].getNode(key)
  if (!node) return Promise.resolve()
  return openIn(treeSide(id), node.path)
}

export function openIn(side: Side, path: string): Promise<void> {
  setActivePanel(side)
  return openPath(side, path)
}

/** The node's folder in a new tab of a panel (the tab after the current one). */
export function openInNewTab(side: Side, path: string): Promise<void> {
  setActivePanel(side)
  newTab(side)
  return openPath(side, path)
}

export async function addToHotlist(path: string): Promise<void> {
  try {
    await bridge.addBookmark(path)
    notice(t("Added to the directory hotlist."))
  } catch (error) {
    const reason =
      error instanceof PanelythError
        ? (error.details as { reason?: string } | undefined)?.reason
        : ""
    notice(
      reason === "duplicate"
        ? t("This folder is already in the directory hotlist.")
        : toPanelError(error).message,
    )
  }
}

/** Ctrl+R in the tree, the node menu: the node's subfolders are listed again. */
export const refreshTreeNode = (id: TreeId, key: string): Promise<void> => {
  const node = trees[id].getNode(key)
  return node ? trees[id].refreshNode(node.path) : Promise.resolve()
}

/** The key of a path's node. */
export const keyOf = treeNodeKey

/** Tests. */
export function resetTree(): void {
  visible = true
  pending.clear()
  for (const tree of Object.values(trees)) tree.reset()
  setUi({
    cursor: { one: null, left: null, right: null },
    focusToken: { one: 0, left: 0, right: 0 },
    menu: null,
  })
}
