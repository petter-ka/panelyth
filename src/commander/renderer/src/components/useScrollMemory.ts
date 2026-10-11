import { useLayoutEffect, useRef, type RefObject } from "react"
import type { Side } from "../features/panels"

/** The last scroll offset per panel side and folder; a few numbers, never reactive. */
const offsets = new Map<string, number>()
const MAX_REMEMBERED = 500

function setScroll(node: HTMLElement, axis: "top" | "left", value: number): void {
  if (axis === "top") node.scrollTop = value
  else node.scrollLeft = value
}

/**
 * Remembers where a folder was scrolled to and puts the list back there when
 * the folder shows again (going up, Back, a tab switch). `key` is null for
 * views that are not a plain folder (branch, search results, archives); those
 * open at the top. The cursor effect of the view still keeps the cursor
 * visible afterwards.
 */
export function useScrollMemory(
  el: RefObject<HTMLElement | null>,
  side: Side,
  key: number | null,
  axis: "top" | "left",
): void {
  const current = useRef<string | null>(null)

  // Layout effect: runs before paint and before the view's cursor effect.
  useLayoutEffect(() => {
    const node = el.current
    if (!node) return
    const next = key === null ? null : `${side}:${key}`
    if (next !== current.current) {
      current.current = next
      const saved = next === null ? undefined : offsets.get(next)
      setScroll(node, axis, saved ?? 0)
      // The virtualizer learns its offset from scroll events, which the
      // browser delivers later; without this its cursor reveal (below) would
      // run against the old offset and park the cursor at the list's edge.
      node.dispatchEvent(new Event("scroll"))
    }
    const onScroll = (): void => {
      const at = current.current
      if (at === null) return
      offsets.delete(at)
      offsets.set(at, axis === "top" ? node.scrollTop : node.scrollLeft)
      if (offsets.size > MAX_REMEMBERED) offsets.delete(offsets.keys().next().value as string)
    }
    node.addEventListener("scroll", onScroll, { passive: true })
    return () => node.removeEventListener("scroll", onScroll)
  }, [el, side, key, axis])
}
