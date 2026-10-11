// F6 / Shift+F6 move keyboard focus between the workspace panes (Stage 08,
// the Windows convention; Explorer and Finder both cycle panes). Each pane is
// a landmark; focus lands on its primary control (the folder tree, the tile
// view) or, failing that, its first focusable element or the landmark itself.
// Collapsed panes are skipped.

const PANES = [
  // data-pane, not aria-label: labels are translated (ADR-0034).
  '[data-pane="locations"]',
  '[data-pane="content"]',
  '[data-pane="preview"]',
]

const PRIMARY = '[role="tree"], [data-testid="tile-view"]'
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])'

function visiblePanes(): HTMLElement[] {
  return PANES.map((s) => document.querySelector<HTMLElement>(s)).filter(
    (el): el is HTMLElement =>
      !!el &&
      el.offsetWidth > 0 &&
      el.offsetHeight > 0 &&
      getComputedStyle(el).visibility !== "hidden",
  )
}

function focusPane(pane: HTMLElement): void {
  const target =
    pane.querySelector<HTMLElement>(PRIMARY) ?? pane.querySelector<HTMLElement>(FOCUSABLE)
  if (target) {
    target.focus()
    return
  }
  if (!pane.hasAttribute("tabindex")) pane.tabIndex = -1
  pane.focus()
}

/** Moves focus to the next (1) or previous (-1) visible pane. */
export function cyclePaneFocus(direction: 1 | -1): void {
  const panes = visiblePanes()
  if (panes.length === 0) return
  const current = panes.findIndex((p) => p.contains(document.activeElement))
  const next =
    current < 0
      ? direction === 1
        ? 0
        : panes.length - 1
      : (current + direction + panes.length) % panes.length
  focusPane(panes[next]!)
}
