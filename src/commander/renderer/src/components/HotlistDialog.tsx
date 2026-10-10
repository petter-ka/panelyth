import type { Bookmark } from "@panelyth/contracts"
import { Button, DialogWindow } from "@panelyth/ui"
import { useState } from "react"
import { PanelythError } from "../bridge"
import {
  addCurrentFolder,
  moveBookmark,
  removeBookmark,
  saveBookmark,
  setHotlistEditing,
  useHotlistStore,
} from "../features/hotlist"
import { usePanelsStore } from "../features/panels"

const field =
  "h-8 w-full rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"

/**
 * Hotlist → Configure… (Stage C03, CFR-10): edit, group, reorder and remove
 * the shared bookmarks. Changes are saved at once and reach the viewer
 * through bookmarks.changed.
 */
export function HotlistDialog() {
  const open = useHotlistStore((s) => s.editing)
  const bookmarks = useHotlistStore((s) => s.bookmarks)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = bookmarks.find((b) => b.id === selectedId) ?? bookmarks[0] ?? null
  const groups = [...new Set(bookmarks.map((b) => b.group).filter((g) => g !== ""))]
  return (
    <DialogWindow
      open={open}
      onOpenChange={setHotlistEditing}
      title="Directory hotlist"
      description="Shared with the viewer's bookmarks. Groups show in the commander only."
      contentClassName="w-[min(40rem,calc(100vw-2rem))]"
    >
      <div className="flex gap-3">
        <div className="flex w-56 shrink-0 flex-col gap-2">
          <ul
            role="listbox"
            aria-label="Hotlist folders"
            className="h-64 overflow-y-auto rounded-md border border-border bg-canvas py-1 text-xs"
          >
            {bookmarks.map((b) => (
              <li
                key={b.id}
                role="option"
                aria-selected={b.id === selected?.id}
                onClick={() => setSelectedId(b.id)}
                className="flex cursor-default items-center gap-2 px-2 py-1 aria-selected:bg-accent/20"
              >
                <span className="min-w-0 flex-1 truncate">{b.label}</span>
                {b.group && <span className="truncate text-[0.6875rem] text-muted">{b.group}</span>}
              </li>
            ))}
            {bookmarks.length === 0 && <li className="px-2 py-1 text-muted">No folders yet</li>}
          </ul>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                const side = usePanelsStore.getState().active
                void addCurrentFolder(side)
                  .then((b) => b && setSelectedId(b.id))
                  .then(() => setHotlistEditing(true))
                  .catch(() => undefined)
              }}
            >
              Add current
            </Button>
            <Button
              size="sm"
              aria-label="Move up"
              disabled={!selected || bookmarks[0]?.id === selected.id}
              onClick={() => selected && void moveBookmark(selected.id, -1).catch(() => undefined)}
            >
              ↑
            </Button>
            <Button
              size="sm"
              aria-label="Move down"
              disabled={!selected || bookmarks.at(-1)?.id === selected.id}
              onClick={() => selected && void moveBookmark(selected.id, 1).catch(() => undefined)}
            >
              ↓
            </Button>
          </div>
        </div>
        {selected ? (
          <BookmarkForm key={selected.id} bookmark={selected} groups={groups} />
        ) : (
          <p className="text-xs text-muted">Add the current folder with Ctrl+D.</p>
        )}
      </div>
    </DialogWindow>
  )
}

function BookmarkForm({ bookmark, groups }: { bookmark: Bookmark; groups: string[] }) {
  const [label, setLabel] = useState(bookmark.label)
  const [path, setPath] = useState(bookmark.path)
  const [group, setGroup] = useState(bookmark.group)
  const [error, setError] = useState<string | null>(null)
  const dirty = label !== bookmark.label || path !== bookmark.path || group !== bookmark.group
  const save = async (): Promise<void> => {
    try {
      await saveBookmark({
        ...bookmark,
        label: label.trim(),
        path: path.trim(),
        group: group.trim(),
      })
      setError(null)
    } catch (e) {
      const reason =
        (e instanceof PanelythError && (e.details as { reason?: string })?.reason) || ""
      setError(
        reason === "duplicate"
          ? "Another hotlist entry has this folder."
          : e instanceof PanelythError && e.code === "INVALID_PATH"
            ? "Enter a full folder path."
            : "The entry could not be saved.",
      )
    }
  }
  return (
    <form
      className="flex min-w-0 flex-1 flex-col gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-muted">Name</span>
        <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted">Folder</span>
        <input
          className={field}
          value={path}
          spellCheck={false}
          aria-invalid={error !== null}
          onChange={(e) => setPath(e.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-muted">Group</span>
        <input
          className={field}
          value={group}
          list="hotlist-groups"
          placeholder="No group"
          onChange={(e) => setGroup(e.target.value)}
        />
        <datalist id="hotlist-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
      </label>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      <div className="mt-auto flex justify-between gap-2">
        <Button
          variant="danger"
          onClick={() => void removeBookmark(bookmark.id).catch(() => undefined)}
        >
          Remove
        </Button>
        <Button type="submit" variant="primary" disabled={!dirty || path.trim() === ""}>
          Save
        </Button>
      </div>
    </form>
  )
}
