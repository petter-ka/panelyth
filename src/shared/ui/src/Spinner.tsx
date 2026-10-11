/**
 * A small ring on something that is being opened (a drive that has to wake
 * up, a slow network folder). It fades in after a moment (styles.css), so an
 * open that answers at once never flashes it.
 */
export function Spinner({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-spinner
      className={`pending-spinner shrink-0 ${className}`}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="11 100"
      />
    </svg>
  )
}
