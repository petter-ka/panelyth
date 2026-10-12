import { create } from "zustand"
import { switchToViewer } from "./carry"
import { isToolAction, setHelpOpen, type ActionId, type ToolActionId } from "./keymap"
import { focusCommandLine, insertCursorText, openCommandHistory } from "./cmdline"
import { runTool } from "./tools"
import {
  COLUMN_SORT,
  enterArchiveAtCursor,
  goHistory,
  goRoot,
  goUp,
  openIn,
  pageStoreOf,
  parentRows,
  refresh,
  setView,
  swapPanels,
  toggleBranch,
  toggleHidden,
  toggleSort,
  useListingStore,
} from "./listing"
import {
  cursorDescriptor,
  invertMarks,
  markAll,
  markNone,
  markSameExtension,
  swapMarks,
  toggleCursor,
  marksOf,
} from "./marks"
import { isMarked } from "@panelyth/renderer-core"
import { cycleTreeMode, toggleActivePanel, usePanelsStore, type Side } from "./panels"
import { focusTree } from "./tree"
import { editCursor, openNewFile } from "./open"
import { focusPanel, openLister, toggleQuickView, useViewersStore } from "./viewers"
import { closeQuickSearch } from "./quicksearch"
import { calculateSizes, swapSizeJobs } from "./sizes"
import { openDriveMenu } from "./drives"
import {
  clipboardPaste,
  clipboardSet,
  copyAsText,
  openCopy,
  openCopyHere,
  openDelete,
  openMkdir,
  refusedOnConnection,
  startRename,
} from "./files"
import { toggleQueue } from "./queue"
import { openPack, openUnpack, testArchives } from "./archives"
import { openFind } from "./find"
import { disconnect, openConnections, openQuickConnect } from "./remote"
import {
  comparePanels,
  openCompareFiles,
  openHashCreate,
  openSync,
  verifyChecksums,
} from "./compare"
import { openMultiRename, undoMultiRename } from "./rename"
import { openAttributes, openProperties } from "./attributes"
import { openHistoryMenu, openHotlist } from "./hotlist"
import { setSettingsOpen, updateSettings, useSettingsStore } from "./settings"
import {
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  cycleTab,
  duplicateTab,
  newTab,
  reopenTab,
  startTabRename,
  swapTabs,
  toggleLock,
} from "./tabs"
import { openSaveTabs, openTabSets } from "./tabsets"

// Runs the commander's remappable actions (keymap.ts) on the active panel.

interface UiState {
  /** The mark/unmark-by-mask dialog, when open. */
  mask: { side: Side; mark: boolean } | null
  /** The last mask used, offered next time (Total Commander remembers it too). */
  lastMask: string
  /** Increments to ask a panel's path bar to start editing. */
  editPath: Record<Side, number>
  /** Increments to ask a panel's path bar to edit the quick filter (Ctrl+S, Stage C06). */
  editFilter: Record<Side, number>
  /** The entry (or folder) context menu; modal, above everything in the window. */
  rowMenu: RowMenuState | null
  /** Where the right button is being held (inside the panel's view area), while the hold ring shows. */
  hold: { side: Side; left: number; top: number } | null
}

export interface RowMenuState {
  side: Side
  /** Window coordinates. */
  left: number
  top: number
  /** Opened on an entry (file commands), or on "..", or the empty area (folder commands only). */
  entry: boolean
}

export const useUiStore = create<UiState>(() => ({
  mask: null,
  lastMask: "*.*",
  editPath: { left: 0, right: 0 },
  editFilter: { left: 0, right: 0 },
  rowMenu: null,
  hold: null,
}))

/** Shows the hold ring at a window position inside the panel area around `from`, or hides it. */
export function setHold(side: Side, from: Element | null, x = 0, y = 0): void {
  const bounds = from?.closest("[data-menu-area]")?.getBoundingClientRect()
  if (bounds) useUiStore.setState({ hold: { side, left: x - bounds.left, top: y - bounds.top } })
  else if (useUiStore.getState().hold?.side === side) useUiStore.setState({ hold: null })
}

/** Opens the context menu at a window position. */
export function openRowMenu(side: Side, x: number, y: number, entry: boolean): void {
  closeQuickSearch()
  useUiStore.setState({ rowMenu: { side, left: x, top: y, entry } })
}

const panel = (side: Side) => useListingStore.getState()[side]

