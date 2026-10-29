import type { ReactNode } from "react"
import { TitleBarGridMenu, type TitleBarGridOption } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import {
  applyLayoutPreset,
  LAYOUT_PRESETS,
  matchingPreset,
  useLayoutState,
  type LayoutPresetId,
} from "../features/layoutPresets"
import { usePanelsStore } from "../features/panels"

/**
 * A drawing of the window: two panels, and what each preset puts in them;
 * 16px on the strip's button, larger in the menu's tiles (thinner lines there,
 * so they keep the same weight on screen).
 */
function LayoutIcon({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={size > 16 ? 0.75 : 1.25}
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
 * A preset that rebuilt the panels (Single and back) took the list that had the
 * keys with it: they go to the active panel's list.
 */
function focusActivePanel(): void {
  const side = usePanelsStore.getState().active
  document
    .querySelector<HTMLElement>(`[data-testid="grid-${side}"]`)
    ?.focus({ preventScroll: true })
}

/** The menu's tiles are this large. */
const LARGE = 40

/**
 * A preset's message is its name and what it does ("Details: both panels in
 * columns"): the tile shows them apart. Every language keeps the colon.
 */
function nameOf(label: string): { name: string; description?: string } {
  const [name = label, ...rest] = label.split(/\s*:\s*/)
  return rest.length > 0 ? { name, description: rest.join(": ") } : { name }
}

/**
 * The commander's layout presets (ADR-0045): one button on the title strip
 * (owner request 2026-10-27) showing the preset the window matches; pointing at
 * it opens every preset as a large tile. Each sets the whole window, so a
 * choice never depends on which panel is active. None is lit after the layout
 * was changed by hand.
 */
export function CommanderTitleControls() {
  const current = matchingPreset(useLayoutState())
  const options: TitleBarGridOption<LayoutPresetId>[] = LAYOUT_PRESETS.map((p) => ({
    value: p.id,
    ...nameOf(t(p.label)),
    icon: <LayoutIcon>{ICONS[p.id]}</LayoutIcon>,
    largeIcon: <LayoutIcon size={LARGE}>{ICONS[p.id]}</LayoutIcon>,
  }))
  return (
    <TitleBarGridMenu
      label={t("Layout presets")}
      value={current ?? ""}
      options={options}
      onChange={applyLayoutPreset}
      onFocusLost={focusActivePanel}
      testId="title-layout"
    />
  )
}
