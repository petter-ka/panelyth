import { create } from "zustand"
import { readMirror } from "../workspace/mirror"
import { TILE_SIZE_ORDER, type TileSize } from "./layout"

// Persisted with the workspace (library.db + localStorage mirror,
// features/workspace); the initial value comes from the mirror.
interface LayoutState {
  tileSize: TileSize
  setTileSize(size: TileSize): void
  /** Ctrl/Cmd + wheel: step to the next smaller (-1) or larger (+1) size. */
  stepTileSize(direction: -1 | 1): void
}

export const useLayoutStore = create<LayoutState>((set, get) => ({
  tileSize: readMirror().tileSize,
  setTileSize(tileSize) {
    set({ tileSize })
  },
  stepTileSize(direction) {
    const i = TILE_SIZE_ORDER.indexOf(get().tileSize) + direction
    const next = TILE_SIZE_ORDER[Math.min(Math.max(i, 0), TILE_SIZE_ORDER.length - 1)]!
    if (next !== get().tileSize) get().setTileSize(next)
  },
}))

/** Re-reads the persisted size (tests). */
export function resetLayoutStore(): void {
  useLayoutStore.setState({ tileSize: readMirror().tileSize })
}