/** Space: marks the cursor entry; on a folder also calculates its size. */
async function markAndSize(side: Side): Promise<void> {
  const p = panel(side)
  const index = p.cursor - parentRows(p)
  const item = index >= 0 ? await pageStoreOf(side).ensureIndex(index) : undefined
  await toggleCursor(side, false)
  // Folders inside an archive come with their size from the listing.
  // On a connection a folder's size would mean listing its whole subtree.
  if (item?.kind === "dir" && !p.archive && !p.remote && isMarked(marksOf(side), index, item.id)) {
    const d = cursorDescriptor(side)
    if (d) await calculateSizes(side, d).catch(() => undefined)
  }
}

export function runPanelAction(side: Side, id: ActionId | ToolActionId): void {
  // A user command (Stage C10): from its key, its toolbar button or the entry menu.
  if (isToolAction(id)) {
    closeQuickSearch()
    void runTool(side, id.slice("tool:".length))
    return
  }
  switch (id) {
    case "nav.up":
      void goUp(side)
      break
    case "nav.root":
      void goRoot(side)
      break
    case "nav.back":
      void goHistory(side, -1)
      break
    case "nav.forward":
      void goHistory(side, 1)
      break
    case "nav.openLeft":
      void openIn("left", side)
      break
    case "nav.openRight":
      void openIn("right", side)
      break
    case "panels.swap":
      closeQuickSearch()
      swapPanels()
      swapTabs()
      swapMarks()
      swapSizeJobs()
      break
    case "nav.historyMenu":
      closeQuickSearch()
      openHistoryMenu(side)
      break
    case "drives.left":
      closeQuickSearch()
      openDriveMenu("left")
      break
    case "drives.right":
      closeQuickSearch()
      openDriveMenu("right")
      break
    case "hotlist.open":
      closeQuickSearch()
      openHotlist(side)
      break
    case "tab.new":
      newTab(side)
      break
    case "tab.close":
      void closeTab(side)
      break
    case "tab.next":
      void cycleTab(side, 1)
      break
    case "tab.previous":
      void cycleTab(side, -1)
      break
    case "tab.lock":
      toggleLock(side)
      break
    case "tab.closeOthers":
      closeOtherTabs(side)
      break
    case "tab.reopen":
      closeQuickSearch()
      void reopenTab(side)
      break
    case "tab.rename":
      closeQuickSearch()
      startTabRename(side)
      break
    case "tab.duplicate":
      duplicateTab(side)
      break
    case "tab.closeRight":
      void closeTabsToRight(side)
      break
    case "tabs.save":
      closeQuickSearch()
      openSaveTabs(side)
      break
    case "tabs.sets":
      closeQuickSearch()
      openTabSets(side)
      break
    case "files.copy":
      closeQuickSearch()
      void openCopy(side, "copy")
      break
    case "files.move":
      closeQuickSearch()
      void openCopy(side, "move")
      break
    case "files.copyHere":
      closeQuickSearch()
      openCopyHere(side)
      break
    case "files.rename":
      closeQuickSearch()
      startRename(side)
      break
    case "files.mkdir":
      closeQuickSearch()
      openMkdir(side)
      break
    case "files.view":
      closeQuickSearch()
      openLister(side)
      break
    case "files.edit":
      closeQuickSearch()
      void editCursor(side)
      break
    case "files.newText":
      closeQuickSearch()
      openNewFile(side)
      break
    case "files.trash":
      closeQuickSearch()
      void openDelete(side, false)
      break
    case "files.delete":
      closeQuickSearch()
      void openDelete(side, true)
      break
    case "clip.copy":
      void clipboardSet(side, "copy")
      break
    case "clip.cut":
      void clipboardSet(side, "cut")
      break
    case "clip.paste":
      void clipboardPaste(side)
      break
    case "copy.paths":
      void copyAsText(side, false)
      break
    case "copy.names":
      void copyAsText(side, true)
      break
    case "view.brief":
      setView(side, "brief")
      break
    case "view.full":
      setView(side, "full")
      break
    case "view.thumbs":
      setView(side, "thumbs")
      break
    case "cmd.insertName":
      closeQuickSearch()
      insertCursorText(side, false)
      break
    case "cmd.insertPath":
      closeQuickSearch()
      insertCursorText(side, true)
      break
    case "path.edit":
      useUiStore.setState((s) => ({ editPath: { ...s.editPath, [side]: s.editPath[side] + 1 } }))
      break
    case "view.refresh":
      void refresh(side)
      break
    case "view.hidden":
      toggleHidden(side)
      break
    case "find.open":
      closeQuickSearch()
      openFind(side)
      break
    case "remote.connections":
      closeQuickSearch()
      openConnections(side)
      break
    case "remote.quick":
      closeQuickSearch()
      openQuickConnect(side)
      break
    case "remote.disconnect":
      void disconnect(side)
      break
    case "view.branch":
      // A branch view would list a server's whole subtree (ADR-0037).
      if (!refusedOnConnection(side)) void toggleBranch(side)
      break
    case "archive.enter":
      closeQuickSearch()
      void enterArchiveAtCursor(side)
      break
    case "archive.pack":
      closeQuickSearch()
      openPack(side)
      break
    case "archive.unpack":
      closeQuickSearch()
      void openUnpack(side)
      break
    case "archive.test":
      closeQuickSearch()
      void testArchives(side)
      break
    case "compare.dirs":
      closeQuickSearch()
      void comparePanels()
      break
    case "compare.sync":
      closeQuickSearch()
      openSync()
      break
    case "compare.content":
      closeQuickSearch()
      void openCompareFiles(side)
      break
    case "hash.create":
      closeQuickSearch()
      openHashCreate(side)
      break
    case "hash.verify":
      closeQuickSearch()
      void verifyChecksums(side)
      break
    case "files.multiRename":
      closeQuickSearch()
      openMultiRename(side)
      break
    case "files.undoRename":
      closeQuickSearch()
      void undoMultiRename()
      break
    case "files.attributes":
      closeQuickSearch()
      openAttributes(side)
      break
    case "files.properties":
      closeQuickSearch()
      openProperties(side)
      break
    case "view.filter":
      closeQuickSearch()
      useUiStore.setState((s) => ({
        editFilter: { ...s.editFilter, [side]: s.editFilter[side] + 1 },
      }))
      break
    case "sort.name":
      toggleSort(side, COLUMN_SORT.name)
      break
    case "sort.ext":
      toggleSort(side, COLUMN_SORT.ext)
      break
    case "sort.date":
      toggleSort(side, COLUMN_SORT.date)
      break
    case "sort.size":
      toggleSort(side, COLUMN_SORT.size)
      break
    case "mark.toggleDown":
      void toggleCursor(side, true)
      break
    case "mark.toggle":
      void markAndSize(side)
      break
    case "mark.all":
      markAll(side)
      break
    case "mark.none":
      markNone(side)
      break
    case "mark.invert":
      invertMarks(side)
      break
    case "mark.mask":
      useUiStore.setState({ mask: { side, mark: true } })
      break
    case "unmark.mask":
      useUiStore.setState({ mask: { side, mark: false } })
      break
    case "mark.sameExt":
      void markSameExtension(side)
      break
    case "size.all": {
      // Every row; Go skips the files.
      const q = panel(side).query
      if (refusedOnConnection(side)) break
      if (q && q.total > 0 && !panel(side).archive) {
        void calculateSizes(side, {
          queryId: q.queryId,
          version: q.version,
          ranges: [[0, q.total]],
          include: [],
          exclude: [],
        }).catch(() => undefined)
      }
      break
    }
    default:
      runShellAction(id)
  }
}

