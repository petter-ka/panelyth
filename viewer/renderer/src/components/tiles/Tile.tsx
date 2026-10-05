import type { ContentItem } from "@fastview/contracts"
import { memo, useState } from "react"
import { bridge } from "../../bridge"
import { openFolderEntry } from "../../features/folder/folderStore"
import { labelColor, labelName } from "../../features/labels/labels"
import { reportBroken, useThumb } from "../../features/previews/thumbStore"
import { reportBrokenCover, useCover } from "../../features/previews/coverStore"
import { TILE_METRICS, type TileSize } from "../../features/tiles/layout"
import { usePageItem } from "../../features/tiles/pageStore"
import {
  askDropTransfer,
  beginSelectionDrag,
  canAcceptSelectionDrop,
  SELECTION_DRAG_TYPE,
} from "../../features/jobs/jobsStore"
import {
  focusAndSelect,
  focusAndPreserveSelection,
  isSelected,
  selectRangeTo,
  toggleSelected,
  useSelectionStore,
  type SelectionState,
} from "../../features/tiles/selectionStore"
import { openViewerAt } from "../../features/viewer/viewerStore"
import { playInPane } from "../../features/preview/previewStore"
import { HeartIcon, PlayIcon } from "../ui/icons"
import { formatBytes, formatDate } from "../../lib/format"
import { FolderGlyph, UnavailableGlyph, VideoGlyph } from "./glyphs"

const KIND_LABEL = { dir: "Folder", image: "Image", video: "Video", file: "File", link: "Link" } as const

function tooltip(item: ContentItem): string {
  if (item.kind === "dir") return `${item.name}\nFolder`
  return `${item.name}\n${KIND_LABEL[item.kind]} (${item.ext}), ${formatBytes(item.sizeBytes)}\nModified ${formatDate(item.modifiedMs)}`
}

/**
 * A folder shows up to four of its media files (Stage 08.6): one fills the
 * box, more form a 2×2 mosaic. The folder symbol stays until the first cover
 * is ready, and a small folder badge keeps the tile readable as a folder.
 */
function FolderThumb({ id, box }: { id: number; box: number }) {
  const cover = useCover(id)
  const glyph = Math.round(box * 0.36)
  if (!cover?.some((c) => typeof c === "object")) return <FolderGlyph size={glyph} />
  const single = cover.length === 1
  return (
    <div
      className={`relative grid size-full gap-px ${single ? "" : "grid-cols-2 grid-rows-2"}`}
      data-testid="folder-cover"
      data-covers={cover.length}
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
            onError={() => reportBrokenCover(id, slot)}
          />
        ) : (
          <span key={slot} className="bg-skeleton" />
        ),
      )}
      <span
        className="absolute right-1 bottom-1 flex items-center justify-center rounded-sm bg-chrome/85 p-0.5 text-text"
        data-testid="folder-badge"
        aria-hidden="true"
      >
        <FolderGlyph size={Math.max(12, Math.round(box * 0.11))} />
      </span>
    </div>
  )
}

/** Set on mousedown on an already selected tile; cleared by the next click. */
let pendingCollapse: {
  index: number
  ranges: SelectionState["ranges"]
  include: SelectionState["include"]
  exclude: SelectionState["exclude"]
} | null = null

/** The picture inside the square box: thumbnail, symbol, or nothing while loading. */
function TileThumb({ item, box }: { item: ContentItem; box: number }) {
  if (item.kind === "dir") return <FolderThumb id={item.id} box={box} />
  return <MediaThumb item={item} box={box} />
}

function MediaThumb({ item, box }: { item: ContentItem; box: number }) {
  const state = useThumb(item.id)
  const glyph = Math.round(box * 0.36)
  if (item.kind === "video" && state?.status !== "ready") return <VideoGlyph size={glyph} />
  if (state?.status === "ready") {
    const img = (
      <img
        src={state.thumb.url}
        alt=""
        width={box}
        height={box}
        decoding="async"
        draggable={false}
        className="size-full object-contain"
        onError={() => reportBroken(item.id)}
      />
    )
    if (item.kind !== "video") return img
    // Video posters carry a small play badge so they never read as photos.
    return (
      <div className="relative size-full">
        {img}
        <span
          className="absolute right-1 bottom-1 flex items-center justify-center rounded-sm bg-chrome/85 p-0.5 text-text"
          data-testid="video-badge"
          aria-hidden="true"
        >
          <PlayIcon size={Math.max(10, Math.round(box * 0.09))} />
        </span>
      </div>
    )
  }
  if (state?.status === "failed") return <UnavailableGlyph size={glyph} />
  return null
}

