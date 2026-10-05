import { bridge } from "../../bridge"
import { useLibraryStore } from "../library/libraryStore"
import { useVideoPrefs } from "./video"

// Volume and mute persist across restarts in library.db (setting "player";
// Stage 08, a Stage 06 follow-up). Saves are debounced: the volume slider
// changes the value on every pointer move.

const PLAYER_KEY = "player"
const SAVE_DELAY_MS = 500

function parse(value: unknown): { volume: number; muted: boolean } | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.volume !== "number" || !Number.isFinite(v.volume) || typeof v.muted !== "boolean") {
    return null
  }
  return { volume: Math.min(1, Math.max(0, v.volume)), muted: v.muted }
}

/** Restores the saved volume once the library loads, then saves changes. */
export function startVideoPrefsPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let applying = false
  const save = (): void => {
    timer = null
    const { volume, muted } = useVideoPrefs.getState()
    void bridge.setSetting(PLAYER_KEY, { volume, muted }).catch(() => undefined)
  }
  const flush = (): void => {
    if (!timer) return
    clearTimeout(timer)
    save()
  }
  const load = (settings: Record<string, unknown>): void => {
    const stored = parse(settings[PLAYER_KEY])
    if (!stored) return
    applying = true
    useVideoPrefs.setState(stored)
    applying = false
  }

  if (useLibraryStore.getState().loaded) load(useLibraryStore.getState().settings)
  const unsubs = [
    useLibraryStore.subscribe((s, prev) => {
      if (s.loaded && !prev.loaded) load(s.settings)
    }),
    useVideoPrefs.subscribe((s, prev) => {
      if (applying || (s.volume === prev.volume && s.muted === prev.muted)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, SAVE_DELAY_MS)
    }),
  ]
  window.addEventListener("pagehide", flush)
  return () => {
    window.removeEventListener("pagehide", flush)
    flush()
    unsubs.forEach((u) => u())
  }
}
