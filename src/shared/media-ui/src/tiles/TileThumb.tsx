import type { ContentItem } from "@panelyth/contracts"
import type { ReactNode } from "react"
import { PlayIcon } from "../icons"
import { useCover, type CoverStore } from "./coverStore"
import { FolderGlyph, UnavailableGlyph, VideoTileGlyph } from "./glyphs"
import { useThumb, type ThumbStore } from "./thumbStore"

// The preview inside a tile's fixed square slot (moved from the viewer's
// Tile.tsx in Stage C10). Both apps draw their tiles with it: the viewer's
// tile view and the commander's Thumbnails view (ADR-0028). What surrounds
// the slot (selection or cursor and marks, the name line, drag and drop)
// belongs to each app.

/** Visual state shared by each fixed tile slot and its fitted preview frame. */
export interface TileVisualState {
  selected: boolean
  focused: boolean
  dragOver: boolean
}

export function tileFrameClass({ selected, focused, dragOver }: TileVisualState): string {
  return [
    // Selected: a thick border with a glow and shadow (@panelyth/ui styles.css).
    selected ? "tile-selected" : dragOver ? "outline-2 -outline-offset-2 outline-accent" : "",
    focused && !selected ? "outline-1 -outline-offset-1 outline-dashed outline-accent/70" : "",
  ].join(" ")
}

function fallbackFrameClass(visual: TileVisualState): string {
  const surface = visual.dragOver ? "bg-accent/20" : "bg-skeleton/60"
  return [
    "relative flex size-full items-center justify-center overflow-hidden rounded-[3px] text-muted",
    surface,
    tileFrameClass(visual),
  ].join(" ")
}

function fittedPreviewSize(
  box: number,
  width: number,
  height: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: box, height: box }
  const scale = Math.min(box / width, box / height)
  return { width: width * scale, height: height * scale }
}

export interface TileThumbProps {
  item: ContentItem
  /** The square slot's edge, CSS px. */
  box: number
  visual: TileVisualState
  thumbs: ThumbStore
  /** Folder covers; without a store a folder shows its symbol. */
  covers?: CoverStore | undefined
  /** Drawn over the frame's corner (the viewer's label, favorite and rating). */
  badge?: ReactNode
  /** What an entry without a preview shows (the commander's type icon for other files). */
  fallback?: ReactNode
}

/** The preview or fallback inside the tile's fixed square slot. */
export function TileThumb(props: TileThumbProps) {
  if (props.item.kind !== "dir") return <MediaThumb {...props} />
  return props.covers ? (
    <FolderThumb {...props} covers={props.covers} />
  ) : (
    <div className={fallbackFrameClass(props.visual)}>
      <FolderGlyph size={Math.round(props.box * 0.36)} />
      {props.badge}
    </div>
  )
}

/** A folder shows one square cover or a mosaic, with its folder glyph until a cover is ready. */
function FolderThumb({
  item,
  box,
  visual,
  covers,
  badge,
}: TileThumbProps & { covers: CoverStore }) {
  const cover = useCover(covers, item.id)
  const glyph = Math.round(box * 0.36)
  if (!cover?.some((c) => typeof c === "object")) {
    return (
      <div className={fallbackFrameClass(visual)}>
        <FolderGlyph size={glyph} />
        {badge}
      </div>
    )
  }
  const single = cover.length === 1
  return (
    <div
      className={`relative grid size-full gap-px overflow-hidden rounded-[3px] ${single ? "" : "grid-cols-2 grid-rows-2"} ${tileFrameClass(visual)}`}
      data-testid="folder-cover"
      data-covers={cover.length}
      data-preview-frame
      data-tooltip-anchor
    >
      {cover.map((c, slot) =>
        typeof c === "object" ? (
          <img
            key={slot}
            src={c.url}
            alt=""
            decoding="async"
            draggable={false}
            className="size-full min-h-0 min-w-0 object-cover"
            onError={() => covers.reportBroken(item.id, slot)}
          />
        ) : (
          <span key={slot} className="bg-skeleton" />
        ),
      )}
      <span
        className="absolute right-1 bottom-1 flex items-center justify-center rounded-sm bg-chrome-solid/85 p-0.5 text-text"
        data-testid="folder-badge"
        aria-hidden="true"
      >
        <FolderGlyph size={Math.max(12, Math.round(box * 0.11))} />
      </span>
      {badge}
    </div>
  )
}

function MediaThumb({ item, box, visual, thumbs, badge, fallback }: TileThumbProps) {
  const state = useThumb(thumbs, item.id)
  const glyph = Math.round(box * 0.36)
  if (item.kind === "video" && state?.status !== "ready") {
    return (
      <div className={fallbackFrameClass(visual)}>
        <VideoTileGlyph size={glyph} />
        {badge}
      </div>
    )
  }
  if (state?.status === "ready") {
    const previewSize = fittedPreviewSize(box, state.thumb.width, state.thumb.height)
    const img = (
      <img
        src={state.thumb.url}
        alt=""
        width={state.thumb.width}
        height={state.thumb.height}
        decoding="async"
        draggable={false}
        className="size-full object-contain"
        onError={() => thumbs.reportBroken(item.id)}
      />
    )
    if (item.kind !== "video") {
      return (
        <div
          className={`relative shrink-0 overflow-hidden rounded-[3px] ${tileFrameClass(visual)}`}
          style={previewSize}
          data-preview-frame
          data-tooltip-anchor
        >
          {img}
          {badge}
        </div>
      )
    }
    // Video posters carry a small play badge so they never read as photos.
    return (
      <div
        className={`relative shrink-0 overflow-hidden rounded-[3px] ${tileFrameClass(visual)}`}
        style={previewSize}
        data-preview-frame
        data-tooltip-anchor
      >
        {img}
        <span
          className="absolute right-1 bottom-1 flex items-center justify-center rounded-sm bg-chrome-solid/85 p-0.5 text-text"
          data-testid="video-badge"
          aria-hidden="true"
        >
          <PlayIcon size={Math.max(10, Math.round(box * 0.09))} />
        </span>
        {badge}
      </div>
    )
  }
  if (state?.status === "failed") {
    return (
      <div className={fallbackFrameClass(visual)}>
        <UnavailableGlyph size={glyph} />
        {badge}
      </div>
    )
  }
  if (item.kind === "image") {
    return (
      <div className={fallbackFrameClass(visual)} data-testid="thumb-loading">
        {badge}
      </div>
    )
  }
  return (
    <div className={fallbackFrameClass(visual)}>
      {fallback}
      {badge}
    </div>
  )
}