/** Label, favorite and rating, drawn inside the box so tile geometry never changes. */
function UserBadge({ item }: { item: ContentItem }) {
  if (!item.favorite && item.rating === 0 && item.label === 0) return null
  const color = labelColor(item.label)
  const label = [
    color && `${labelName(item.label)} label`,
    item.favorite && "Favorite",
    item.rating > 0 && `${item.rating} stars`,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <span
      role="img"
      aria-label={label}
      className="absolute top-1 left-1 flex items-center gap-0.5 rounded-sm bg-chrome/85 px-1 text-[0.625rem] leading-4 text-text"
      data-testid="user-badge"
    >
      {color && (
        <span
          aria-hidden="true"
          className="size-2 rounded-full"
          style={{ background: color }}
          data-testid="label-dot"
        />
      )}
      {item.favorite && <HeartIcon size={10} fill="currentColor" />}
      {item.rating > 0 && <span aria-hidden="true">★{item.rating}</span>}
    </span>
  )
}

interface TileProps {
  index: number
  size: TileSize
}

/**
 * One tile: a fixed square box plus one name line. Geometry never depends on
 * the image, so nothing reflows when thumbnails arrive. Subscribes only to
 * its own page item, thumbnail and selection flags.
 */
export const Tile = memo(function Tile({ index, size }: TileProps) {
  const item = usePageItem(index)
  const [dragOver, setDragOver] = useState(false)
  const focused = useSelectionStore((s) => s.focusIndex === index)
  const selected = useSelectionStore((s) => item !== undefined && isSelected(s, index, item.id))
  const m = TILE_METRICS[size]
  const draggable = item?.kind === "image" || item?.kind === "video"
  const isFolderDropTarget = item?.kind === "dir"
  const nameSize = size === "small" ? "h-[1.125rem] text-[0.75rem]" : "h-[1.25rem] text-[0.8125rem]"

  const box = [
    "relative flex items-center justify-center overflow-hidden rounded-[3px] text-muted",
    item ? "bg-skeleton/60" : "bg-skeleton",
    // Drawn inside the box: the tile uses paint containment, which clips
    // anything painted outside its bounds.
    dragOver
      ? "outline-2 -outline-offset-2 outline-accent bg-accent/20"
      : selected
        ? "outline-2 -outline-offset-2 outline-accent"
        : "",
    focused && !selected ? "outline-1 -outline-offset-1 outline-dashed outline-accent/70" : "",
  ].join(" ")

  return (
    <div
      role="gridcell"
      id={`tile-${index}`}
      aria-selected={selected}
      aria-label={item?.name}
      data-testid="tile"
      data-index={index}
      data-kind={item?.kind ?? "loading"}
      title={item ? tooltip(item) : undefined}
      className="flex shrink-0 flex-col [contain:layout_paint]"
      style={{ width: m.tile }}
      onMouseDown={(e) => {
        if (!item) return
        const additive = e.ctrlKey || e.metaKey
        if (e.button === 2) {
          // Right-click keeps a selection that includes this tile (Explorer/Finder).
          if (!isSelected(useSelectionStore.getState(), index, item.id))
            focusAndSelect(index, item.id)
        } else if (e.button !== 0) return
        else if (e.shiftKey) selectRangeTo(index, item.id, additive)
        else if (additive) toggleSelected(index, item.id)
        else if (isSelected(useSelectionStore.getState(), index, item.id)) {
          // Keep the selection so it can be dragged; a click without a drag
          // then selects only this tile (Explorer/Finder).
          focusAndPreserveSelection(index, item.id)
          const s = useSelectionStore.getState()
          pendingCollapse = { index, ranges: s.ranges, include: s.include, exclude: s.exclude }
        } else focusAndSelect(index, item.id)
      }}
      onClick={(e) => {
        const pending = pendingCollapse
        pendingCollapse = null
        if (!item || pending?.index !== index || e.shiftKey || e.ctrlKey || e.metaKey) return
        const s = useSelectionStore.getState()
        // A marquee or another change since mousedown wins.
        if (s.ranges !== pending.ranges || s.include !== pending.include) return
        if (s.exclude !== pending.exclude) return
        focusAndSelect(index, item.id)
      }}
      onDragOver={(e) => {
        if (!isFolderDropTarget || !canAcceptSelectionDrop(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDragOver(false)
      }}
      onDrop={(e) => {
        if (!isFolderDropTarget || !item || item.kind !== "dir") return
        const payload = e.dataTransfer.getData(SELECTION_DRAG_TYPE)
        if (!payload) return
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        void bridge
          .properties(item.id)
          .then((properties) => askDropTransfer(payload, properties.path, item.name))
          .catch(() => undefined)
      }}
      onDoubleClick={() => {
        if (item?.kind === "dir") void openFolderEntry(item.id)
        else if (item?.kind === "image") openViewerAt(index)
        else if (item?.kind === "video") playInPane(index, { fullscreen: true })
      }}
    >
      <div className={box} style={{ width: m.tile, height: m.tile }} data-thumb-box>
        {item && <TileThumb item={item} box={m.tile} />}
        {item && <UserBadge item={item} />}
      </div>
      <div
        draggable={draggable}
        data-tile-drag-handle={draggable ? "" : undefined}
        onDragStart={(e) => {
          if (!beginSelectionDrag(e.dataTransfer)) e.preventDefault()
        }}
        className={`mt-1 truncate rounded-[3px] px-1 text-center leading-5 ${nameSize} ${selected ? "bg-raised text-text" : "text-text"} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
        {item?.name ?? ""}
      </div>
    </div>
  )
})
