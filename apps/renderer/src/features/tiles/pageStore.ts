import type { ContentItem, QuerySnapshot } from "@fastview/contracts"
import { useSyncExternalStore } from "react"
import { bridge, FastViewError } from "../../bridge"
import { getThumbProfile, seedThumbs } from "../previews/thumbStore"

/**
 * Pages of the open query session, outside React state (CLAUDE.md,
 * ADR-0017). The tile view asks for the range it shows; the store fetches
 * the covering pages (± one), keeps a bounded LRU and refetches only pages
 * in view when the session is invalidated. Tiles subscribe to their page.
 */
export const PAGE_SIZE = 256
export const MAX_PAGES = 24
const MAX_IN_FLIGHT = 3

interface Page {
  version: number
  items: ContentItem[]
}

let queryId = 0
let version = 0
let total = 0
const pages = new Map<number, Page>() // insertion order = LRU order
const inFlight = new Set<number>()
let wanted: number[] = [] // pages the current range needs, most important first
const pageListeners = new Map<number, Set<() => void>>()
const loadListeners = new Set<() => void>()
let onExpired: (() => void) | null = null
let fetchCount = 0

/** Called when the sidecar no longer knows the session (evicted, restarted). */
export function setExpiredHandler(handler: (() => void) | null): void {
  onExpired = handler
}

/** Starts over with a new session (folder opened, sort changed, reopened). */
export function resetPages(snapshot: QuerySnapshot | null): void {
  queryId = snapshot?.queryId ?? 0
  version = snapshot?.version ?? 0
  total = snapshot?.total ?? 0
  pages.clear()
  inFlight.clear()
  wanted = []
  pageListeners.forEach((set) => set.forEach((l) => l()))
}

/** The session was re-materialized: refetch the pages currently in view. */
export function invalidatePages(snapshot: QuerySnapshot): void {
  if (snapshot.queryId !== queryId || snapshot.version <= version) return
  version = snapshot.version
  total = snapshot.total
  // Pages outside the view are dropped; stale pages in view keep showing
  // until their replacement arrives.
  for (const p of [...pages.keys()]) if (!wanted.includes(p)) pages.delete(p)
  pump()
}

/**
 * Declares the item range the view shows. Pages covering it (plus one page
 * on each side) are loaded; requests for pages no longer needed are not
 * started.
 */
export function setRange(first: number, last: number): void {
  if (queryId === 0 || total === 0 || last < first) {
    wanted = []
    return
  }
  const a = Math.floor(Math.max(0, first) / PAGE_SIZE)
  const b = Math.floor(Math.min(total - 1, last) / PAGE_SIZE)
  const next: number[] = []
  for (let p = a; p <= b; p++) next.push(p) // visible pages first
  if (a > 0) next.push(a - 1)
  if ((b + 1) * PAGE_SIZE < total) next.push(b + 1)
  wanted = next
  pump()
}

function pump(): void {
  for (const p of wanted) {
    if (inFlight.size >= MAX_IN_FLIGHT) return
    const page = pages.get(p)
    if (inFlight.has(p) || (page && page.version >= version)) continue
    void fetchPage(p)
  }
}

async function fetchPage(p: number): Promise<void> {
  const forQuery = queryId
  const profile = getThumbProfile()
  inFlight.add(p)
  fetchCount++
  try {
    const res = await bridge.queryPage({
      queryId: forQuery,
      offset: p * PAGE_SIZE,
      limit: PAGE_SIZE,
      thumbProfile: profile,
    })
    if (res.queryId !== queryId) return
    if (res.version > version) {
      version = res.version
      total = res.total
    }
    seedThumbs(res.items, profile)
    pages.delete(p)
    pages.set(p, { version: res.version, items: res.items })
    evict()
    pageListeners.get(p)?.forEach((l) => l())
    loadListeners.forEach((l) => l())
  } catch (error) {
    if (error instanceof FastViewError && error.code === "NOT_FOUND" && forQuery === queryId) {
      onExpired?.()
    }
  } finally {
    if (forQuery === queryId) inFlight.delete(p)
    pump()
  }
}

function evict(): void {
  for (const p of pages.keys()) {
    if (pages.size <= MAX_PAGES) return
    if (!wanted.includes(p)) pages.delete(p)
  }
}

/**
 * Returns the item at index, fetching its page if needed (viewer navigation
 * steps beyond the pages the tile view keeps).
 */
export async function ensureIndex(index: number): Promise<ContentItem | undefined> {
  if (index < 0 || index >= total) return undefined
  const cached = getItem(index)
  if (cached) return cached
  const p = Math.floor(index / PAGE_SIZE)
  if (!inFlight.has(p)) await fetchPage(p)
  else {
    // Another request is loading this page: wait for it.
    await new Promise<void>((resolve) => {
      const off = onPagesLoaded(() => {
        if (pages.has(p)) {
          off()
          resolve()
        }
      })
      setTimeout(() => {
        off()
        resolve()
      }, 5000)
    })
  }
  return getItem(index)
}

export function getTotal(): number {
  return total
}

export function getItem(index: number): ContentItem | undefined {
  const page = pages.get(Math.floor(index / PAGE_SIZE))
  return page?.items[index % PAGE_SIZE]
}

/** Loaded items in [first, last] (skips holes). */
export function loadedItems(first: number, last: number): ContentItem[] {
  const out: ContentItem[] = []
  for (let i = Math.max(0, first); i <= last; i++) {
    const item = getItem(i)
    if (item) out.push(item)
  }
  return out
}

function subscribePage(p: number, listener: () => void): () => void {
  let set = pageListeners.get(p)
  if (!set) pageListeners.set(p, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) pageListeners.delete(p)
  }
}

/** Subscribes a tile to the page holding its index. */
export function usePageItem(index: number): ContentItem | undefined {
  const p = Math.floor(index / PAGE_SIZE)
  return useSyncExternalStore(
    (l) => subscribePage(p, l),
    () => getItem(index),
  )
}

/** Notifies after any page loads (the view re-requests thumbnails then). */
export function onPagesLoaded(listener: () => void): () => void {
  loadListeners.add(listener)
  return () => loadListeners.delete(listener)
}

/** Diagnostics for tests and e2e measurements. */
export function pageStats(): {
  cached: number
  inFlight: number
  fetches: number
  version: number
} {
  return { cached: pages.size, inFlight: inFlight.size, fetches: fetchCount, version }
}
