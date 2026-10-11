import type { ContentItem } from "@panelyth/contracts"
import { Spinner } from "@panelyth/ui"
import { memo, useState } from "react"
import { bridge } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../../features/folder/folderStore"
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
import { useSettingsStore } from "../../features/settings/settingsStore"
import { HeartIcon, PlayIcon } from "../ui/icons"
import { formatBytes, formatDate } from "../../lib/format"
import { FolderGlyph, UnavailableGlyph, VideoGlyph } from "./glyphs"

const KIND_LABEL = {
  dir: "Folder",
  image: "Image",
  video: "Video",
  file: "File",
  link: "Link",
} as const

function tooltip(item: ContentItem): string {
  if (item.kind === "dir") return `${item.name}\nFolder`
  return `${item.name}\n${KIND_LABEL[item.kind]} (${item.ext}), ${formatBytes(item.sizeBytes)}\nModified ${formatDate(item.modifiedMs)}`
}

/** Visual state shared by each fixed tile slot and its fitted preview frame. */
interface TileVisualState {
  selected: boolean
  focused: boolean
  dragOver: boolean
}

function frameClass({ selected, focused, dragOver }: TileVisualState): string {
  return [
    // Selected: a thick border with a glow and shadow (styles/index.css).
    selected ? "tile-selected" : dragOver ? "outline-2 -outline-offset-2 outline-accent" : "",
    focused && !selected ? "outline-1 -outline-offset-1 outline-dashed outline-accent/70" : "",
  ].join(" ")
}

function fallbackFrameClass(visual: TileVisualState): string {
  const surface = visual.dragOver ? "bg-accent/20" : "bg-skeleton/60"
  return [
    "relative flex size-full items-center justify-center overflow-hidden rounded-[3px] text-muted",
    surface,
    frameClass(visual),
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

/** A folder shows one square cover or a mosaic, with its folder glyph until a cover is ready. */
function FolderThumb({
  item,
  box,
  visual,
}: {
  item: ContentItem
  box: number
  visual: TileVisualState
}) {
  const cover = useCover(item.id)
  const glyph = Math.round(box * 0.36)
  if (!cover?.some((c) => typeof c === "object")) {
    return (
      <div className={fallbackFrameClass(visual)}>
        <FolderGlyph size={glyph} />
        <UserBadge item={item} />
      </div>
    )
  }
  const single = cover.length === 1
  return (
    <div
      className={`relative grid size-full gap-px overflow-hidden rounded-[3px] ${single ? "" : "grid-cols-2 grid-rows-2"} ${frameClass(visual)}`}
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
            onError={() => reportBrokenCover(item.id, slot)}
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
      <UserBadge item={item} />
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

/** The preview or fallback inside the tile's fixed square slot. */
function TileThumb({
  item,
  box,
  visual,
}: {
  item: ContentItem
  box: number
  visual: TileVisualState
}) {
  if (item.kind === "dir") return <FolderThumb item={item} box={box} visual={visual} />
  return <MediaThumb item={item} box={box} visual={visual} />
}

function MediaThumb({
  item,
  box,
  visual,
}: {
  item: ContentItem
  box: number
  visual: TileVisualState
}) {
  const state = useThumb(item.id)
  const glyph = Math.round(box * 0.36)
  if (item.kind === "video" && state?.status !== "ready") {
    return (
      <div className={fallbackFrameClass(visual)}>
        <VideoGlyph size={glyph} />
        <UserBadge item={item} />
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
        onError={() => reportBroken(item.id)}
      />
    )
    if (item.kind !== "video") {
      return (
        <div
          className={`relative shrink-0 overflow-hidden rounded-[3px] ${frameClass(visual)}`}
          style={previewSize}
          data-preview-frame
          data-tooltip-anchor
        >
          {img}
          <UserBadge item={item} />
        </div>
      )
    }
    // Video posters carry a small play badge so they never read as photos.
    return (
      <div
        className={`relative shrink-0 overflow-hidden rounded-[3px] ${frameClass(visual)}`}
        style={previewSize}
        data-preview-frame
        data-tooltip-anchor
      >
        {img}
        <span
          className="absolute right-1 bottom-1 flex items-center justify-center rounded-sm bg-chrome/85 p-0.5 text-text"
          data-testid="video-badge"
          aria-hidden="true"
        >
          <PlayIcon size={Math.max(10, Math.round(box * 0.09))} />
        </span>
        <UserBadge item={item} />
      </div>
    )
  }
  if (state?.status === "failed") {
    return (
      <div className={fallbackFrameClass(visual)}>
        <UnavailableGlyph size={glyph} />
        <UserBadge item={item} />
      </div>
    )
  }
  if (item.kind === "image") {
    return (
      <div className={fallbackFrameClass(visual)} data-testid="thumb-loading">
        <UserBadge item={item} />
      </div>
    )
  }
  return (
    <div className={fallbackFrameClass(visual)}>
      <UserBadge item={item} />
    </div>
  )
}

/** Label, favorite and rating, drawn inside the thumbnail frame. */
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
      className="absolute top-1 left-1 flex max-w-full items-center gap-0.5 truncate rounded-sm bg-chrome/85 px-1 text-[0.625rem] leading-4 text-text"
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
  // Settings can hide file names; the line stays, so the grid's geometry never changes.
  const showFileNames = useSettingsStore((s) => s.preferences.showFileNames)
  // This folder tile is being opened (a slow drive or network folder).
  const opening = useFolderStore(
    (s) => s.opening && item?.kind === "dir" && s.openingTarget === item.id,
  )
  const named = item !== undefined && (showFileNames || item.kind === "dir")
  const m = TILE_METRICS[size]
  const draggable = item?.kind === "image" || item?.kind === "video"
  const isFolderDropTarget = item?.kind === "dir"
  const nameSize = size === "small" ? "h-[1.125rem] text-[0.75rem]" : "h-[1.25rem] text-[0.8125rem]"

  const visual = { selected, focused, dragOver }
  // Not clipped once the item is there: a selected frame's shadow reaches past the slot.
  const thumbBoxClass = item
    ? "relative flex items-center justify-center rounded-[3px]"
    : [
        "relative flex items-center justify-center overflow-hidden rounded-[3px] bg-skeleton",
        frameClass(visual),
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
      data-tooltip-content={item ? tooltip(item) : undefined}
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
      <div
        className={thumbBoxClass}
        style={{ width: m.tile, height: m.tile }}
        data-thumb-box
        data-tooltip-anchor
      >
        {item && <TileThumb item={item} box={m.tile} visual={visual} />}
        {opening && (
          <span className="absolute inset-0 grid place-items-center rounded-[3px] bg-canvas/60 text-text">
            <Spinner size={28} />
          </span>
        )}
      </div>
      <div
        draggable={draggable}
        data-tile-drag-handle={draggable ? "" : undefined}
        onDragStart={(e) => {
          if (!beginSelectionDrag(e.dataTransfer)) e.preventDefault()
        }}
        className={`mt-1 truncate rounded-[3px] px-1 text-center leading-5 ${nameSize} ${selected && named ? "bg-raised text-text" : "text-text"} ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
      >
        {named ? item.name : ""}
      </div>
    </div>
  )
})
