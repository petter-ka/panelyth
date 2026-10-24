import { msg } from "@panelyth/i18n"
import { closeQuickSearch } from "./quicksearch"
import { SIDES, setView, useListingStore, type ViewMode } from "./listing"
import {
  setArrangement,
  setTreeMode,
  usePanelsStore,
  type Arrangement,
  type Side,
  type TreeMode,
} from "./panels"
import { closeQuickView, toggleQuickView, useViewersStore } from "./viewers"

// Layout presets for the title strip (ADR-0045): one click sets the whole
// window, the panels' arrangement, both panels' views, the folder tree and
// quick view, instead of a switch that changed only the active panel.

export type LayoutPresetId =
  "details" | "list" | "tree" | "gallery" | "single" | "preview" | "stacked"

export interface LayoutPreset {
  id: LayoutPresetId
  /** The name and what it does, for the tooltip and screen readers. */
  label: string
  /** Both panels' view; with quick view, the active panel's (the other shows the preview). */
  view: ViewMode
  tree: TreeMode
  quick: boolean
  arrangement: Arrangement
}

export const LAYOUT_PRESETS: readonly LayoutPreset[] = [
  {
    id: "details",
    label: msg("Details: both panels in columns"),
    view: "full",
    tree: "off",
    quick: false,
    arrangement: "side",
  },
  {
    id: "list",
    label: msg("List: both panels in the Brief view"),
    view: "brief",
    tree: "off",
    quick: false,
    arrangement: "side",
  },
  {
    id: "tree",
    label: msg("Tree: a folder tree beside the panels"),
    view: "full",
    tree: "one",
    quick: false,
    arrangement: "side",
  },
  {
    id: "gallery",
    label: msg("Gallery: both panels as thumbnails"),
    view: "thumbs",
    tree: "off",
    quick: false,
    arrangement: "side",
  },
  {
    id: "single",
    label: msg("Single: one panel as thumbnails (Tab shows the other)"),
    view: "thumbs",
    tree: "off",
    quick: false,
    arrangement: "single",
  },
  {
    id: "preview",
    label: msg("Preview: quick view in the other panel"),
    view: "full",
    tree: "off",
    quick: true,
    arrangement: "side",
  },
  {
    id: "stacked",
    label: msg("Stacked: one panel above the other"),
    view: "full",
    tree: "off",
    quick: false,
    arrangement: "stacked",
  },
]

export interface LayoutState {
  active: Side
  views: Record<Side, ViewMode>
  tree: TreeMode
  quick: boolean
  arrangement: Arrangement
}

/** The preset the window shows now; null when it was changed by hand into none of them. */
export function matchingPreset(s: LayoutState): LayoutPresetId | null {
  const match = LAYOUT_PRESETS.find(
    (p) =>
      p.arrangement === s.arrangement &&
      p.tree === s.tree &&
      p.quick === s.quick &&
      (p.quick ? s.views[s.active] === p.view : SIDES.every((side) => s.views[side] === p.view)),
  )
  return match?.id ?? null
}

/** Sets the whole window to a preset. */
export function applyLayoutPreset(id: LayoutPresetId): void {
  const preset = LAYOUT_PRESETS.find((p) => p.id === id)
  if (!preset) return
  const active = usePanelsStore.getState().active
  // With quick view the other panel shows the preview; its own view stays as it was.
  for (const side of SIDES) if (!preset.quick || side === active) setView(side, preset.view)
  setArrangement(preset.arrangement)
  setTreeMode(preset.tree)
  const quickOpen = useViewersStore.getState().quick !== null
  if (preset.quick && !quickOpen) {
    closeQuickSearch()
    toggleQuickView(active)
  } else if (!preset.quick && quickOpen) closeQuickView()
}

/** The window's layout as the presets read it. */
export function useLayoutState(): LayoutState {
  const active = usePanelsStore((s) => s.active)
  const left = useListingStore((s) => s.left.view)
  const right = useListingStore((s) => s.right.view)
  const tree = usePanelsStore((s) => s.tree)
  const quick = useViewersStore((s) => s.quick !== null)
  const arrangement = usePanelsStore((s) => s.arrangement)
  return { active, views: { left, right }, tree, quick, arrangement }
}
