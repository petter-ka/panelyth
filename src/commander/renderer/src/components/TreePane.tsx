import { eventChord } from "@panelyth/renderer-core"
import { TreeTwisty, TypeGlyph, useInterfaceSizeStore } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react"
import { actionFor } from "../features/keymap"
import { useListingStore } from "../features/listing"
import {
  setActivePanel,
  setTreeWidth,
  TREE_WIDTH,
  usePanelsStore,
  type Side,
} from "../features/panels"
import { useSettingsStore } from "../features/settings"
import {
  addToHotlist,
  closeTreeMenu,
  openIn,
  openInNewTab,
  openTreeMenu,
  openTreeNode,
  refreshTreeNode,
  setTreeCursor,
  treeRows,
  trees,
  useTreeUiStore,
  type TreeId,
  type TreePaneRow,
} from "../features/tree"
import { focusPanel } from "../features/viewers"
import { ROW_HEIGHT } from "./FullView"
import { dropTarget } from "./panelDnd"
import { PopupMenu } from "./PopupMenu"
import { t } from "@panelyth/i18n"

const INDENT = 14
/** The tree's cursor rests this long before its folder opens (the "opens as the cursor moves" setting). */
export const TREE_SETTLE_MS = 150
/** Typed letters make one search text while they follow each other this fast. */
const TYPE_AHEAD_MS = 700
export const TREE_OVERSCAN = 8

/**
 * A folder tree beside the panels (Stage C10.5, CFR-30). One virtualized
 * list of the visible nodes with the panel's row height. Keys: ↑ ↓ PgUp
 * PgDn Home End move; → expands or goes to the first child; ← collapses or
 * goes to the parent; Enter opens the folder in the panel and gives the
 * keys back; letters jump to the next node of that name; Tab and Esc go
 * back to the panel.
 */
