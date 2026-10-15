import type { Crumb, PlaceId } from "@panelyth/contracts"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Spinner, Tooltip, TreeTwisty, TypeGlyph } from "@panelyth/ui"
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react"
import { bridge } from "../bridge"
import {
  askDropTransfer,
  canAcceptSelectionDrop,
  takeSelectionDrop,
} from "../features/jobs/jobsStore"
import { openFolder, useFolderStore } from "../features/folder/folderStore"
import { INTERFACE_SIZE_SCALE, useInterfaceSizeStore } from "../features/theme/interfaceSizeStore"
import {
  isBookmarked,
  removeBookmark,
  RECENT_SHOWN,
  toggleBookmark,
  useLibraryStore,
} from "../features/library/libraryStore"
import {
  collapse,
  expand,
  flatten,
  getNode,
  nodeKey,
  refreshNode,
  toggle,
  useTreeStore,
} from "../features/tree/treeStore"
import { setPreviewPlace, usePaneStore } from "../features/workspace/workspace"
import { ChevronRightIcon, PanelBottomLeftIcon, PanelRightIcon } from "./ui/icons"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownContent,
  DropdownItem,
  DropdownRoot,
  DropdownTrigger,
} from "./ui/menu"
import { msg, t } from "@panelyth/i18n"

const ROW_HEIGHT = 26
const INDENT = 14
const PATH_HEADER_HEIGHT = 32
const LIST_PADDING = 4
const EMPTY_CRUMBS: Crumb[] = []

type SidebarRow =
  | { type: "header"; id: string; label: string }
  | {
      type: "link"
      id: string
      label: string
      path: string
      icon: ReactNode
      bookmarkId?: number
    }
  | { type: "tree"; id: string; key: string; depth: number; expanded: boolean }
  | { type: "note"; id: string; label: string; depth: number }

const folderIcon = <TypeGlyph glyph="folder" size={14} />

const PLACE_ICON: Record<PlaceId, ReactNode> = {
  home: <TypeGlyph glyph="home" size={14} />,
  desktop: folderIcon,
  documents: folderIcon,
  downloads: folderIcon,
  pictures: folderIcon,
  videos: folderIcon,
}

/** Display name for a recent/bookmarked path (display only; never used for I/O). */
function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? path
}

