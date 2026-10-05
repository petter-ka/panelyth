import { bridge } from "../../bridge"
import { openFolderEntry, refresh, useFolderStore } from "../../features/folder/folderStore"
import { LABELS, labelColor } from "../../features/labels/labels"
import {
  askDeletePermanently,
  askTags,
  copySelection,
  paste,
  pasteReplacing,
  renameSelection,
  setFavorite,
  setLabel,
  setRating,
  transferSelection,
  trashSelection,
  useJobsStore,
} from "../../features/jobs/jobsStore"
import {
  openEntryProperties,
  openProperties,
  singleSelectedId,
} from "../../features/properties/propertiesStore"
import { TILE_SIZE_ORDER, type TileSize } from "../../features/tiles/layout"
import { useLayoutStore } from "../../features/tiles/layoutStore"
import { getItem } from "../../features/tiles/pageStore"
import {
  selectAll,
  selectionCount,
  toDescriptor,
  useSelectionStore,
} from "../../features/tiles/selectionStore"
import { openViewerAt } from "../../features/viewer/viewerStore"
import { copyImage, copyName, copySelectionToClipboard } from "../../features/clipboard/clipboard"
import { playInPane } from "../../features/preview/previewStore"
import { formatCount, plural } from "../../lib/format"
import { SortMenuItems } from "../FolderToolbar"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
} from "../ui/menu"

export type MenuTarget = "selection" | "background"

const SIZE_LABEL: Record<TileSize, string> = { small: "Small", medium: "Medium", large: "Large" }

// Actions report failures in the status line rather than throwing into React.
const quietly = (p: Promise<unknown>): void => void p.catch(() => undefined)

function copySelectionPaths(): void {
  const query = useFolderStore.getState().query
  if (!query) return
  quietly(
    bridge.copyPaths(toDescriptor(useSelectionStore.getState(), query.queryId, query.version)),
  )
}

