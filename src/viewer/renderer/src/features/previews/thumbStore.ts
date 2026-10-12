import {
  createThumbStore,
  useThumb as useStoreThumb,
  type ThumbRequest,
  type ThumbState,
} from "../media/mediaUi"

/**
 * The viewer's one thumbnail store, on the "tiles" preview lane. The store
 * itself lives in @panelyth/media-ui since Stage C10 (the commander's
 * Thumbnails view has one per panel).
 */
export const tileThumbs = createThumbStore("tiles")

export type { ThumbRequest, ThumbState }

export const resetThumbs = tileThumbs.reset
export const getThumbProfile = tileThumbs.getProfile
export const setThumbProfile = tileThumbs.setProfile
export const seedThumbs = tileThumbs.seed
export const requestVisible = tileThumbs.requestVisible
export const reportBroken = tileThumbs.reportBroken
export const getThumb = tileThumbs.get
export const startThumbMonitoring = tileThumbs.start

/** Subscribes a component to one entry's thumbnail. */
export const useThumb = (id: number): ThumbState | undefined => useStoreThumb(tileThumbs, id)
