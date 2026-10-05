import type { ContentItem, QuerySnapshot } from "@fastview/contracts"
import { useSyncExternalStore } from "react"

/**
 * Pages of one query session, outside React state (CLAUDE.md, ADR-0017). A
 * view asks for the range it shows; the store fetches the covering pages
 * (± one), keeps a bounded LRU and refetches only pages in view when the
 * session is invalidated. Rows or tiles subscribe to their page.
 *
 * One store per view: the viewer has one, each commander panel has its own
 * (ADR-0028, ADR-0031).
 */
export const DEFAULT_PAGE_SIZE = 256
export const DEFAULT_MAX_PAGES = 24
export const DEFAULT_MAX_IN_FLIGHT = 3

export interface PageResult {
  queryId: number
  version: number
  total: number
  items: ContentItem[]
}

/** Loads one page; rejects with an error isExpired recognizes when the session is gone. */
export type PageFetch = (queryId: number, offset: number, limit: number) => Promise<PageResult>

export interface PageStoreOptions {
  fetch: PageFetch
  /** True when an error means the sidecar no longer knows the session. */
  isExpired: (error: unknown) => boolean
  pageSize?: number
  maxPages?: number
  maxInFlight?: number
}

export interface PageStoreStats {
  cached: number
  inFlight: number
  fetches: number
  version: number
}

export interface PageStore {
  readonly pageSize: number
  readonly maxPages: number
  /** Called when the sidecar no longer knows the session (evicted, restarted). */
  setExpiredHandler(handler: (() => void) | null): void
  /** Starts over with a new session (folder opened, sort changed, reopened). */
  reset(snapshot: QuerySnapshot | null): void
  /** The session was re-materialized: refetch the pages currently in view. */
  invalidate(snapshot: QuerySnapshot): void
  /** Declares the item range the view shows. */
  setRange(first: number, last: number): void
  /** Returns the item at index, fetching its page if needed. */
  ensureIndex(index: number): Promise<ContentItem | undefined>
  getQueryId(): number
  getTotal(): number
  getItem(index: number): ContentItem | undefined
  /** Loaded items in [first, last] (skips holes). */
  loadedItems(first: number, last: number): ContentItem[]
  subscribePage(page: number, listener: () => void): () => void
  /** Notifies after any page loads. */
  onPagesLoaded(listener: () => void): () => void
  /** Diagnostics for tests and e2e measurements. */
  stats(): PageStoreStats
}

interface Page {
  version: number
  items: ContentItem[]
}

export function createPageStore(options: PageStoreOptions): PageStore {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES
  const maxInFlight = options.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT

  let queryId = 0
  let version = 0
  let total = 0
  const pages = new Map<number, Page>() // insertion order = LRU order
  const inFlight = new Set<number>()
  // Pages whose last fetch failed: not retried until the session changes or
  // the view asks again, so an error never turns into a request loop.
  const failed = new Set<number>()
  let wanted: number[] = [] // pages the current range needs, most important first
  const pageListeners = new Map<number, Set<() => void>>()
  const loadListeners = new Set<() => void>()
  let onExpired: (() => void) | null = null
  let fetchCount = 0

  function pump(): void {
    for (const p of wanted) {
      if (inFlight.size >= maxInFlight) return
      const page = pages.get(p)
      if (inFlight.has(p) || failed.has(p) || (page && page.version >= version)) continue
      void fetchPage(p)
    }
  }

  async function fetchPage(p: number): Promise<void> {
    const forQuery = queryId
    inFlight.add(p)
    fetchCount++
    try {
      const res = await options.fetch(forQuery, p * pageSize, pageSize)
      if (res.queryId !== queryId) return
      if (res.version > version) {
        version = res.version
        total = res.total
      }
      pages.delete(p)
      pages.set(p, { version: res.version, items: res.items })
      evict()
      pageListeners.get(p)?.forEach((l) => l())
      loadListeners.forEach((l) => l())
    } catch (error) {
      if (forQuery === queryId) {
        failed.add(p)
        if (options.isExpired(error)) onExpired?.()
      }
    } finally {
      if (forQuery === queryId) inFlight.delete(p)
      pump()
    }
  }

  function evict(): void {
    for (const p of pages.keys()) {
      if (pages.size <= maxPages) return
      if (!wanted.includes(p)) pages.delete(p)
    }
  }

  function getItem(index: number): ContentItem | undefined {
    return pages.get(Math.floor(index / pageSize))?.items[index % pageSize]
  }

  function onPagesLoaded(listener: () => void): () => void {
    loadListeners.add(listener)
    return () => loadListeners.delete(listener)
  }

  return {
    pageSize,
    maxPages,
    setExpiredHandler(handler) {
      onExpired = handler
    },
    reset(snapshot) {
      queryId = snapshot?.queryId ?? 0
      version = snapshot?.version ?? 0
      total = snapshot?.total ?? 0
      pages.clear()
      inFlight.clear()
      failed.clear()
      wanted = []
      pageListeners.forEach((set) => set.forEach((l) => l()))
    },
    invalidate(snapshot) {
      if (snapshot.queryId !== queryId || snapshot.version <= version) return
      version = snapshot.version
      total = snapshot.total
      failed.clear()
      // Pages outside the view are dropped; stale pages in view keep showing
      // until their replacement arrives.
      for (const p of [...pages.keys()]) if (!wanted.includes(p)) pages.delete(p)
      pump()
    },
    setRange(first, last) {
      if (queryId === 0 || total === 0 || last < first) {
        wanted = []
        return
      }
      const a = Math.floor(Math.max(0, first) / pageSize)
      const b = Math.floor(Math.min(total - 1, last) / pageSize)
      const next: number[] = []
      for (let p = a; p <= b; p++) next.push(p) // visible pages first
      if (a > 0) next.push(a - 1)
      if ((b + 1) * pageSize < total) next.push(b + 1)
      wanted = next
      failed.clear()
      pump()
    },
    async ensureIndex(index) {
      if (index < 0 || index >= total) return undefined
      const cached = getItem(index)
      if (cached) return cached
      const p = Math.floor(index / pageSize)
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
    },
    getQueryId: () => queryId,
    getTotal: () => total,
    getItem,
    loadedItems(first, last) {
      const out: ContentItem[] = []
      for (let i = Math.max(0, first); i <= last; i++) {
        const item = getItem(i)
        if (item) out.push(item)
      }
      return out
    },
    subscribePage(p, listener) {
      let set = pageListeners.get(p)
      if (!set) pageListeners.set(p, (set = new Set()))
      set.add(listener)
      return () => {
        set.delete(listener)
        if (set.size === 0) pageListeners.delete(p)
      }
    },
    onPagesLoaded,
    stats: () => ({ cached: pages.size, inFlight: inFlight.size, fetches: fetchCount, version }),
  }
}

/** Subscribes a row or tile to the page holding its index. */
export function usePageItem(store: PageStore, index: number): ContentItem | undefined {
  const p = Math.floor(index / store.pageSize)
  return useSyncExternalStore(
    (l) => store.subscribePage(p, l),
    () => store.getItem(index),
  )
}
