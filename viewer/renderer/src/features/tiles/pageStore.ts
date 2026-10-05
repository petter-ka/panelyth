import type { ContentItem, QuerySnapshot } from "@fastview/contracts"
import {
  createPageStore,
  DEFAULT_MAX_PAGES,
  DEFAULT_PAGE_SIZE,
  usePageItem as useStorePageItem,
} from "@fastview/renderer-core"
import { bridge, FastViewError } from "../../bridge"
import { getThumbProfile, seedThumbs } from "../previews/thumbStore"

/**
 * The viewer's one page store (the shared implementation lives in
 * @fastview/renderer-core). Pages carry the cached thumbnails of the current
 * tile size, which seed the thumbnail store as they arrive.
 */
export const PAGE_SIZE = DEFAULT_PAGE_SIZE
export const MAX_PAGES = DEFAULT_MAX_PAGES

const store = createPageStore({
  fetch: async (queryId, offset, limit) => {
    const profile = getThumbProfile()
    const res = await bridge.queryPage({ queryId, offset, limit, thumbProfile: profile })
    seedThumbs(res.items, profile)
    return res
  },
  isExpired: (error) => error instanceof FastViewError && error.code === "NOT_FOUND",
})

export const setExpiredHandler = (handler: (() => void) | null): void =>
  store.setExpiredHandler(handler)
export const resetPages = (snapshot: QuerySnapshot | null): void => store.reset(snapshot)
export const invalidatePages = (snapshot: QuerySnapshot): void => store.invalidate(snapshot)
export const setRange = (first: number, last: number): void => store.setRange(first, last)
export const ensureIndex = (index: number): Promise<ContentItem | undefined> =>
  store.ensureIndex(index)
export const getTotal = (): number => store.getTotal()
export const getItem = (index: number): ContentItem | undefined => store.getItem(index)
export const loadedItems = (first: number, last: number): ContentItem[] =>
  store.loadedItems(first, last)
export const usePageItem = (index: number): ContentItem | undefined =>
  useStorePageItem(store, index)
export const onPagesLoaded = (listener: () => void): (() => void) => store.onPagesLoaded(listener)
export const pageStats = (): ReturnType<typeof store.stats> => store.stats()
