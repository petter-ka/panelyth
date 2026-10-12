import {
  createCoverStore,
  useCover as useStoreCover,
  type CoverCell,
  type CoverRequest,
  type CoverState,
} from "../media/mediaUi"

/**
 * The viewer's folder covers (Stage 08.6, ADR-0024), on the "covers" lane. The
 * store itself lives in @panelyth/media-ui since Stage C10.
 */
export const tileCovers = createCoverStore("covers")

export type { CoverCell, CoverRequest, CoverState }

export const resetCovers = tileCovers.reset
export const requestCovers = tileCovers.request
export const reportBrokenCover = tileCovers.reportBroken
export const startCoverMonitoring = tileCovers.start

/** Subscribes a folder tile to its covers. */
export const useCover = (id: number): CoverState | undefined => useStoreCover(tileCovers, id)
