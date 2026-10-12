import type {
  ContentItem,
  ErrorCode,
  PreviewItem,
  PreviewPriority,
  PreviewProfile,
  Thumb,
} from "@panelyth/contracts"
import { MAX_ENSURE_ITEMS } from "@panelyth/contracts"
import { useSyncExternalStore } from "react"
import { isMediaAvailable, mediaPort } from "../port"

/**
 * Thumbnail state per entry id, kept outside React state (CLAUDE.md): one
 * subscriber set per id, so a finished preview re-renders exactly one tile.
 * Only URLs are stored, never image bytes; Chromium loads and caches the
 * files through panelyth-thumb:.
 *
 * One store per tile view (moved from the viewer in Stage C10): the viewer
 * has one, the commander one per panel. Each has its own preview lane, so a
 * request of one view never drops another view's queued work.
 */
export type ThumbState =
  { status: "ready"; thumb: Thumb } | { status: "failed"; code: ErrorCode } | { status: "pending" }

export interface ThumbRequest {
  item: ContentItem
  priority: PreviewPriority
}

export interface ThumbStore {
  /** Forget everything (folder change, profile change). */
  reset(): void
  getProfile(): PreviewProfile
  /**
   * The profile follows tile size × device pixel ratio. Changing it drops all
   * states: thumbnails of another size are different cache entries.
   */
  setProfile(next: PreviewProfile): void
  /** Records identities and thumbnails that arrived attached to a page. */
  seed(items: readonly ContentItem[], pageProfile: PreviewProfile): void
  /**
   * Requests previews for the settled visible range in one call. Every call is
   * a new epoch: the sidecar drops queued work for tiles that scrolled away
   * and were not requested again (Stage 02 lanes).
   */
  requestVisible(wanted: readonly ThumbRequest[]): Promise<void>
  /**
   * The cached file failed to load (deleted by cleanup or corrupt): regenerate
   * it once. A second failure is shown as failed.
   */
  reportBroken(id: number): void
  get(id: number): ThumbState | undefined
  subscribe(id: number, listener: () => void): () => void
  /** Applies batched preview.ready events; returns the stop function. */
  start(): () => void
}

const MAX_ENTRIES = 20_000

export function createThumbStore(lane: string): ThumbStore {
  let profile: PreviewProfile = "grid-sm"
  const states = new Map<number, ThumbState>()
  const listeners = new Map<number, Set<() => void>>()
  const retried = new Set<number>()
  // Source identity per id (size + mtime): a file modified in place keeps its
  // id, and its old thumbnail must not be reused.
  const identity = new Map<number, string>()
  let epoch = 0

  function set(id: number, state: ThumbState): void {
    states.set(id, state)
    listeners.get(id)?.forEach((l) => l())
  }

  function apply(item: PreviewItem): void {
    if (item.profile !== profile) return
    if ("failed" in item) set(item.id, { status: "failed", code: item.failed })
    else
      set(item.id, {
        status: "ready",
        thumb: { url: item.url, width: item.width, height: item.height },
      })
  }

  function reset(): void {
    states.clear()
    retried.clear()
    identity.clear()
    listeners.forEach((set) => set.forEach((l) => l()))
  }

  return {
    reset,
    getProfile: () => profile,
    setProfile(next) {
      if (next === profile) return
      profile = next
      epoch++
      reset()
    },
    seed(items, pageProfile) {
      if (states.size > MAX_ENTRIES) reset()
      for (const item of items) {
        if (item.kind === "dir") continue
        const sig = `${item.sizeBytes}:${item.modifiedMs}`
        if (identity.get(item.id) !== sig) {
          const had = states.has(item.id)
          identity.set(item.id, sig)
          states.delete(item.id)
          retried.delete(item.id)
          if (had) listeners.get(item.id)?.forEach((l) => l())
        }
        if (item.thumb && pageProfile === profile) {
          set(item.id, { status: "ready", thumb: item.thumb })
        }
      }
    },
    async requestVisible(wanted) {
      const items: { id: number; priority: PreviewPriority }[] = []
      const seen = new Set<number>()
      for (const { item, priority } of wanted) {
        if (item.kind === "dir" || seen.has(item.id)) continue
        seen.add(item.id)
        const s = states.get(item.id)
        if (s?.status === "ready" || s?.status === "failed") continue
        if (!s) set(item.id, { status: "pending" })
        items.push({ id: item.id, priority })
        if (items.length === MAX_ENSURE_ITEMS) break
      }
      if (items.length === 0) return
      const res = await mediaPort().ensurePreviews({
        lane,
        epoch: ++epoch,
        profile,
        items,
        force: [],
      })
      res.items.forEach(apply)
    },
    reportBroken(id) {
      if (retried.has(id)) {
        set(id, { status: "failed", code: "CACHE_ERROR" })
        return
      }
      retried.add(id)
      set(id, { status: "pending" })
      void mediaPort()
        .ensurePreviews({ lane, epoch, profile, items: [{ id, priority: 0 }], force: [id] })
        .then((res) => res.items.forEach(apply))
        .catch(() => set(id, { status: "failed", code: "CACHE_ERROR" }))
    },
    get: (id) => states.get(id),
    subscribe(id, listener) {
      let set = listeners.get(id)
      if (!set) listeners.set(id, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(id)
      }
    },
    start() {
      if (!isMediaAvailable()) return () => {}
      return mediaPort().onPreviewReady(({ items }) => items.forEach(apply))
    },
  }
}

/** Subscribes a component to one entry's thumbnail. */
export function useThumb(store: ThumbStore, id: number): ThumbState | undefined {
  return useSyncExternalStore(
    (l) => store.subscribe(id, l),
    () => store.get(id),
  )
}