function toggleQuickViewFocus(): void {
  const quick = document.getElementById("quick-view")
  if (!quick || quick.contains(document.activeElement)) {
    focusPanel()
    return
  }
  const body = quick.querySelector<HTMLElement>("[tabindex='0']")
  ;(body ?? quick).focus()
}

export function runShellAction(id: ActionId): void {
  switch (id) {
    case "app.switch":
      void switchToViewer().catch(() => undefined)
      break
    case "help.shortcuts":
      setHelpOpen(true)
      break
    case "panel.other":
      closeQuickSearch()
      // With quick view open, Tab moves between the panel and the quick view (C05).
      if (useViewersStore.getState().quick !== null) toggleQuickViewFocus()
      else toggleActivePanel()
      break
    case "view.quick":
      closeQuickSearch()
      toggleQuickView(usePanelsStore.getState().active)
      break
    case "app.settings":
      setSettingsOpen(true)
      break
    case "queue.toggle":
      toggleQueue()
      break
    case "cmd.focus":
      closeQuickSearch()
      focusCommandLine()
      break
    case "cmd.history":
      closeQuickSearch()
      openCommandHistory()
      break
    case "view.toolbar":
      updateSettings({ showToolbar: !useSettingsStore.getState().settings.showToolbar })
      break
    case "view.commandLine":
      updateSettings({ showCommandLine: !useSettingsStore.getState().settings.showCommandLine })
      break
    case "view.functionKeys":
      updateSettings({ showFunctionKeys: !useSettingsStore.getState().settings.showFunctionKeys })
      break
    case "tree.toggle":
      cycleTreeMode()
      break
    case "tree.focus":
      closeQuickSearch()
      focusTree(usePanelsStore.getState().active)
      break
  }
}