/** Items for a right-clicked tile (and whatever else is selected with it). */
function SelectionItems() {
  const count = useSelectionStore(selectionCount)
  const focusIndex = useSelectionStore((s) => s.focusIndex)
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const single = count === 1 ? singleSelectedId() : null
  const item =
    single === null
      ? undefined
      : getItem(focusIndex)?.id === single
        ? getItem(focusIndex)
        : undefined

  return (
    <>
      {single !== null && (
        <>
          {item?.kind === "dir" && (
            <ContextMenuItem shortcut="Enter" onSelect={() => void openFolderEntry(single)}>
              Open
            </ContextMenuItem>
          )}
          {item?.kind === "image" && (
            <ContextMenuItem shortcut="Enter" onSelect={() => openViewerAt(focusIndex)}>
              Open
            </ContextMenuItem>
          )}
          {item?.kind === "video" && (
            <>
              <ContextMenuItem shortcut="Enter" onSelect={() => playInPane(focusIndex)}>
                Play
              </ContextMenuItem>
              <ContextMenuItem
                shortcut="Double-click"
                onSelect={() => playInPane(focusIndex, { fullscreen: true })}
              >
                Play full screen
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onSelect={() => quietly(bridge.openWithSystem(single))}>
            Open with default app
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => quietly(bridge.reveal(single))}>
            Show in file manager
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {count > 1 && <ContextMenuLabel>{formatCount(count)} items selected</ContextMenuLabel>}
      <FileItems
        pictureId={item?.kind === "image" ? item.id : undefined}
        favorite={item?.kind === "dir" ? undefined : item?.favorite}
        rating={item?.rating}
        label={item?.label}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={copySelectionPaths}>
        {count > 1 ? "Copy paths" : "Copy path"}
      </ContextMenuItem>
      {item && (
        <ContextMenuItem onSelect={() => void copyName(item.name)}>Copy name</ContextMenuItem>
      )}
      <ContextMenuItem shortcut="Ctrl+A" onSelect={() => selectAll(total)}>
        Select all
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem action="item.properties" onSelect={openProperties}>
        Properties
      </ContextMenuItem>
    </>
  )
}

/** File operations and user metadata for the selection (Stage 07, ADR-0021). */
function FileItems({
  pictureId,
  favorite,
  rating,
  label,
}: {
  /** One image is selected: offer copying the picture itself. */
  pictureId: number | undefined
  favorite: boolean | undefined
  rating: number | undefined
  label: number | undefined
}) {
  const clip = useJobsStore((s) => s.clip)
  return (
    <>
      <ContextMenuItem action="edit.cut" onSelect={() => void copySelection("cut")}>
        Cut
      </ContextMenuItem>
      <ContextMenuItem action="edit.copy" onSelect={() => void copySelectionToClipboard()}>
        Copy
      </ContextMenuItem>
      {pictureId !== undefined && (
        <ContextMenuItem onSelect={() => void copyImage(pictureId)}>Copy picture</ContextMenuItem>
      )}
      {clip.mode !== "" && (
        <>
          <ContextMenuItem action="edit.paste" onSelect={() => void paste()}>
            Paste {plural(clip.count, "item", "items")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={pasteReplacing}>
            Paste and overwrite conflicts...
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem onSelect={() => void transferSelection("copy")}>Copy to…</ContextMenuItem>
      <ContextMenuItem onSelect={() => void transferSelection("move")}>Move to…</ContextMenuItem>
      <ContextMenuItem action="item.rename" onSelect={renameSelection}>
        Rename…
      </ContextMenuItem>
      <ContextMenuItem action="item.trash" onSelect={() => void trashSelection()}>
        Move to trash
      </ContextMenuItem>
      <ContextMenuItem action="item.delete" onSelect={askDeletePermanently}>
        Delete permanently…
      </ContextMenuItem>
      <ContextMenuSeparator />
      {favorite !== true && (
        <ContextMenuItem onSelect={() => void setFavorite(true)}>Add to favorites</ContextMenuItem>
      )}
      {favorite !== false && (
        <ContextMenuItem onSelect={() => void setFavorite(false)}>
          Remove from favorites
        </ContextMenuItem>
      )}
      <ContextMenuSub label="Rating">
        <ContextMenuRadioGroup
          value={rating === undefined ? "" : String(rating)}
          onValueChange={(v) => void setRating(Number(v))}
        >
          {[5, 4, 3, 2, 1, 0].map((r) => (
            <ContextMenuRadioItem key={r} value={String(r)}>
              {r === 0 ? "No rating" : "★".repeat(r)}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSub>
      <ContextMenuSub label="Label">
        <ContextMenuRadioGroup
          value={label === undefined ? "" : String(label)}
          onValueChange={(v) => void setLabel(Number(v))}
        >
          {[...LABELS, { value: 0, name: "No label" }].map((l) => (
            <ContextMenuRadioItem key={l.value} value={String(l.value)}>
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full border border-border"
                  style={{ background: labelColor(l.value) ?? "transparent" }}
                />
                {l.name}
              </span>
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSub>
      <ContextMenuItem onSelect={askTags}>Tags…</ContextMenuItem>
    </>
  )
}

/** Items for empty space: view settings and the folder itself. */
function BackgroundItems() {
  const clip = useJobsStore((s) => s.clip)
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const dirId = useFolderStore((s) => s.folder?.dirId ?? null)
  const size = useLayoutStore((s) => s.tileSize)
  const setSize = useLayoutStore((s) => s.setTileSize)
  return (
    <>
      <ContextMenuSub label="Sort by">
        <SortMenuItems
          Group={ContextMenuRadioGroup}
          Item={ContextMenuRadioItem}
          Label={ContextMenuLabel}
          Separator={ContextMenuSeparator}
        />
      </ContextMenuSub>
      <ContextMenuSub label="Tile size">
        <ContextMenuRadioGroup value={size} onValueChange={(v) => setSize(v as TileSize)}>
          {TILE_SIZE_ORDER.map((s) => (
            <ContextMenuRadioItem key={s} value={s}>
              {SIZE_LABEL[s]}
            </ContextMenuRadioItem>
          ))}
        </ContextMenuRadioGroup>
      </ContextMenuSub>
      <ContextMenuItem action="view.refresh" onSelect={() => void refresh()}>
        Refresh
      </ContextMenuItem>
      {clip.mode !== "" && dirId !== null && (
        <>
          <ContextMenuItem action="edit.paste" onSelect={() => void paste()}>
            Paste {plural(clip.count, "item", "items")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={pasteReplacing}>
            Paste and overwrite conflicts...
          </ContextMenuItem>
        </>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem shortcut="Ctrl+A" disabled={total === 0} onSelect={() => selectAll(total)}>
        Select all
      </ContextMenuItem>
      {dirId !== null && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => openEntryProperties(dirId)}>
            Folder properties
          </ContextMenuItem>
        </>
      )}
    </>
  )
}

/** The tile view's context menu: one for the selection, one for empty space. */
export function TileMenu({ target }: { target: MenuTarget }) {
  return (
    <ContextMenuContent data-testid="tile-menu">
      {target === "selection" ? <SelectionItems /> : <BackgroundItems />}
    </ContextMenuContent>
  )
}
