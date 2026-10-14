import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

interface Readout {
  before: number
  after: number
  left: number
  top: number
  /** Panels stacked top to bottom (the border runs across). */
  stacked: boolean
}

/** Gap between the pointer and the readout. */
const OFFSET = 14

/**
 * While a resize border is hovered, dragged or focused, the shares of the two
 * panels beside it, in percent of their group, next to the pointer. It reads
 * what the panel library keeps on the border's element (`data-separator`,
 * `aria-valuenow`), so during a drag only this readout re-renders, not the
 * layout around it. Screen readers already hear `aria-valuenow`.
 */
export function SeparatorReadout({ separator }: { separator: RefObject<HTMLElement | null> }) {
  const [readout, setReadout] = useState<Readout | null>(null)

  useEffect(() => {
    const el = separator.current
    if (!el) return
    const pointer = { x: -1, y: -1 }
    const update = (): void => {
      const state = el.dataset.separator
      const prev = el.previousElementSibling
      const next = el.nextElementSibling
      const group = el.parentElement
      if (
        (state !== "hover" && state !== "active" && state !== "focus") ||
        !prev ||
        !next ||
        !group
      ) {
        setReadout((r) => (r ? null : r))
        return
      }
      // A border across the panels has a horizontal orientation.
      const stacked = el.getAttribute("aria-orientation") === "horizontal"
      const extent = (r: DOMRect): number => (stacked ? r.height : r.width)
      const whole = extent(group.getBoundingClientRect())
      if (whole <= 0) return
      const line = el.getBoundingClientRect()
      // Keys move the border without a pointer: the readout sits at its middle.
      const usePointer = state !== "focus" && pointer.x >= 0
      const left = stacked
        ? (usePointer ? pointer.x : line.left + line.width / 2) + OFFSET
        : line.left + line.width / 2
      const top = stacked
        ? line.top + line.height / 2
        : (usePointer ? pointer.y : line.top + line.height / 2) - OFFSET
      setReadout({
        before: Math.round((extent(prev.getBoundingClientRect()) / whole) * 100),
        after: Math.round((extent(next.getBoundingClientRect()) / whole) * 100),
        left,
        top,
        stacked,
      })
    }
    const onPointer = (e: PointerEvent): void => {
      pointer.x = e.clientX
      pointer.y = e.clientY
      const state = el.dataset.separator
      if (state === "hover" || state === "active") update()
    }
    const observer = new MutationObserver(update)
    observer.observe(el, { attributes: true, attributeFilter: ["data-separator", "aria-valuenow"] })
    window.addEventListener("pointermove", onPointer, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener("pointermove", onPointer)
    }
  }, [separator])

  if (!readout) return null
  const { stacked } = readout
  return createPortal(
    <div
      aria-hidden="true"
      data-testid="separator-readout"
      className={`pointer-events-none fixed z-[200] flex items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 text-2xs font-medium text-text shadow-md prose-nums ${stacked ? "flex-col" : ""}`}
      style={{
        left: readout.left,
        top: readout.top,
        transform: stacked ? "translateY(-50%)" : "translate(-50%, -100%)",
      }}
    >
      <span>{readout.before}%</span>
      <span className={stacked ? "h-px w-3 bg-border" : "h-3 w-px bg-border"} />
      <span>{readout.after}%</span>
    </div>,
    document.body,
  )
}
