import type { CSSProperties } from "react"
import { useUiStore } from "../features/commands"
import type { Side } from "../features/panels"
import { RIGHT_HOLD_MS } from "./useRightButton"

/**
 * A small ring beside the pointer while the right button is held on an entry:
 * it fills over the hold time, and the context menu opens when it is full.
 * CSS only (styles.css), so the hold costs one render.
 */
export function HoldRing({ side }: { side: Side }) {
  const hold = useUiStore((s) => (s.hold?.side === side ? s.hold : null))
  if (!hold) return null
  return (
    <svg
      aria-hidden="true"
      data-testid={`hold-ring-${side}`}
      viewBox="0 0 18 18"
      className="hold-ring pointer-events-none absolute z-20 size-[18px] -rotate-90 rounded-full bg-raised shadow-md shadow-black/30"
      style={
        {
          left: hold.left + 12,
          top: hold.top + 12,
          "--hold": `${RIGHT_HOLD_MS}ms`,
        } as CSSProperties
      }
    >
      <circle cx="9" cy="9" r="7" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="9"
        cy="9"
        r="7"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="44"
        className="stroke-accent"
      />
    </svg>
  )
}
