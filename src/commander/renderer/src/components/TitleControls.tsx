import type { ReactNode } from "react"
import { TitleBarSegment, type TitleBarOption } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import {
  applyLayoutPreset,
  LAYOUT_PRESETS,
  matchingPreset,
  useLayoutState,
  type LayoutPresetId,
} from "../features/layoutPresets"

/** A small drawing of the window: two panels, and what each preset puts in them (16px). */
function LayoutIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      {children}
    </svg>
  )
}

const ICONS: Record<LayoutPresetId, ReactNode> = {
  // Rows with a column each side.
  details: <path d="M8 2.5v11M3.5 5.5h3M3.5 8h3M3.5 10.5h3M9.5 5.5h3M9.5 8h3M9.5 10.5h3" />,
  // Short names in two columns per panel.
  list: (
    <path d="M8 2.5v11M3.5 5.5h1M5.5 5.5h1M3.5 8h1M5.5 8h1M9.5 5.5h1M11.5 5.5h1M9.5 8h1M11.5 8h1" />
  ),
  // A narrow tree column, then the two panels.
  tree: <path d="M5 2.5v11M9.75 2.5v11M2.75 5.5h1M3.25 8h.75M3.25 10.5h.75" />,
  // Tiles.
  gallery: <path d="M8 2.5v11M3.5 5h2v2h-2zM3.5 9h2v2h-2zM10.5 5h2v2h-2zM10.5 9h2v2h-2z" />,
  // One panel across the window, tiles in it.
  single: (
    <path d="M3.75 5h2v2h-2zM7 5h2v2H7zM10.25 5h2v2h-2zM3.75 9h2v2h-2zM7 9h2v2H7zM10.25 9h2v2h-2z" />
  ),
  // One panel above the other, rows in each.
  stacked: <path d="M1.5 8h13M4 5.25h8M4 10.75h8" />,
  // Rows on the left, a picture on the right.
  preview: (
    <path d="M8 2.5v11M3.5 5.5h3M3.5 8h3M3.5 10.5h3M9.5 11l1.75-2.5 1.25 1.5.75-1 .75 2M11 5.75h.01" />
  ),
}

/**
 * The commander's layout presets in the title strip (ADR-0045): each sets the
 * whole window, so a click never depends on which panel is active. Lit when the
 * window matches a preset; none is lit after the layout was changed by hand.
 */
export function CommanderTitleControls() {
  const current = matchingPreset(useLayoutState())
  const options: TitleBarOption<LayoutPresetId | "">[] = LAYOUT_PRESETS.map((p) => ({
    value: p.id,
    label: t(p.label),
    icon: <LayoutIcon>{ICONS[p.id]}</LayoutIcon>,
  }))
  return (
    <TitleBarSegment
      label={t("Layout")}
      value={current ?? ""}
      options={options}
      onChange={(id) => id && applyLayoutPreset(id)}
      testId="title-layout"
    />
  )
}
