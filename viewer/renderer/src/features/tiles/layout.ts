import type { PreviewProfile } from "@fastview/contracts"

// Tile view geometry (docs/viewer/stages/03-tile-view.md, ADR-0004). Thumbnail boxes keep
// their selected size; interface size scales the surrounding labels and gaps.

export type TileSize = "small" | "medium" | "large"
export const TILE_SIZE_ORDER: readonly TileSize[] = ["small", "medium", "large"]

export interface TileMetrics {
  /** Square thumbnail box and tile width, CSS px. */
  tile: number
  /** Space between tiles, horizontally and vertically. */
  gap: number
  /** Height of the name line under the thumbnail box. */
  nameLine: number
}

export const TILE_METRICS: Record<TileSize, TileMetrics> = {
  small: { tile: 120, gap: 8, nameLine: 22 },
  medium: { tile: 180, gap: 12, nameLine: 24 },
  large: { tile: 260, gap: 16, nameLine: 24 },
}

/** Horizontal padding of the content area on each side. */
export const CONTENT_PADDING = 16

/** Tiles per row: as many fixed-size tiles as fit; spare width stays at the right. */
export function tilesPerRow(width: number, size: TileSize, interfaceScale = 1): number {
  const gap = TILE_METRICS[size].gap * interfaceScale
  const padding = CONTENT_PADDING * interfaceScale
  const tile = TILE_METRICS[size].tile
  return Math.max(1, Math.floor((width - 2 * padding + gap) / (tile + gap)))
}

/** Row height stays fixed for the selected tile and interface sizes. */
export function rowHeight(size: TileSize, interfaceScale = 1): number {
  const { tile, gap, nameLine } = TILE_METRICS[size]
  return tile + nameLine * interfaceScale + gap * interfaceScale
}

export function rowCount(total: number, perRow: number): number {
  return Math.ceil(total / Math.max(1, perRow))
}

const PROFILE_EDGE: readonly [PreviewProfile, number][] = [
  ["grid-sm", 192],
  ["grid-md", 384],
  ["grid-lg", 768],
]

/** Smallest preview profile whose long edge covers the thumbnail box at this density. */
export function profileFor(size: TileSize, devicePixelRatio: number): PreviewProfile {
  const needed = TILE_METRICS[size].tile * Math.max(1, devicePixelRatio)
  for (const [profile, edge] of PROFILE_EDGE) if (edge >= needed) return profile
  return "grid-lg"
}
