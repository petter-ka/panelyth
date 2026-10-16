import { formatChord } from "@panelyth/renderer-core"
import { Tooltip } from "@panelyth/ui"
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent,
} from "react"
import { runPanelAction } from "../features/commands"
import { ACTIONS, isToolAction, useKeymapStore, type ActionId } from "../features/keymap"
import { useListingStore } from "../features/listing"
import { usePanelsStore } from "../features/panels"
import { openSettings } from "../features/settings"
import {
  addToToolbar,
  commandOf,
  MAX_TOOLBAR_ITEMS,
  moveToolbarItem,
  removeToolbarItem,
  SEPARATOR,
  toolbarCandidates,
  useToolsStore,
} from "../features/tools"
import { quickTarget, useViewersStore } from "../features/viewers"
import { CommanderActionIcon, type CommanderActionIconName } from "./CommanderActionIcon"
import { PopupMenu, type MenuEntry } from "./PopupMenu"
import { t } from "@panelyth/i18n"

/** The icon of every built-in action that can go on the toolbar (a test keeps it complete). */
export const ACTION_ICONS: Partial<Record<ActionId, CommanderActionIconName>> = {
  "find.open": "search",
  "view.filter": "filter",
  "view.branch": "branch",
  "compare.dirs": "compare",
  "compare.sync": "sync",
  "compare.content": "compare",
  "view.quick": "preview",
  "view.refresh": "refresh",
  "hotlist.open": "star",
  "files.rename": "edit",
  "files.multiRename": "edit",
  "files.view": "view",
  "files.edit": "edit",
  "files.copy": "copy",
  "files.move": "move",
  "files.mkdir": "mkdir",
  "files.trash": "delete",
  "files.delete": "delete",
  "clip.copy": "copy",
  "view.thumbs": "tiles",
  "view.brief": "list",
  "view.full": "table",
  "cmd.focus": "terminal",
  "cmd.history": "terminal",
  "cmd.insertName": "terminal",
  "cmd.insertPath": "terminal",
  "help.shortcuts": "keys",
  "app.settings": "gear",
  "app.switch": "switchApp",
  "panel.other": "panelOther",
  "queue.toggle": "queue",
  "nav.up": "up",
  "nav.root": "root",
  "nav.back": "back",
  "nav.forward": "forward",
  "nav.openLeft": "openLeft",
  "nav.openRight": "openRight",
  "panels.swap": "swap",
  "path.edit": "pathEdit",
  "nav.historyMenu": "history",
  "drives.left": "drive",
  "drives.right": "drive",
  "tab.new": "tabAdd",
  "tab.close": "tabClose",
  "tab.next": "tabNext",
  "tab.previous": "tabPrev",
  "tab.lock": "lock",
  "tab.closeOthers": "tabCloseOthers",
  "tab.reopen": "tabReopen",
  "tab.rename": "edit",
  "tab.duplicate": "copy",
  "tab.closeRight": "tabCloseRight",
  "tabs.save": "save",
  "tabs.sets": "tabSets",
  "files.copyHere": "copy",
  "files.newText": "newFile",
  "clip.cut": "cut",
  "clip.paste": "paste",
  "copy.paths": "copyText",
  "copy.names": "copyText",
  "view.hidden": "view",
  "archive.enter": "archive",
  "archive.pack": "archivePack",
  "archive.unpack": "archiveUnpack",
  "archive.test": "archiveTest",
  "hash.create": "hash",
  "hash.verify": "hashCheck",
  "files.undoRename": "undo",
  "files.attributes": "attrs",
  "files.properties": "info",
  "sort.name": "sort",
  "sort.ext": "sort",
  "sort.date": "sort",
  "sort.size": "sort",
  "mark.toggleDown": "markDown",
  "mark.toggle": "mark",
  "mark.all": "markAll",
  "mark.none": "markNone",
  "mark.invert": "markInvert",
  "mark.mask": "markMask",
  "unmark.mask": "markMask",
  "mark.sameExt": "markMask",
  "size.all": "size",
  "view.toolbar": "layoutTop",
  "view.commandLine": "layoutCmd",
  "view.functionKeys": "layoutKeys",
  "tree.toggle": "tree",
  "tree.focus": "tree",
  "remote.connections": "globe",
  "remote.quick": "connect",
  "remote.disconnect": "disconnect",
}

const LABELS = new Map<string, string>(ACTIONS.map((a) => [a.id, a.label]))

/** A built-in action's name as the toolbar and its settings show it. */
export const actionLabel = (id: string): string => t(LABELS.get(id) ?? id)

/** Lower case without accents, for the add menu's search. */
const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

/** What a toolbar item being dragged carries (not a file: panels ignore it). */
const TOOLBAR_DRAG = "application/x-panelyth-toolbar"

const buttonClass =
  "group grid size-8 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text aria-pressed:bg-accent/10 aria-pressed:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"