function useRows(): SidebarRow[] {
  const places = useLibraryStore((s) => s.places)
  const bookmarks = useLibraryStore((s) => s.bookmarks)
  const recent = useLibraryStore((s) => s.recent)
  const roots = useTreeStore((s) => s.roots)
  const expanded = useTreeStore((s) => s.expanded)
  const version = useTreeStore((s) => s.version)

  return useMemo(() => {
    const rows: SidebarRow[] = []
    if (places.length > 0) {
      rows.push({ type: "header", id: "h-places", label: t("Quick access") })
      for (const p of places) {
        rows.push({
          type: "link",
          id: `place-${p.id}`,
          label: t(p.label),
          path: p.path,
          icon: PLACE_ICON[p.id],
        })
      }
    }
    if (bookmarks.length > 0) {
      rows.push({ type: "header", id: "h-bookmarks", label: t("Bookmarks") })
      for (const b of bookmarks) {
        rows.push({
          type: "link",
          id: `bookmark-${b.id}`,
          label: b.label,
          path: b.path,
          icon: <TypeGlyph glyph="bookmark" size={14} />,
          bookmarkId: b.id,
        })
      }
    }
    if (recent.length > 0) {
      rows.push({ type: "header", id: "h-recent", label: t("Recent") })
      for (const r of recent.slice(0, RECENT_SHOWN)) {
        rows.push({
          type: "link",
          id: `recent-${r.path}`,
          label: baseName(r.path),
          path: r.path,
          icon: <TypeGlyph glyph="recent" size={14} />,
        })
      }
    }
    rows.push({ type: "header", id: "h-folders", label: t("Folders") })
    for (const entry of flatten(roots, expanded)) {
      rows.push({
        type: "tree",
        id: `tree-${entry.key}`,
        key: entry.key,
        depth: entry.depth,
        expanded: entry.expanded,
      })
      if (entry.expanded && entry.node.children?.length === 0 && !entry.node.loading) {
        rows.push({
          type: "note",
          id: `note-${entry.key}`,
          label: entry.node.error ?? t("No subfolders"),
          depth: entry.depth + 1,
        })
      }
      if (entry.expanded && entry.node.truncated) {
        rows.push({
          type: "note",
          id: `more-${entry.key}`,
          label: t("Only the first 20,000 folders are shown"),
          depth: entry.depth + 1,
        })
      }
    }
    return rows
    // version: node contents changed (listing arrived, loading flag)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, bookmarks, recent, roots, expanded, version])
}

const rowPath = (row: SidebarRow): string | null =>
  row.type === "link" ? row.path : row.type === "tree" ? (getNode(row.key)?.path ?? null) : null

const isNavigable = (row: SidebarRow | undefined): boolean =>
  row?.type === "link" || row?.type === "tree"

function FolderPathHeader({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return null

  // Keep the filesystem root visible and tuck long middle paths into a menu.
  const hidden = crumbs.length > 4 ? crumbs.slice(1, -3) : []
  const shown = hidden.length > 0 ? [crumbs[0]!, ...crumbs.slice(-3)] : crumbs

  return (
    <div
      className="sticky top-0 z-10 flex h-8 shrink-0 items-center border-b border-border bg-chrome px-2"
      data-testid="sidebar-path-header"
    >
      <nav aria-label={t("Selected folder path")} className="min-w-0 flex-1 overflow-hidden">
        <ol className="flex min-w-0 items-center">
          {shown.map((crumb, index) => {
            const last = index === shown.length - 1
            const showHidden = hidden.length > 0 && index === 1
            return (
              <li key={crumb.path} className="flex min-w-0 shrink items-center">
                {index > 0 && !showHidden && (
                  <ChevronRightIcon size={12} className="shrink-0 text-muted" />
                )}
                {showHidden && (
                  <>
                    <ChevronRightIcon size={12} className="shrink-0 text-muted" />
                    <DropdownRoot>
                      <DropdownTrigger
                        className="rounded px-1 py-0.5 text-xs text-muted hover:bg-raised hover:text-text"
                        aria-label={t("Show {count} parent folders", { count: hidden.length })}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        …
                      </DropdownTrigger>
                      <DropdownContent>
                        {hidden.map((parent) => (
                          <DropdownItem
                            key={parent.path}
                            onSelect={() => void openFolder(parent.path)}
                          >
                            {parent.name}
                          </DropdownItem>
                        ))}
                      </DropdownContent>
                    </DropdownRoot>
                    <ChevronRightIcon size={12} className="shrink-0 text-muted" />
                  </>
                )}
                <Tooltip content={crumb.path}>
                  <button
                    type="button"
                    aria-current={last ? "location" : undefined}
                    disabled={last}
                    data-testid="sidebar-path-crumb"
                    data-path={crumb.path}
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={() => void openFolder(crumb.path)}
                    className={`min-w-0 truncate rounded px-1 py-0.5 text-2xs ${last ? "max-w-[7rem] font-medium text-text" : "max-w-[4rem] text-muted hover:bg-raised hover:text-text"}`}
                  >
                    {crumb.name}
                  </button>
                </Tooltip>
              </li>
            )
          })}
        </ol>
      </nav>
    </div>
  )
}

interface RowViewProps {
  row: SidebarRow
  active: boolean
  focused: boolean
  interfaceScale: number
  onOpen(path: string): void
  onDropTransfer(path: string, folderName: string, payload: string): void
  onMenu(row: SidebarRow): void
  onFocusRow(id: string): void
}

const RowView = memo(function RowView({
  row,
  active,
  focused,
  interfaceScale,
  onOpen,
  onDropTransfer,
  onMenu,
  onFocusRow,
}: RowViewProps) {
  const [dragOver, setDragOver] = useState(false)
  const path = rowPath(row)
  // The folder is being opened from this row (a drive that is slow to answer).
  const opening = useFolderStore((s) => s.opening && path !== null && s.openingTarget === path)
  if (row.type === "header") {
    return (
      <div className="flex h-full items-end px-3 pb-1 text-2xs font-medium text-muted">
        {row.label}
      </div>
    )
  }
  if (row.type === "note") {
    return (
      <div
        className="flex h-full items-center truncate pr-2 text-2xs text-muted"
        style={{ paddingLeft: (26 + row.depth * INDENT) * interfaceScale }}
      >
        {row.label}
      </div>
    )
  }
  const node = row.type === "tree" ? getNode(row.key) : undefined
  const label = row.type === "tree" ? (node?.name ?? "") : row.label
  const depth = row.type === "tree" ? row.depth : 0
  return (
    <div
      id={`sidebar-${row.id}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={active}
      aria-expanded={row.type === "tree" && node?.hasChildren ? row.expanded : undefined}
      aria-label={label}
      aria-busy={opening || undefined}
      data-tooltip-content={path ?? undefined}
      data-tooltip-side="right"
      data-testid={row.type === "tree" ? "tree-node" : "sidebar-link"}
      data-path={path ?? undefined}
      className={[
        "mx-1.5 flex h-full cursor-default items-center gap-1.5 rounded-md pr-2 text-xs font-medium",
        active ? "bg-raised text-text" : "text-text hover:bg-raised/60",
        dragOver ? "outline-1 -outline-offset-1 outline-accent bg-accent/15" : "",
        focused ? "outline-1 -outline-offset-1 outline-accent/70" : "",
      ].join(" ")}
      style={{ paddingLeft: (6 + depth * INDENT) * interfaceScale }}
      onMouseDown={() => onFocusRow(row.id)}
      onClick={() => {
        if (!path) return
        onOpen(path)
        // A click opens the folder in the tree too: its subfolders show.
        if (row.type === "tree" && node?.hasChildren && !row.expanded) void expand(row.key)
      }}
      onDragOver={(e) => {
        if (!path || !canAcceptSelectionDrop(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "copy"
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setDragOver(false)
      }}
      onDrop={(e) => {
        if (!path) return
        const payload = takeSelectionDrop(e.dataTransfer)
        if (!payload) return
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        onDropTransfer(path, label, payload)
      }}
      onContextMenu={() => onMenu(row)}
    >
      {row.type === "tree" ? (
        <TreeTwisty
          name={label}
          expanded={row.expanded}
          hasChildren={node?.hasChildren ?? false}
          onToggle={() => toggle(row.key)}
        />
      ) : null}
      <span className={`shrink-0 ${active ? "text-accent" : "text-muted"}`}>
        {opening ? (
          <Spinner size={14} />
        ) : row.type === "tree" ? (
          depth === 0 ? (
            <TypeGlyph glyph="drive" size={14} />
          ) : (
            folderIcon
          )
        ) : (
          row.icon
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {node?.loading && <span className="text-3xs text-muted">…</span>}
    </div>
  )
})

// The quick-access places come named in English from main (home, desktop…);
// these markers put their names into the translation catalogs.
export const PLACE_NAMES = [
  msg("Home"),
  msg("Desktop"),
  msg("Documents"),
  msg("Downloads"),
  msg("Pictures"),
  msg("Videos"),
]

const PREVIEW_PLACES = [
  {
    place: "left",
    label: msg("Preview under the folders"),
    icon: <PanelBottomLeftIcon size={14} />,
  },
  {
    place: "right",
    label: msg("Preview in a column on the right"),
    icon: <PanelRightIcon size={14} />,
  },
] as const

/** Next to the title: where the preview sits (ADR-0023). */
function PreviewPlaceSwitch() {
  const current = usePaneStore((s) => s.previewPlace)
  return (
    <div
      role="radiogroup"
      aria-label={t("Preview position")}
      className="flex items-center rounded-md border border-border p-px"
    >
      {PREVIEW_PLACES.map(({ place, label, icon }) => (
        <Tooltip key={place} content={t(label)}>
          <button
            type="button"
            role="radio"
            aria-checked={current === place}
            aria-label={t(label)}
            onClick={() => setPreviewPlace(place)}
            className="grid h-5 w-6 place-items-center rounded-[5px] text-muted hover:text-text aria-checked:bg-raised aria-checked:text-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {icon}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * Sidebar: quick access, bookmarks, recent folders and the lazy folder tree
 * in one virtualized list, so a folder with 10k subfolders expands without
 * mounting 10k rows. Keyboard: ↑/↓ move, → expands or enters, ← collapses
 * or goes to the parent, Enter opens.
 */
export function SidebarPane() {
  const rows = useRows()
  const folderPath = useFolderStore((s) => s.folder?.path ?? null)
  const folderCrumbs = useFolderStore((s) => s.folder?.crumbs ?? EMPTY_CRUMBS)
  const bookmarks = useLibraryStore((s) => s.bookmarks)
  const revealToken = useTreeStore((s) => s.revealToken)
  const activeKey = useTreeStore((s) => s.activeKey)
  const interfaceScale = INTERFACE_SIZE_SCALE[useInterfaceSizeStore((s) => s.size)]
  const rowHeight = ROW_HEIGHT * interfaceScale
  const pathHeaderOffset = folderCrumbs.length > 0 ? PATH_HEADER_HEIGHT : 0
  const [focusId, setFocusId] = useState<string | null>(null)
  const [menuRow, setMenuRow] = useState<SidebarRow | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeFolderKey = folderPath === null ? null : nodeKey(folderPath)

  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    paddingStart: pathHeaderOffset + LIST_PADDING,
    paddingEnd: LIST_PADDING,
    scrollPaddingStart: pathHeaderOffset,
    overscan: 8,
    useFlushSync: false,
  })

  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight, pathHeaderOffset])

  // The open folder is shown in the tree: a folder already in sight stays put
  // (a click in the tree never moves it); one out of sight, as at start or
  // when the commander hands a folder over, comes to the middle.
  useEffect(() => {
    if (revealToken === 0 || !activeKey) return
    const index = rows.findIndex((r) => r.type === "tree" && r.key === activeKey)
    const el = scrollRef.current
    const item = virtualizer.measurementsCache[index]
    if (index < 0 || !el || !item) return
    const top = el.scrollTop + pathHeaderOffset
    const inSight = item.start >= top && item.end <= el.scrollTop + el.clientHeight
    if (!inSight) virtualizer.scrollToIndex(index, { align: "center" })
    // rows are read at reveal time; only the token triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken, activeKey, virtualizer])

  const focusIndex = rows.findIndex((r) => r.id === focusId)
  const moveFocus = (from: number, step: 1 | -1): void => {
    for (let i = from + step; i >= 0 && i < rows.length; i += step) {
      if (isNavigable(rows[i])) {
        setFocusId(rows[i]!.id)
        virtualizer.scrollToIndex(i, { align: "auto" })
        return
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[focusIndex]
    const actions: Record<string, () => void> = {
      ArrowDown: () => moveFocus(focusIndex, 1),
      ArrowUp: () => moveFocus(focusIndex < 0 ? rows.length : focusIndex, -1),
      Home: () => moveFocus(-1, 1),
      End: () => moveFocus(rows.length, -1),
      Enter: () => {
        const path = row && rowPath(row)
        if (path) void openFolder(path)
      },
      ArrowRight: () => {
        if (row?.type !== "tree") return
        if (!row.expanded) void expand(row.key)
        else moveFocus(focusIndex, 1)
      },
      ArrowLeft: () => {
        if (row?.type !== "tree") return
        if (row.expanded) {
          collapse(row.key)
          return
        }
        for (let i = focusIndex - 1; i >= 0; i--) {
          const r = rows[i]!
          if (r.type === "tree" && r.depth < row.depth) {
            setFocusId(r.id)
            virtualizer.scrollToIndex(i, { align: "auto" })
            return
          }
        }
      },
    }
    const action = actions[e.key]
    if (!action) return
    e.preventDefault()
    action()
  }

  const menuPath = menuRow ? rowPath(menuRow) : null
  const menuBookmarked = menuPath !== null && isBookmarked(bookmarks, menuPath)

  return (
    <nav
      aria-label={t("Locations")}
      data-pane="locations"
      className="flex h-full min-h-0 flex-col bg-chrome"
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4 text-[0.8125rem] font-semibold">
        Panelyth
        <PreviewPlaceSwitch />
      </div>
      <ContextMenuRoot onOpenChange={(open) => !open && setMenuRow(null)}>
        {/* Rows record the target in onContextMenu (bubbles before the trigger opens). */}
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onFocus={() => {
              // Keep a row the mouse just pressed; otherwise start at the open
              // folder (or the first row). Never scrolls: the list stays where it is.
              const fallback =
                rows.find((r) => r.type === "tree" && r.key === activeKey) ?? rows.find(isNavigable)
              setFocusId((current) => current ?? fallback?.id ?? null)
            }}
            className="min-h-0 flex-1 overflow-y-auto outline-none"
            data-testid="sidebar-list"
          >
            {folderCrumbs.length > 0 && <FolderPathHeader crumbs={folderCrumbs} />}
            <div
              role="tree"
              aria-label={t("Folders")}
              tabIndex={0}
              aria-activedescendant={
                focusIndex >= 0 ? `sidebar-${rows[focusIndex]!.id}` : undefined
              }
              className="outline-none"
            >
              <div
                role="presentation"
                className="relative w-full"
                style={{
                  height: virtualizer.getTotalSize(),
                  marginTop: pathHeaderOffset > 0 ? -pathHeaderOffset : 0,
                }}
              >
                {virtualizer.getVirtualItems().map((v) => {
                  const row = rows[v.index]!
                  const active =
                    activeFolderKey !== null &&
                    ((row.type === "tree" && row.key === activeFolderKey) ||
                      (row.type === "link" &&
                        nodeKey(row.path) === activeFolderKey &&
                        row.id.startsWith("place")))
                  return (
                    <div
                      key={row.id}
                      role="presentation"
                      className="absolute top-0 left-0 w-full"
                      style={{ height: rowHeight, transform: `translateY(${v.start}px)` }}
                    >
                      <RowView
                        row={row}
                        active={active}
                        focused={row.id === focusId}
                        interfaceScale={interfaceScale}
                        onOpen={(p) => void openFolder(p)}
                        onDropTransfer={(path, name, payload) =>
                          askDropTransfer(payload, path, name)
                        }
                        onMenu={setMenuRow}
                        onFocusRow={setFocusId}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>
        {menuPath && menuRow && (
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => void openFolder(menuPath)}>
              {t("Open")}
            </ContextMenuItem>
            <ContextMenuItem
              onSelect={() => void bridge.revealPath(menuPath).catch(() => undefined)}
            >
              {t("Show in file manager")}
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => void bridge.copyText(menuPath).catch(() => undefined)}>
              {t("Copy path")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            {menuRow.type === "link" && menuRow.bookmarkId !== undefined ? (
              <ContextMenuItem onSelect={() => void removeBookmark(menuRow.bookmarkId!)}>
                {t("Remove bookmark")}
              </ContextMenuItem>
            ) : (
              <ContextMenuItem onSelect={() => void toggleBookmark(menuPath)}>
                {menuBookmarked ? t("Remove bookmark") : t("Add bookmark")}
              </ContextMenuItem>
            )}
            {menuRow.type === "tree" && (
              <ContextMenuItem onSelect={() => void refreshNode(menuPath)}>
                {t("Refresh")}
              </ContextMenuItem>
            )}
          </ContextMenuContent>
        )}
      </ContextMenuRoot>
    </nav>
  )
}
