import { SORT_FIELDS, type SortKey } from "@fastview/contracts"
import type { TileSize } from "../tiles/layout"

/**
 * The persisted workspace. library.db (setting "workspace") is the source of
 * truth; this localStorage mirror lets the first paint use the saved layout
 * without waiting for the sidecar. No store imports here: stores read their
 * initial values from this module.
 */
export interface Workspace {
  v: 1
  /** Pane sizes in percent by panel id (react-resizable-panels layout); collapsed = 0. */
  panes: Record<string, number> | null
  tileSize: TileSize
  sort: SortKey[]
  /** When it last changed (epoch ms): on startup the newer of mirror and library.db wins. */
  at: number
}

export const WORKSPACE_KEY = "workspace"
const MIRROR_KEY = "fastview.workspace"
/** Stage 03/04 stored only the tile size, under its own key. */
const LEGACY_TILE_SIZE_KEY = "fastview.tileSize"

export const DEFAULT_WORKSPACE: Workspace = {
  v: 1,
  panes: null,
  tileSize: "medium",
  sort: [{ field: "name", direction: "asc" }],
  at: 0,
}

const sortFields: ReadonlySet<unknown> = new Set(SORT_FIELDS)
const isTileSize = (v: unknown): v is TileSize => v === "small" || v === "medium" || v === "large"

/** Validates untrusted persisted data; anything unusable falls back to defaults. */
export function parseWorkspace(value: unknown): Workspace | null {
  if (typeof value !== "object" || value === null) return null
  const w = value as Record<string, unknown>
  if (w.v !== 1) return null
  const sort = Array.isArray(w.sort)
    ? w.sort
        .filter(
          (k): k is SortKey =>
            typeof k === "object" &&
            k !== null &&
            sortFields.has((k as SortKey).field) &&
            ((k as SortKey).direction === "asc" || (k as SortKey).direction === "desc"),
        )
        .slice(0, 2)
    : []
  let panes: Record<string, number> | null = null
  if (typeof w.panes === "object" && w.panes !== null) {
    const entries = Object.entries(w.panes).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100,
    )
    if (entries.length > 0) panes = Object.fromEntries(entries) as Record<string, number>
  }
  return {
    v: 1,
    panes,
    tileSize: isTileSize(w.tileSize) ? w.tileSize : DEFAULT_WORKSPACE.tileSize,
    sort: sort.length > 0 ? sort : DEFAULT_WORKSPACE.sort,
    at: typeof w.at === "number" && Number.isFinite(w.at) ? w.at : 0,
  }
}

export function readMirror(): Workspace {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    const parsed = raw ? parseWorkspace(JSON.parse(raw)) : null
    if (parsed) return parsed
    const legacy = localStorage.getItem(LEGACY_TILE_SIZE_KEY)
    return { ...DEFAULT_WORKSPACE, tileSize: isTileSize(legacy) ? legacy : "medium" }
  } catch {
    return DEFAULT_WORKSPACE
  }
}

export function writeMirror(w: Workspace): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(w))
  } catch {
    // storage unavailable: library.db still has it
  }
}

/** Read once at startup; stores take their initial values from it. */
export const initialWorkspace: Workspace = readMirror()
