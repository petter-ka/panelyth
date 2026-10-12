import type { ContentItem } from "@panelyth/contracts"
import { Spinner } from "@panelyth/ui"
import { memo, useState } from "react"
import { bridge } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../../features/folder/folderStore"
import { labelColor, labelName } from "../../features/labels/labels"
import { tileThumbs } from "../../features/previews/thumbStore"
import { tileCovers } from "../../features/previews/coverStore"
import { TILE_METRICS, type TileSize } from "../../features/tiles/layout"
import { TileThumb, tileFrameClass } from "../../features/media/mediaUi"
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
import { openFullscreenAt } from "../../features/viewer/viewerStore"
import { useSettingsStore } from "../../features/settings/settingsStore"
import { HeartIcon } from "../ui/icons"
import { formatBytes, formatDate } from "../../lib/format"
import { msg, t } from "@panelyth/i18n"

const KIND_LABEL = {
  dir: msg("Folder"),
  image: msg("Image"),
  video: msg("Video"),
  file: msg("File"),
  link: msg("Link"),
} as const

function tooltip(item: ContentItem): string {
  if (item.kind === "dir") return `${item.name}\n${t("Folder")}`
  return `${item.name}\n${t(KIND_LABEL[item.kind])} (${item.ext}), ${formatBytes(item.sizeBytes)}\n${t("Modified {date}", { date: formatDate(item.modifiedMs) })}`
}

/** Set on mousedown on an already selected tile; cleared by the next click. */
let pendingCollapse: {
  index: number
  ranges: SelectionState["ranges"]
  include: SelectionState["include"]
  exclude: SelectionState["exclude"]
} | null = null

/** Label, favorite and rating, drawn inside the thumbnail frame. */
function UserBadge({ item }: { item: ContentItem }) {
  if (!item.favorite && item.rating === 0 && item.label === 0) return null
  const color = labelColor(item.label)
  const label = [
    color && t("{label} label", { label: labelName(item.label) }),
    item.favorite && t("Favorite"),
    item.rating > 0 && t("{count, plural, one {# star} other {# stars}}", { count: item.rating }),
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
  const showFileNames = useSettingsStore((s) => s.settings.showFileNames)
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
        tileFrameClass(visual),
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
        else openFullscreenAt(index)
      }}
    >
      <div
        className={thumbBoxClass}
        style={{ width: m.tile, height: m.tile }}
        data-thumb-box
        data-tooltip-anchor
      >
        {item && (
          <TileThumb
            item={item}
            box={m.tile}
            visual={visual}
            thumbs={tileThumbs}
            covers={tileCovers}
            badge={<UserBadge item={item} />}
          />
        )}
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
