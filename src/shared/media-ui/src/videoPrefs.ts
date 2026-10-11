import { mediaPort } from "./port"
import { useVideoPrefs, type VideoPrefs } from "./video"

// Volume, mute and repeat persist in library.db (setting "player") through the
// app's media port, so they are the same in the viewer, the commander and the
// media window: mute one video and the next stays muted until it is unmuted.
// Saves are debounced (the volume slider changes the value on every pointer
// move); a window that was in the background re-reads on focus, because
// another window may have changed them.

const PLAYER_KEY = "player"
const SAVE_DELAY_MS = 500

/** The stored setting, or null when it is missing or malformed. `loop` is new: absent = off. */
export function parsePlayerPrefs(value: unknown): VideoPrefs | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.volume !== "number" || !Number.isFinite(v.volume) || typeof v.muted !== "boolean") {
    return null
  }
  return {
    volume: Math.min(1, Math.max(0, v.volume)),
    muted: v.muted,
    loop: v.loop === true,
  }
}

/** Restores the saved player preferences, then saves changes; returns the stop function. */
export function startVideoPrefsPersistence(): () => void {
  const settings = mediaPort().settings
  if (!settings) return () => undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let applying = false
  let stopped = false

  const save = (): void => {
    timer = null
    const { volume, muted, loop } = useVideoPrefs.getState()
    void settings.write(PLAYER_KEY, { volume, muted, loop }).catch(() => undefined)
  }
  const flush = (): void => {
    if (!timer) return
    clearTimeout(timer)
    save()
  }
  const load = (): void => {
    // Unsaved local changes win over a stale read.
    if (timer) return
    void settings
      .read(PLAYER_KEY)
      .then((value) => {
        const stored = parsePlayerPrefs(value)
        if (!stored || stopped || timer) return
        applying = true
        useVideoPrefs.setState(stored)
        applying = false
      })
      .catch(() => undefined)
  }

  load()
  const unsubscribe = useVideoPrefs.subscribe((s, prev) => {
    if (applying || (s.volume === prev.volume && s.muted === prev.muted && s.loop === prev.loop))
      return
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  })
  window.addEventListener("focus", load)
  window.addEventListener("pagehide", flush)
  return () => {
    stopped = true
    window.removeEventListener("focus", load)
    window.removeEventListener("pagehide", flush)
    flush()
    unsubscribe()
  }
}
