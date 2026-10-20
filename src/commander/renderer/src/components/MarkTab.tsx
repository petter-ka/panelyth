/**
 * A marked entry's mark: a small dot in the middle of the empty space before
 * the row's content, in the accent with a soft glow. It is drawn in the
 * row's gutter cell (positioned: `relative` or `sticky`); `shift` moves it
 * right by half the difference between the space after the gutter and the
 * space before it, so it sits mid-way between the row's edge and the icon.
 * The dot is 4 px: a center on a whole pixel keeps its edges on whole pixels
 * (sharp). It takes no space and never catches the mouse.
 */
export function MarkTab({ marked, shift = 0 }: { marked: boolean; shift?: number }) {
  if (!marked) return null
  return (
    <span
      aria-hidden="true"
      data-mark-tab
      className="pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_4px_color-mix(in_srgb,var(--accent)_60%,transparent)]"
      style={{ left: `calc(50% + ${shift}px)` }}
    />
  )
}
