import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

export type Side = "left" | "right"

/** The commander's own layout setting (ADR-0031: per-app keys under commander.*). */
export const LAYOUT_KEY = "commander.layout"
const DEFAULT_SPLIT = 50
const SAVE_DELAY_MS = 400

interface PanelsState {
  active: Side
  /** Left panel width in percent of the panel pair. */
  split: number
  /** Changes when a stored layout is applied, so the panel group remounts with it. */
  layoutToken: number
}

export const usePanelsStore = create<PanelsState>(() => ({
  active: "left",
  split: DEFAULT_SPLIT,
  layoutToken: 0,
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

/** A divider drag finished: persisted after a short quiet period, never per pixel. */
export function setSplit(split: number): void {
  const value = Math.min(90, Math.max(10, Math.round(split * 10) / 10))
  usePanelsStore.setState({ split: value })
  if (!isBridgeAvailable()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void bridge.setSetting(LAYOUT_KEY, { v: 1, split: value }).catch(() => undefined)
  }, SAVE_DELAY_MS)
}

/** Double-click on the divider: back to 50/50. */
export function resetSplit(): void {
  setSplit(DEFAULT_SPLIT)
  usePanelsStore.setState((s) => ({ layoutToken: s.layoutToken + 1 }))
}

/** Applies the stored layout once library.db is reachable. */
export async function loadLayout(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  const stored = settings[LAYOUT_KEY] as { v?: unknown; split?: unknown } | undefined
  if (
    stored?.v === 1 &&
    typeof stored.split === "number" &&
    stored.split >= 10 &&
    stored.split <= 90
  ) {
    usePanelsStore.setState((s) => ({
      split: stored.split as number,
      layoutToken: s.layoutToken + 1,
    }))
  }
}