/**
 * The toolbar above the panels (Stage C10, CFR-25): the buttons the user
 * chose, each a built-in action or one of their own commands (icon, label as
 * the tooltip, command). The default set is the quick actions the bar had
 * before it could be changed. The button at the right end switches edit mode:
 * drag to reorder, right-click to move or remove, "+" to add.
 */
export function QuickActionBar() {
  const active = usePanelsStore((s) => s.active)
  const chords = useKeymapStore((s) => s.keymap.chords)
  const items = useToolsStore((s) => s.toolbar)
  // The commands' titles and icons can change without the list changing.
  useToolsStore((s) => s.commands)
  const branch = useListingStore((s) => s[active].branch)
  const filter = useListingStore((s) => s[active].filter)
  const view = useListingStore((s) => s[active].view)
  const quick = useViewersStore(quickTarget)

  const pressedOf = (action: string): boolean | undefined => {
    switch (action) {
      case "view.quick":
        return quick !== null
      case "view.branch":
        return branch
      case "view.filter":
        return filter.length > 0
      case "view.thumbs":
        return view === "thumbs"
      default:
        return undefined
    }
  }

  // Edit mode (the button at the right end): buttons don't run, they move.
  // Drag one to reorder, right-click it to move or remove it; "+" adds.
  const [editing, setEditing] = useState(false)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<{ index: number; after: boolean } | null>(null)
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!editing) return
    // Esc leaves edit mode (its menus close themselves first).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      e.preventDefault()
      e.stopPropagation()
      setEditing(false)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [editing])

  /** Drag and the item menu, on any item (a button or a divider) while editing. */
  const editable = (index: number) =>
    editing
      ? {
          draggable: true,
          "data-index": index,
          onDragStart: (e: DragEvent<HTMLElement>) => {
            setDragFrom(index)
            e.dataTransfer.effectAllowed = "move"
            // Not a file: panels and folders ignore it.
            e.dataTransfer.setData(TOOLBAR_DRAG, String(index))
          },
          onDragOver: (e: DragEvent<HTMLElement>) => {
            if (dragFrom === null) return
            e.preventDefault()
            const r = e.currentTarget.getBoundingClientRect()
            const after = e.clientX > r.left + r.width / 2
            setDropAt((d) => (d?.index === index && d.after === after ? d : { index, after }))
          },
          onDrop: (e: DragEvent<HTMLElement>) => {
            if (dragFrom === null || !dropAt) return
            e.preventDefault()
            moveToolbarItem(dragFrom, dropAt.after ? dropAt.index + 1 : dropAt.index)
            setDragFrom(null)
            setDropAt(null)
          },
          onDragEnd: () => {
            setDragFrom(null)
            setDropAt(null)
          },
          onContextMenu: (e: MouseEvent<HTMLElement>) => {
            e.preventDefault()
            setMenu({ index, x: e.clientX, y: e.clientY })
          },
        }
      : {}
  /** Where a dragged item would land: a line on that side of the item. */
  const dropLine = (index: number) =>
    dropAt?.index === index && dragFrom !== null ? (
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-accent ${dropAt.after ? "-right-[3px]" : "-left-[3px]"}`}
      />
    ) : null

  return (
    <nav
      aria-label={t("Toolbar")}
      data-editing={editing || undefined}
      className={`glass-region flex h-9 shrink-0 items-center gap-1 border-b border-border px-1.5 ${editing ? "bg-raised/50" : "bg-chrome"}`}
      data-testid="quick-actions"
    >
      {items.map((item, index) => {
        if (item === SEPARATOR) {
          return (
            <span
              key={`separator-${index}`}
              role="separator"
              aria-orientation="vertical"
              {...editable(index)}
              // While editing a divider has room to be grabbed.
              className={`relative flex h-6 shrink-0 items-center ${editing ? "cursor-grab px-1.5 rounded-sm outline-1 -outline-offset-1 outline-border outline-dashed" : "mx-1"}`}
            >
              <span className="h-4 w-px bg-border" />
              {dropLine(index)}
            </span>
          )
        }
        const tool = commandOf(item)
        if (isToolAction(item) && !tool) return null
        const label = tool ? tool.title : actionLabel(item)
        const chord = chords[item]?.[0]
        const icon = tool ? tool.icon : (ACTION_ICONS[item as ActionId] ?? "tool")
        return (
          <Tooltip
            key={item}
            content={editing ? label : chord ? `${label} (${formatChord(chord)})` : label}
          >
            <button
              type="button"
              aria-label={label}
              aria-pressed={editing ? undefined : pressedOf(item)}
              data-tool={tool?.id}
              {...editable(index)}
              onClick={() => {
                if (!editing) runPanelAction(usePanelsStore.getState().active, item as ActionId)
              }}
              className={`relative ${buttonClass} ${editing ? "cursor-grab outline-1 -outline-offset-1 outline-border outline-dashed" : ""} ${dragFrom === index ? "opacity-40" : ""}`}
            >
              <CommanderActionIcon name={icon} />
              {dropLine(index)}
            </button>
          </Tooltip>
        )
      })}
      {editing && <AddToToolbar />}
      {editing && (
        <span className="ml-2 truncate text-2xs text-muted">
          {t("Drag to reorder, right-click to remove")}
        </span>
      )}
      <span className="flex-1" aria-hidden="true" />
      <Tooltip content={editing ? t("Done editing (Esc)") : t("Edit the toolbar")}>
        <button
          type="button"
          aria-label={t("Edit the toolbar")}
          aria-pressed={editing}
          data-testid="toolbar-edit"
          onClick={() => {
            setEditing((e) => !e)
            setMenu(null)
          }}
          className={buttonClass}
        >
          <CommanderActionIcon name="attrs" />
        </button>
      </Tooltip>
      {menu && items[menu.index] !== undefined && (
        <PopupMenu
          label={t("Toolbar button")}
          testId="toolbar-item-menu"
          onClose={() => setMenu(null)}
          style={{ position: "fixed", left: menu.x, top: menu.y }}
          entries={[
            {
              id: "left",
              label: t("Move left"),
              disabled: menu.index === 0,
              onSelect: () => moveToolbarItem(menu.index, menu.index - 1),
            },
            {
              id: "right",
              label: t("Move right"),
              disabled: menu.index >= items.length - 1,
              onSelect: () => moveToolbarItem(menu.index, menu.index + 2),
            },
            { id: "s", label: "", separator: true },
            {
              id: "remove",
              label: t("Remove from the toolbar"),
              onSelect: () => removeToolbarItem(menu.index),
            },
          ]}
        />
      )}
    </nav>
  )
}

/**
 * "+" at the end of the buttons in edit mode: what Settings → Toolbar can add (actions not
 * on it yet, the user's commands, a divider), added at once at the end; the
 * menu stays open for more. "Customize toolbar…" opens Settings at that
 * section, where the order can be changed.
 */
function AddToToolbar() {
  const items = useToolsStore((s) => s.toolbar)
  const commands = useToolsStore((s) => s.commands)
  const button = useRef<HTMLButtonElement>(null)
  // Fixed to the window: inside the bar the menu's height limit would leave no room.
  const [at, setAt] = useState<CSSProperties | null>(null)
  const full = items.length >= MAX_TOOLBAR_ITEMS
  const open = (): void => {
    const r = button.current?.getBoundingClientRect()
    if (!r) return
    setAt({ position: "fixed", left: Math.min(r.left, window.innerWidth - 272), top: r.bottom + 4 })
  }
  // The search field filters by name, ignoring case and accents.
  const [query, setQuery] = useState("")
  const wanted = fold(query.trim())
  const matches = (name: string): boolean => wanted === "" || fold(name).includes(wanted)
  const additions = toolbarCandidates(items, commands)
    .map((item) => {
      const tool = commandOf(item)
      return {
        item,
        name: tool ? tool.title : actionLabel(item),
        icon: tool ? tool.icon : (ACTION_ICONS[item as ActionId] ?? "tool"),
      }
    })
    .filter((a) => matches(a.name))
  const divider = matches(t("Divider"))
  const entries: MenuEntry[] = [
    { id: "h-add", label: t("Add to the toolbar"), heading: true },
    ...additions.map(({ item, name, icon }): MenuEntry => ({
      id: `add-${item}`,
      label: (
        <span className="flex items-center gap-2">
          <CommanderActionIcon name={icon} />
          {name}
        </span>
      ),
      disabled: full,
      keepOpen: true,
      onSelect: () => void addToToolbar(item),
    })),
    ...(additions.length === 0 && !divider
      ? [{ id: "none", label: t("No matches"), disabled: true } satisfies MenuEntry]
      : []),
  ]
  if (divider) {
    // A divider at the end; the next button added comes after it.
    entries.push({
      id: "add-divider",
      label: (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="mx-[7px] h-4 w-px bg-border" />
          {t("Divider")}
        </span>
      ),
      disabled: full || items.length === 0 || items.at(-1) === SEPARATOR,
      keepOpen: true,
      onSelect: () => void addToToolbar(SEPARATOR),
    })
  }
  entries.push(
    { id: "s-customize", label: "", separator: true },
    {
      id: "customize",
      label: t("Customize toolbar…"),
      onSelect: () => openSettings({ section: "toolbar" }),
    },
  )
  return (
    <>
      {/* No tooltip over its own open menu. */}
      <Tooltip content={at ? undefined : t("Add to the toolbar")}>
        <button
          ref={button}
          type="button"
          aria-label={t("Add to the toolbar")}
          aria-haspopup="menu"
          aria-expanded={at !== null}
          data-testid="toolbar-add"
          onClick={() => (at ? setAt(null) : open())}
          className={buttonClass}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
      </Tooltip>
      {at && (
        <PopupMenu
          label={t("Add to the toolbar")}
          testId="toolbar-add-menu"
          entries={entries}
          onClose={() => {
            setAt(null)
            setQuery("")
          }}
          style={at}
          search={{ value: query, onChange: setQuery, label: t("Search actions") }}
        />
      )}
    </>
  )
}
