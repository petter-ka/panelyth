import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

export type Side = "left" | "right"

/**
 * The folder tree beside the panels (Stage C10.5, CFR-30): none, one that
 * follows the active panel, or one beside each panel. Ctrl+Shift+F8 cycles.
 */
export type TreeMode = "off" | "one" | "two"
export const TREE_MODES: readonly TreeMode[] = ["off", "one", "two"]

/** The commander's own layout setting (ADR-0031: per-app keys under commander.*). */
export const LAYOUT_KEY = "commander.layout"
const DEFAULT_SPLIT = 50
const SAVE_DELAY_MS = 400
export const TREE_WIDTH = { min: 120, max: 480, initial: 220 }

interface PanelsState {
  active: Side
  /** Left panel width in percent of the panel pair. */
  split: number
  /** Changes when a stored layout is applied, so the panel group remounts with it. */
  layoutToken: number
  tree: TreeMode
  /** Width of a tree pane in CSS pixels. */
  treeWidth: number
}

export const usePanelsStore = create<PanelsState>(() => ({
  active: "left",
  split: DEFAULT_SPLIT,
  layoutToken: 0,
  tree: "off",
  treeWidth: TREE_WIDTH.initial,
}))

export const otherSide = (side: Side): Side => (side === "left" ? "right" : "left")

export function setActivePanel(active: Side): void {
  usePanelsStore.setState({ active })
}

/** Tab: the other panel becomes active. */
export function toggleActivePanel(): void {
  setActivePanel(otherSide(usePanelsStore.getState().active))
}

let timer: ReturnType<typeof setTimeout> | null = null

/** The layout is persisted after a short quiet period, never per pixel of a drag. */
function saveLayout(): void {
  if (!isBridgeAvailable()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const { split, tree, treeWidth } = usePanelsStore.getState()
    void bridge.setSetting(LAYOUT_KEY, { v: 1, split, tree, treeWidth }).catch(() => undefined)
  }, SAVE_DELAY_MS)
}

/** A divider drag finished. */
export function setSplit(split: number): void {
  const value = Math.min(90, Math.max(10, Math.round(split * 10) / 10))
  usePanelsStore.setState({ split: value })
  saveLayout()
}

/** Double-click on the divider: back to 50/50. */
export function resetSplit(): void {
  setSplit(DEFAULT_SPLIT)
  usePanelsStore.setState((s) => ({ layoutToken: s.layoutToken + 1 }))
}

export function setTreeMode(tree: TreeMode): void {
  if (usePanelsStore.getState().tree === tree) return
  usePanelsStore.setState({ tree })
  saveLayout()
}

/** The settings window changed the folder tree mode (ADR-0039); the split stays as it is here. */
export function applyLayoutSetting(value: unknown): void {
  const { tree } = readLayout(value)
  if (tree !== undefined && tree !== usePanelsStore.getState().tree)
    usePanelsStore.setState({ tree })
}

/** Ctrl+Shift+F8: no tree, one tree, a tree per panel. */
export function cycleTreeMode(): void {
  const at = TREE_MODES.indexOf(usePanelsStore.getState().tree)
  setTreeMode(TREE_MODES[(at + 1) % TREE_MODES.length]!)
}

/** The tree's divider was dragged, or moved with the arrow keys. */
export function setTreeWidth(width: number): void {
  const value = Math.min(TREE_WIDTH.max, Math.max(TREE_WIDTH.min, Math.round(width)))
  if (usePanelsStore.getState().treeWidth === value) return
  usePanelsStore.setState({ treeWidth: value })
  saveLayout()
}

/** Validated stored layout; unknown values keep the defaults. */
export function readLayout(
  value: unknown,
): Partial<Pick<PanelsState, "split" | "tree" | "treeWidth">> {
  const stored = (value ?? {}) as Record<string, unknown>
  if (stored.v !== 1) return {}
  const { split, tree, treeWidth } = stored
  return {
    ...(typeof split === "number" && split >= 10 && split <= 90 && { split }),
    ...(TREE_MODES.includes(tree as TreeMode) && { tree: tree as TreeMode }),
    ...(typeof treeWidth === "number" &&
      treeWidth >= TREE_WIDTH.min &&
      treeWidth <= TREE_WIDTH.max && { treeWidth: Math.round(treeWidth) }),
  }
}

/** Applies the stored layout once library.db is reachable. */
export async function loadLayout(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  const layout = readLayout(settings[LAYOUT_KEY])
  if (Object.keys(layout).length === 0) return
  usePanelsStore.setState((s) => ({
    ...layout,
    // The panel group takes its split when it mounts.
    layoutToken: layout.split === undefined ? s.layoutToken : s.layoutToken + 1,
  }))
}
