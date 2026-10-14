/**
 * A marked entry's tab: a small triangle on the row's left edge, pointing at
 * the name, in the accent with a soft glow (it replaced the • of the gutter).
 * The row's parent cell is `relative`; the tab takes no space and never
 * catches the mouse. The glow is a drop shadow on the wrapper: a clip path
 * would cut off a shadow of the triangle itself.
 */
export function MarkTab({ marked }: { marked: boolean }) {
  if (!marked) return null
  return (
    <span
      aria-hidden="true"
      data-mark-tab
      className="pointer-events-none absolute top-[22%] bottom-[22%] left-0 w-1.5 drop-shadow-[0_0_3px_color-mix(in_srgb,var(--accent)_60%,transparent)]"
    >
      <span className="block size-full bg-accent [clip-path:polygon(0_0,100%_50%,0_100%)]" />
    </span>
  )
}
