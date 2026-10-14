import { useEffect, useState, type RefObject } from "react"

/** Full screen: the bars and the cursor hide after the mouse rests this long. */
export const CONTROLS_IDLE_MS = 3000

/**
 * True once the mouse has rested `CONTROLS_IDLE_MS` while `enabled`; a move, a
 * click, the wheel or a key makes it false again. While `hold` is true (the
 * pointer is on a bar) it does not become idle. Always false when disabled.
 */
export function useIdle(enabled: boolean, hold?: RefObject<boolean>): boolean {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!enabled) {
      setIdle(false)
      return
    }
    const rest = (): void => setIdle(!hold?.current)
    let timer = setTimeout(rest, CONTROLS_IDLE_MS)
    const wake = (): void => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(rest, CONTROLS_IDLE_MS)
    }
    const events = ["pointermove", "pointerdown", "wheel", "keydown"] as const
    for (const e of events) window.addEventListener(e, wake, { passive: true })
    return () => {
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, wake)
    }
  }, [enabled, hold])
  return enabled && idle
}
