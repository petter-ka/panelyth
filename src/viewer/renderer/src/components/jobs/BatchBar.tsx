import type { ReactNode } from "react"
import { Tooltip } from "@panelyth/ui"
import { openBatchEditor } from "../../features/editor/batchStore"
import {
  askTags,
  setFavorite,
  transferSelection,
  trashSelection,
} from "../../features/jobs/jobsStore"
import { useShortcutHint } from "../../features/shortcuts/shortcutStore"
import { useFolderStore } from "../../features/folder/folderStore"
import {
  clearSelection,
  invertSelection,
  selectionCount,
  useSelectionStore,
} from "../../features/tiles/selectionStore"
import { formatCount } from "../../lib/format"
import {
  CloseIcon,
  CopyIcon,
  HeartIcon,
  MoveIcon,
  PencilIcon,
  TagIcon,
  TrashIcon,
} from "../ui/icons"
import { t } from "@panelyth/i18n"

function Action(props: { label: string; title?: string; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip content={props.title ?? props.label}>
      <button
        type="button"
        onClick={props.onClick}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text hover:bg-raised"
      >
        {props.children}
        {props.label}
      </button>
    </Tooltip>
  )
}

/**
 * "12 selected  Invert  ×  |  Copy  Move  Delete  Tag  Favorite" (UX-DESIGN "Batch bar").
 * Shown for two or more selected items; it floats over the canvas so
 * selecting never reflows the tile view. More actions are in the context
 * menu.
 */
export function BatchBar() {
  const count = useSelectionStore(selectionCount)
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const trashKey = useShortcutHint("item.trash")
  const editKey = useShortcutHint("item.edit")
  if (count < 2) return null
  return (
    <div
      role="toolbar"
      aria-label={t("Selection actions")}
      className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-chrome p-1 shadow-lg shadow-black/30"
      data-testid="batch-bar"
    >
      <span className="px-2 text-xs font-medium prose-nums">
        {t("{count} selected", { count: formatCount(count) })}
      </span>
      <Tooltip content={t("Select what is not selected, and the other way round")}>
        <button
          type="button"
          onClick={() => invertSelection(total)}
          className="h-7 rounded-md px-2 text-xs text-muted hover:bg-raised hover:text-text"
        >
          {t("Invert")}
        </button>
      </Tooltip>
      <Tooltip content={t("Clear selection (Esc)")}>
        <button
          type="button"
          aria-label={t("Clear selection")}
          onClick={clearSelection}
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text"
        >
          <CloseIcon size={14} />
        </button>
      </Tooltip>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
      <Action
        label={t("Edit…")}
        title={
          editKey
            ? t("Edit the selected pictures ({key})", { key: editKey })
            : t("Edit the selected pictures")
        }
        onClick={() => void openBatchEditor()}
      >
        <PencilIcon size={14} />
      </Action>
      <Action label={t("Copy to…")} onClick={() => void transferSelection("copy")}>
        <CopyIcon size={14} />
      </Action>
      <Action label={t("Move to…")} onClick={() => void transferSelection("move")}>
        <MoveIcon size={14} />
      </Action>
      <Action
        label={t("Delete")}
        title={trashKey ? t("Move to trash ({key})", { key: trashKey }) : t("Move to trash")}
        onClick={() => void trashSelection()}
      >
        <TrashIcon size={14} />
      </Action>
      <Action label={t("Tag…")} onClick={askTags}>
        <TagIcon size={14} />
      </Action>
      <Action
        label={t("Favorite")}
        title={t("Add to favorites")}
        onClick={() => void setFavorite(true)}
      >
        <HeartIcon size={14} />
      </Action>
    </div>
  )
}
