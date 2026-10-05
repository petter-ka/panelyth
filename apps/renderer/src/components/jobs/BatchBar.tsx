import type { ReactNode } from "react"
import {
  askTags,
  setFavorite,
  transferSelection,
  trashSelection,
} from "../../features/jobs/jobsStore"
import { useShortcutHint } from "../../features/shortcuts/shortcutStore"
import { selectionCount, useSelectionStore } from "../../features/tiles/selectionStore"
import { formatCount } from "../../lib/format"
import { CopyIcon, HeartIcon, MoveIcon, TagIcon, TrashIcon } from "../ui/icons"

function Action(props: { label: string; title?: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={props.title ?? props.label}
      onClick={props.onClick}
      className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-text hover:bg-raised"
    >
      {props.children}
      {props.label}
    </button>
  )
}

/**
 * "12 selected  Copy  Move  Delete  Tag  Favorite" (UX-DESIGN "Batch bar").
 * Shown for two or more selected items; it floats over the canvas so
 * selecting never reflows the tile view. More actions are in the context
 * menu.
 */
export function BatchBar() {
  const count = useSelectionStore(selectionCount)
  const trashKey = useShortcutHint("item.trash")
  if (count < 2) return null
  return (
    <div
      role="toolbar"
      aria-label="Selection actions"
      className="absolute bottom-3 left-3 z-10 flex items-center gap-0.5 rounded-lg border border-border bg-chrome p-1 shadow-lg shadow-black/30"
      data-testid="batch-bar"
    >
      <span className="px-2 text-xs font-medium tabular-nums">{formatCount(count)} selected</span>
      <Action label="Copy to…" onClick={() => void transferSelection("copy")}>
        <CopyIcon size={14} />
      </Action>
      <Action label="Move to…" onClick={() => void transferSelection("move")}>
        <MoveIcon size={14} />
      </Action>
      <Action
        label="Delete"
        title={trashKey ? `Move to trash (${trashKey})` : "Move to trash"}
        onClick={() => void trashSelection()}
      >
        <TrashIcon size={14} />
      </Action>
      <Action label="Tag…" onClick={askTags}>
        <TagIcon size={14} />
      </Action>
      <Action label="Favorite" title="Add to favorites" onClick={() => void setFavorite(true)}>
        <HeartIcon size={14} />
      </Action>
    </div>
  )
}