export function TreePane({ id }: { id: TreeId }) {
  const tree = trees[id]
  const roots = tree.useStore((s) => s.roots)
  const expanded = tree.useStore((s) => s.expanded)
  const version = tree.useStore((s) => s.version)
  const activeKey = tree.useStore((s) => s.activeKey)
  const revealToken = tree.useStore((s) => s.revealToken)
  const cursor = useTreeUiStore((s) => s.cursor[id])
  const focusToken = useTreeUiStore((s) => s.focusToken[id])
  const menu = useTreeUiStore((s) => (s.menu?.id === id ? s.menu : null))
  const width = usePanelsStore((s) => s.treeWidth)
  const side: Side = usePanelsStore((s) => (id === "one" ? s.active : id))
  // Inside an archive, on search results or on a connection the tree stays on the folder behind them.
  const dimmed = useListingStore(
    (s) => s[side].archive !== null || s[side].find !== null || s[side].remote !== null,
  )
  const followCursor = useSettingsStore((s) => s.settings.treeFollowCursor)
  const rowHeight = ROW_HEIGHT[useInterfaceSizeStore((s) => s.size)]
  const [focused, setFocused] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)
  const typed = useRef({ text: "", at: 0 })

  // version: a node's contents changed (a listing arrived, an error).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => treeRows(id), [id, roots, expanded, version])
  const cursorIndex = cursor === null ? -1 : rows.findIndex((r) => r.key === cursor)
  const row = rows[cursorIndex]
  const node = row?.type === "node" ? row : undefined

  // TanStack Virtual returns methods that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => rowHeight,
    overscan: TREE_OVERSCAN,
  })
  useEffect(() => {
    virtualizer.measure()
  }, [virtualizer, rowHeight])

  // The panel shows another folder: the tree scrolls to it, and its cursor
  // goes there too unless the tree has the keys.
  useEffect(() => {
    if (revealToken === 0 || !activeKey) return
    if (document.activeElement !== scroll.current) setTreeCursor(id, activeKey)
    const index = treeRows(id).findIndex((r) => r.key === activeKey)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" })
  }, [revealToken, activeKey, id, virtualizer])

  // Shift+Tab from the panel (tree.focus).
  const seenFocus = useRef(focusToken)
  useEffect(() => {
    if (focusToken !== seenFocus.current) scroll.current?.focus()
    seenFocus.current = focusToken
  }, [focusToken])

  // "The tree opens folders as the cursor moves": once the cursor has settled.
  useEffect(() => {
    if (!followCursor || !focused || cursor === null || cursor === activeKey) return
    const timer = setTimeout(() => void openTreeNode(id, cursor), TREE_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [followCursor, focused, cursor, activeKey, id])

  /** The cursor on the nearest node at or beyond `index` in a direction (notes are passed over). */
  const moveTo = (index: number, step: 1 | -1): void => {
    let at = Math.max(0, Math.min(rows.length - 1, index))
    while (rows[at] && rows[at]!.type !== "node") at += step
    // Nothing that way: the nearest node the other way.
    if (!rows[at]) {
      at = Math.max(0, Math.min(rows.length - 1, index))
      while (rows[at] && rows[at]!.type !== "node") at -= step
    }
    const target = rows[at]
    if (!target) return
    setTreeCursor(id, target.key)
    virtualizer.scrollToIndex(at, { align: "auto" })
  }

  /** Letters: the next visible node whose name starts with what was typed. */
  const typeAhead = (char: string): void => {
    const now = Date.now()
    const fresh = now - typed.current.at > TYPE_AHEAD_MS
    const text = (fresh ? "" : typed.current.text) + char.toLowerCase()
    typed.current = { text, at: now }
    // A first letter moves on from the cursor; more letters refine in place.
    const from = text.length === 1 ? cursorIndex + 1 : Math.max(0, cursorIndex)
    for (let i = 0; i < rows.length; i++) {
      const at = (from + i) % rows.length
      const r = rows[at]!
      if (r.type === "node" && r.node.name.toLowerCase().startsWith(text)) {
        setTreeCursor(id, r.key)
        virtualizer.scrollToIndex(at, { align: "auto" })
        return
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const done = (): void => {
      e.preventDefault()
      // Tab and Esc are the shell's keys too: they stay here.
      e.stopPropagation()
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      // Ctrl+R (view.refresh, wherever it is bound): the node is listed again.
      const chord = eventChord(e.nativeEvent)
      if (node && chord && actionFor("panels", chord) === "view.refresh") {
        done()
        void refreshTreeNode(id, node.key)
      }
      return
    }
    const page = Math.max(1, Math.floor((scroll.current?.clientHeight ?? 0) / rowHeight) - 1)
    // Any key that is not a letter ends the text typed so far.
    if (e.key.length !== 1 || e.key === " ") typed.current = { text: "", at: 0 }
    switch (e.key) {
      case "ArrowDown":
        return (done(), moveTo(cursorIndex + 1, 1))
      case "ArrowUp":
        return (done(), moveTo(cursorIndex < 0 ? 0 : cursorIndex - 1, -1))
      case "PageDown":
        return (done(), moveTo(cursorIndex + page, 1))
      case "PageUp":
        return (done(), moveTo(cursorIndex - page, -1))
      case "Home":
        return (done(), moveTo(0, 1))
      case "End":
        return (done(), moveTo(rows.length - 1, -1))
      case "ArrowRight":
        done()
        if (!node) return
        if (!node.expanded) {
          if (node.node.hasChildren) void tree.expand(node.key)
        } else if (rows[cursorIndex + 1]?.type === "node") moveTo(cursorIndex + 1, 1)
        return
      case "ArrowLeft":
        done()
        if (!node) return
        if (node.expanded) return tree.collapse(node.key)
        for (let i = cursorIndex - 1; i >= 0; i--) {
          const r = rows[i]!
          if (r.type === "node" && r.depth < node.depth) return moveTo(i, -1)
        }
        return
      case "Enter":
        done()
        if (!node) return
        void openTreeNode(id, node.key)
        return focusPanel()
      case "Escape":
      case "Tab":
        done()
        return focusPanel()
    }
    if (e.key.length === 1 && e.key !== " ") {
      done()
      typeAhead(e.key)
    }
  }

  const label =
    id === "one"
      ? t("Folder tree")
      : id === "left"
        ? t("Folder tree, left panel")
        : t("Folder tree, right panel")
  const menuNode = menu ? tree.getNode(menu.key) : undefined

  return (
    <>
      <nav
        aria-label={label}
        data-testid={`tree-${id}`}
        data-dimmed={dimmed || undefined}
        style={{ width }}
        // A panel's own tree makes its panel the active one, as the panel does.
        onMouseDown={() => id !== "one" && setActivePanel(id)}
        className={`relative flex h-full shrink-0 flex-col bg-chrome text-xs ${dimmed ? "opacity-60" : ""}`}
      >
        <div
          ref={scroll}
          role="tree"
          aria-label={label}
          aria-activedescendant={node ? `tree-${id}-${cursorIndex}` : undefined}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true)
            if (cursor === null) {
              const first = rows.find((r) => r.type === "node")
              setTreeCursor(id, activeKey ?? first?.key ?? null)
            }
          }}
          onBlur={() => setFocused(false)}
          data-testid={`tree-rows-${id}`}
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = rows[v.index]
              if (!r) return null
              return (
                <div
                  key={r.key}
                  style={{
                    position: "absolute",
                    top: v.start,
                    height: rowHeight,
                    left: 0,
                    right: 0,
                  }}
                >
                  <TreeRowView
                    id={id}
                    domId={`tree-${id}-${v.index}`}
                    row={r}
                    side={side}
                    cursor={r.key === cursor}
                    current={r.key === activeKey}
                    focused={focused}
                    // Loading and error states change inside the node object.
                    version={version}
                  />
                </div>
              )
            })}
          </div>
        </div>
        {menu && menuNode && (
          <PopupMenu
            label={menuNode.name}
            testId={`tree-menu-${id}`}
            className=""
            style={{ left: menu.left, top: menu.top }}
            onClose={closeTreeMenu}
            entries={[
              {
                id: "left",
                label: t("Open in the left panel"),
                onSelect: () => void openIn("left", menuNode.path),
              },
              {
                id: "right",
                label: t("Open in the right panel"),
                onSelect: () => void openIn("right", menuNode.path),
              },
              {
                id: "tab",
                label: t("Open in a new tab"),
                onSelect: () => void openInNewTab(side, menuNode.path),
              },
              { id: "s1", label: "", separator: true },
              {
                id: "hotlist",
                label: t("Add to the directory hotlist"),
                onSelect: () => void addToHotlist(menuNode.path),
              },
              {
                id: "refresh",
                label: t("Refresh"),
                onSelect: () => void refreshTreeNode(id, menu.key),
              },
            ]}
          />
        )}
      </nav>
      <TreeDivider width={width} label={label} />
    </>
  )
}

