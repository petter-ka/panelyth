import type { ErrorCode, MediaOpenResult, PreviewPriority, Thumb } from "@panelyth/contracts"
import { useSyncExternalStore } from "react"
import { errorCode, isMediaAvailable, mediaPort } from "./port"

/**
 * Image layers for the viewer, per entry id (outside React state):
 * - fit: the Go-generated viewer-fit preview (≤ 2560 px long edge, cached),
 * - media: display size and, for browser-native formats, the original's
 *   panelyth-media URL.
 * Layers are decoded ahead of display (img.decode(), off the main thread)
 * so swapping never shows a half-decoded or blank frame.
 */
export type FitState =
  | { status: "pending" }
  | { status: "ready"; thumb: Thumb; decoded: boolean }
  | { status: "failed"; code: ErrorCode }

export type MediaState =
  | { status: "pending" }
  | { status: "ready"; media: MediaOpenResult; originalDecoded: boolean }
  | { status: "failed"; code: ErrorCode }

export interface ViewerImage {
  fit: FitState | undefined
  media: MediaState | undefined
}

/**
 * A preview lane: the viewer's focused viewer ("viewer") and preview pane
 * ("pane") queue independently (Stage 06); the commander uses lanes of its
 * own, so the two apps never drop each other's queued work.
 */
export type FitLane = string
const PROFILE = "viewer-fit"
const MAX_ENTRIES = 24

const images = new Map<number, ViewerImage>()
const listeners = new Map<number, Set<() => void>>()
const epochs = new Map<FitLane, number>()

function update(id: number, patch: Partial<ViewerImage>): void {
  const current = images.get(id) ?? { fit: undefined, media: undefined }
  images.delete(id) // LRU order
  images.set(id, { ...current, ...patch })
  while (images.size > MAX_ENTRIES) images.delete(images.keys().next().value!)
  listeners.get(id)?.forEach((l) => l())
}

/** Decodes url off the main thread; resolves true when ready to paint. */
export async function predecode(url: string): Promise<boolean> {
  const img = new Image()
  img.decoding = "async"
  img.src = url
  try {
    await img.decode()
    return true
  } catch {
    return false
  }
}

async function onFitReady(id: number, thumb: Thumb): Promise<void> {
  update(id, { fit: { status: "ready", thumb, decoded: false } })
  const ok = await predecode(thumb.url)
  const cur = images.get(id)?.fit
  if (cur?.status === "ready" && cur.thumb.url === thumb.url) {
    update(id, { fit: ok ? { ...cur, decoded: true } : { status: "failed", code: "CACHE_ERROR" } })
  }
}

/**
 * Requests viewer-fit previews (video posters too): the current item first,
 * neighbours after. A new epoch drops that lane's queued work for items the
 * user already moved past.
 */
export async function requestFit(
  wanted: readonly { id: number; priority: PreviewPriority }[],
  force: readonly number[] = [],
  lane: FitLane = "viewer",
): Promise<void> {
  const items = wanted.filter(({ id }) => {
    const s = images.get(id)?.fit
    return force.includes(id) || !s || s.status === "pending"
  })
  for (const { id } of items)
    if (!images.get(id)?.fit || force.includes(id)) update(id, { fit: { status: "pending" } })
  if (items.length === 0) return
  const epoch = (epochs.get(lane) ?? 0) + 1
  epochs.set(lane, epoch)
  const res = await mediaPort().ensurePreviews({
    lane,
    epoch,
    profile: PROFILE,
    items: items.map(({ id, priority }) => ({ id, priority })),
    force: [...force],
  })
  for (const it of res.items) {
    if ("failed" in it) update(it.id, { fit: { status: "failed", code: it.failed } })
    else void onFitReady(it.id, { url: it.url, width: it.width, height: it.height })
  }
}

/**
 * Failures of the app itself, not properties of the file (a drive still
 * waking up, the sidecar starting or busy): asking again can succeed.
 */
export const TRANSIENT_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "TIMEOUT",
  "BUSY",
  "SIDECAR_UNAVAILABLE",
  "CANCELLED",
  "DB_ERROR",
  "CACHE_ERROR",
])

/** The pauses before asking again after a transient failure; the loading state stays meanwhile. */
export const MEDIA_RETRY_MS = [1000, 3000]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolves display size and the original URL (once per id while it works).
 * A failure is never final for the next look at the file, and the app's own
 * trouble is retried before it is shown.
 */
export async function requestMedia(id: number): Promise<void> {
  const current = images.get(id)?.media
  if (current && current.status !== "failed") return
  const pending: MediaState = { status: "pending" }
  update(id, { media: pending })
  for (let attempt = 0; ; attempt++) {
    try {
      const media = await mediaPort().openMedia(id)
      if (images.get(id)?.media === pending)
        update(id, { media: { status: "ready", media, originalDecoded: false } })
      return
    } catch (error) {
      const code = errorCode(error)
      if (!TRANSIENT_CODES.has(code) || attempt >= MEDIA_RETRY_MS.length) {
        if (images.get(id)?.media === pending)
          update(id, { media: { status: "failed", code: code as ErrorCode } })
        return
      }
      await sleep(MEDIA_RETRY_MS[attempt]!)
      // Evicted or asked again meanwhile (Try again): that request carries on.
      if (images.get(id)?.media !== pending) return
    }
  }
}

/** Loads the original (only when zoomed beyond the preview's resolution). */
export async function requestOriginal(id: number): Promise<void> {
  const m = images.get(id)?.media
  if (m?.status !== "ready" || !m.media.url || m.originalDecoded) return
  const ok = await predecode(m.media.url)
  const cur = images.get(id)?.media
  if (ok && cur?.status === "ready") update(id, { media: { ...cur, originalDecoded: true } })
}

/** Try again after a failure: regenerate the preview and re-resolve. */
export function retry(id: number, lane: FitLane = "viewer"): void {
  update(id, { fit: undefined, media: undefined })
  void requestMedia(id)
  void requestFit([{ id, priority: 0 }], [id], lane).catch(() => undefined)
}

export function getViewerImage(id: number): ViewerImage | undefined {
  return images.get(id)
}

export function resetViewerImages(): void {
  images.clear()
  listeners.forEach((set) => set.forEach((l) => l()))
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

const EMPTY: ViewerImage = { fit: undefined, media: undefined }

export function useViewerImage(id: number | null): ViewerImage {
  return useSyncExternalStore(
    (l) => (id === null ? () => {} : subscribe(id, l)),
    () => (id === null ? EMPTY : (images.get(id) ?? EMPTY)),
  )
}

/** Applies viewer-fit results from batched preview.ready events. */
export function startViewerImageMonitoring(): () => void {
  if (!isMediaAvailable()) return () => {}
  return mediaPort().onPreviewReady(({ items }) => {
    for (const it of items) {
      if (it.profile !== PROFILE) continue
      if ("failed" in it) update(it.id, { fit: { status: "failed", code: it.failed } })
      else void onFitReady(it.id, { url: it.url, width: it.width, height: it.height })
    }
  })
}
