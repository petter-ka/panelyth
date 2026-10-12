import type {
  ContentItem,
  CoverSlot,
  FolderCoverItem,
  PreviewPriority,
  PreviewProfile,
  Thumb,
} from "@panelyth/contracts"
import { MAX_COVER_DIRS } from "@panelyth/contracts"
import { useSyncExternalStore } from "react"
import { isMediaAvailable, mediaPort } from "../port"

/**
 * Folder covers per folder entry id (Stage 08.6, ADR-0024): up to four media
 * previews found by a shallow, bounded read of the folder in Go. Kept outside
 * React state like thumbnails: one subscriber set per folder id, URLs only.
 *
 * Moved from the viewer in Stage C10. An app whose profile has no
 * folder.covers (the commander) creates no cover store, and its folder tiles
 * show the folder symbol.
 */
export type CoverCell = Thumb | "pending" | "failed"

/** Slots in display order; an empty array means "no media, show the folder". */
export type CoverState = readonly CoverCell[]

export interface CoverRequest {
  item: ContentItem
  priority: PreviewPriority
}

export interface CoverStore {
  /** Forget everything (folder change, profile change). */
  reset(): void
  /**
   * Requests covers for the folder tiles of a settled range in one call. Known
   * folders are skipped, so scrolling back costs nothing. Every call is a new
   * epoch: the sidecar drops queued cover work for folders that scrolled away.
   */
  request(wanted: readonly CoverRequest[], tileProfile: PreviewProfile): Promise<void>
  /** The cached cover file failed to load: show that cell as failed. */
  reportBroken(dirId: number, slot: number): void
  get(id: number): CoverState | undefined
  subscribe(id: number, listener: () => void): () => void
  /** Applies batched folder.covers events; returns the stop function. */
  start(): () => void
}

const MAX_ENTRIES = 5_000

function cell(slot: CoverSlot): CoverCell {
  if ("pending" in slot) return "pending"
  if ("failed" in slot) return "failed"
  return { url: slot.url, width: slot.width, height: slot.height }
}

export function createCoverStore(lane: string): CoverStore {
  let profile: PreviewProfile | null = null
  let epoch = 0
  const states = new Map<number, CoverState>()
  const listeners = new Map<number, Set<() => void>>()

  function set(id: number, state: CoverState): void {
    states.set(id, state)
    listeners.get(id)?.forEach((l) => l())
  }

  function apply(item: FolderCoverItem): void {
    if (item.profile !== profile) return
    const current = states.get(item.dirId)
    if (!current) return
    // An event can beat the folder.covers answer; the answer keeps this cell.
    const next: CoverCell[] = current.slice()
    while (next.length <= item.slot) next.push("pending")
    next[item.slot] =
      "failed" in item ? "failed" : { url: item.url, width: item.width, height: item.height }
    set(item.dirId, next)
  }

  function reset(): void {
    states.clear()
    listeners.forEach((s) => s.forEach((l) => l()))
  }

  return {
    reset,
    async request(wanted, tileProfile) {
      const fetch = mediaPort().folderCovers
      if (!fetch) return
      if (tileProfile !== profile) {
        profile = tileProfile
        reset()
      }
      if (states.size > MAX_ENTRIES) reset()
      const items: { id: number; priority: PreviewPriority }[] = []
      for (const { item, priority } of wanted) {
        if (item.kind !== "dir" || states.has(item.id)) continue
        // Placeholder until the answer: requested once, shown as the folder symbol.
        states.set(item.id, [])
        items.push({ id: item.id, priority })
        if (items.length === MAX_COVER_DIRS) break
      }
      if (items.length === 0) return
      const requested = profile
      try {
        const res = await fetch({ lane, epoch: ++epoch, profile: requested, items })
        if (requested !== profile) return
        for (const fc of res.items) {
          // An event may have finished a slot before this answer arrived.
          const known = states.get(fc.dirId)
          set(
            fc.dirId,
            fc.slots.map((s, i) => {
              const c = cell(s)
              return c === "pending" && known?.[i] && known[i] !== "pending" ? known[i] : c
            }),
          )
        }
      } catch {
        // Retry on the next settled range.
        for (const { id } of items) states.delete(id)
      }
    },
    reportBroken(dirId, slot) {
      const current = states.get(dirId)
      if (!current || slot >= current.length) return
      const next = current.slice()
      next[slot] = "failed"
      set(dirId, next)
    },
    get: (id) => states.get(id),
    subscribe(id, listener) {
      let s = listeners.get(id)
      if (!s) listeners.set(id, (s = new Set()))
      s.add(listener)
      return () => {
        s.delete(listener)
        if (s.size === 0) listeners.delete(id)
      }
    },
    start() {
      const on = mediaPort().onFolderCovers
      if (!isMediaAvailable() || !on) return () => {}
      return on(({ items }) => items.forEach(apply))
    },
  }
}

/** Subscribes a folder tile to its covers. */
export function useCover(store: CoverStore, id: number): CoverState | undefined {
  return useSyncExternalStore(
    (l) => store.subscribe(id, l),
    () => store.get(id),
  )
}