interface TreeRowProps {
  id: TreeId
  domId: string
  row: TreePaneRow
  side: Side
  cursor: boolean
  current: boolean
  focused: boolean
  version: number
}

const TreeRowView = memo(function TreeRowView({
  id,
  domId,
  row,
  side,
  cursor,
  current,
  focused,
}: TreeRowProps) {
  const [dragOver, setDragOver] = useState(false)
  if (row.type === "note") {
    return (
      <div
        className="flex h-full items-center truncate pr-2 text-2xs text-muted"
        style={{ paddingLeft: 24 + row.depth * INDENT }}
      >
        {row.label}
      </div>
    )
  }
  const { node, key, depth, expanded } = row
  const drop = dropTarget(side, () => ({ path: node.path, dirId: null }))
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={cursor}
      aria-current={current ? "location" : undefined}
      aria-expanded={node.hasChildren ? expanded : undefined}
      aria-label={node.name}
      data-testid="tree-node"
      data-path={node.path}
      data-tooltip-content={node.path}
      className={[
        "mx-1 flex h-full cursor-default items-center gap-1 rounded-sm pr-2",
        current ? "bg-raised font-medium text-text" : "text-text hover:bg-raised/60",
        cursor
          ? focused
            ? "outline-1 -outline-offset-1 outline-accent"
            : "outline-1 -outline-offset-1 outline-border"
          : "",
        dragOver ? "bg-accent/15 outline-1 -outline-offset-1 outline-accent" : "",
      ].join(" ")}
      style={{ paddingLeft: 4 + depth * INDENT }}
      onMouseDown={() => setTreeCursor(id, key)}
      onClick={() => {
        void openTreeNode(id, key)
        // A click opens the folder in the tree too: its subfolders show.
        if (node.hasChildren && !expanded) void trees[id].expand(key)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        setTreeCursor(id, key)
        const pane = e.currentTarget.closest("nav")?.getBoundingClientRect()
        openTreeMenu({
          id,
          key,
          left: Math.max(4, e.clientX - (pane?.left ?? 0)),
          top: Math.max(4, e.clientY - (pane?.top ?? 0)),
        })
      }}
      onDragOver={(e) => {
        drop.onDragOver(e)
        if (e.defaultPrevented) setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false)
        drop.onDrop(e)
      }}
    >
      <TreeTwisty
        name={node.name}
        expanded={expanded}
        hasChildren={node.hasChildren}
        onToggle={() => trees[id].toggle(key)}
      />
      <span className="shrink-0">
        <TypeGlyph glyph={depth === 0 ? "drive" : "folder"} size={14} />
      </span>
      <span className="min-w-0 flex-1 truncate">{node.name}</span>
      {node.loading && <span className="text-3xs text-muted">…</span>}
    </div>
  )
})

/** The divider after a tree: drag it, or ← / → on it, to change the trees' width; a double-click resets it. */
function TreeDivider({ width, label }: { width: number; label: string }) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = { x: e.clientX, width }
    e.currentTarget.setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag.current) setTreeWidth(drag.current.width + e.clientX - drag.current.x)
  }
  const end = (): void => {
    drag.current = null
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("Resize {name}", { name: label })}
      aria-valuemin={TREE_WIDTH.min}
      aria-valuemax={TREE_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => setTreeWidth(TREE_WIDTH.initial)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return
        e.preventDefault()
        e.stopPropagation()
        setTreeWidth(width + (e.key === "ArrowRight" ? 16 : -16))
      }}
      className="w-1 shrink-0 cursor-col-resize bg-border outline-none hover:bg-accent focus-visible:bg-accent"
    />
  )
}
