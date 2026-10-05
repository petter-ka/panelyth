import type {
  ContentItem,
  ErrorCode,
  PreviewItem,
  PreviewPriority,
  PreviewProfile,
  Thumb,
} from "@fastview/contracts"
import { MAX_ENSURE_ITEMS } from "@fastview/contracts"
import { useSyncExternalStore } from "react"
import { bridge, isBridgeAvailable } from "../../bridge"

/**
 * Thumbnail state per entry id, kept outside React state (CLAUDE.md): one
 * subscriber set per id, so a finished preview re-renders exactly one tile.
 * Only URLs are stored, never image bytes; Chromium loads and caches the
 * files through fastview-thumb:.
 */
export type ThumbState =
  { status: "ready"; thumb: Thumb } | { status: "failed"; code: ErrorCode } | { status: "pending" }

const LANE = "tiles"
const MAX_ENTRIES = 20_000

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

function notifyAll(): void {
  listeners.forEach((set) => set.forEach((l) => l()))
}

/** Forget everything (folder change, profile change). */
export function resetThumbs(): void {
  states.clear()
  retried.clear()
  identity.clear()
  notifyAll()
}

export function getThumbProfile(): PreviewProfile {
  return profile
}

/**
 * The profile follows tile size × device pixel ratio. Changing it drops all
 * states: thumbnails of another size are different cache entries.
 */
export function setThumbProfile(next: PreviewProfile): void {
  if (next === profile) return
  profile = next
  epoch++
  resetThumbs()
}

/** Records identities and thumbnails that arrived attached to a page. */
export function seedThumbs(items: readonly ContentItem[], pageProfile: PreviewProfile): void {
  if (states.size > MAX_ENTRIES) resetThumbs()
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
}

export interface ThumbRequest {
  item: ContentItem
  priority: PreviewPriority
}

/**
 * Requests previews for the settled visible range in one call. Every call is
 * a new epoch: the sidecar drops queued work for tiles that scrolled away
 * and were not requested again (Stage 02 lanes).
 */
export async function requestVisible(wanted: readonly ThumbRequest[]): Promise<void> {
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
  const res = await bridge.ensurePreviews({
    lane: LANE,
    epoch: ++epoch,
    profile,
    items,
    force: [],
  })
  res.items.forEach(apply)
}

/**
 * The cached file failed to load (deleted by cleanup or corrupt): regenerate
 * it once. A second failure is shown as failed.
 */
export function reportBroken(id: number): void {
  if (retried.has(id)) {
    set(id, { status: "failed", code: "CACHE_ERROR" })
    return
  }
  retried.add(id)
  set(id, { status: "pending" })
  void bridge
    .ensurePreviews({ lane: LANE, epoch, profile, items: [{ id, priority: 0 }], force: [id] })
    .then((res) => res.items.forEach(apply))
    .catch(() => set(id, { status: "failed", code: "CACHE_ERROR" }))
}

export function getThumb(id: number): ThumbState | undefined {
  return states.get(id)
}

function subscribe(id: number, listener: () => void): () => void {
  let set = listeners.get(id)
  if (!set) listeners.set(id, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(id)
  }
}

/** Subscribes a component to one entry's thumbnail. */
export function useThumb(id: number): ThumbState | undefined {
  return useSyncExternalStore(
    (l) => subscribe(id, l),
    () => states.get(id),
  )
}

/** Applies batched preview.ready events. */
export function startThumbMonitoring(): () => void {
  if (!isBridgeAvailable()) return () => {}
  return bridge.on("preview.ready", ({ items }) => items.forEach(apply))
}
