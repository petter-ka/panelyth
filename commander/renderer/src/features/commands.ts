import { create } from "zustand"
import { switchToViewer } from "./carry"
import type { ActionId } from "./keymap"
import { setHelpOpen } from "./keymap"
import {
  COLUMN_SORT,
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
import { isMarked } from "@fastview/renderer-core"
import { toggleActivePanel, usePanelsStore, type Side } from "./panels"
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
  startRename,
} from "./files"
import { toggleQueue } from "./queue"
import { openFind } from "./find"
import { openHistoryMenu, openHotlist } from "./hotlist"
import { setSettingsOpen } from "./settings"
import { closeOtherTabs, closeTab, cycleTab, newTab, swapTabs, toggleLock } from "./tabs"

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
}

export const useUiStore = create<UiState>(() => ({
  mask: null,
  lastMask: "*.*",
  editPath: { left: 0, right: 0 },
  editFilter: { left: 0, right: 0 },
}))

const panel = (side: Side) => useListingStore.getState()[side]

/** Space: marks the cursor entry; on a folder also calculates its size. */
async function markAndSize(side: Side): Promise<void> {
  const p = panel(side)
  const index = p.cursor - parentRows(p)
  const item = index >= 0 ? await pageStoreOf(side).ensureIndex(index) : undefined
  await toggleCursor(side, false)
  if (item?.kind === "dir" && isMarked(marksOf(side), index, item.id)) {
    const d = cursorDescriptor(side)
    if (d) await calculateSizes(side, d).catch(() => undefined)
  }
}

export function runPanelAction(side: Side, id: ActionId): void {
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
    case "view.branch":
      void toggleBranch(side)
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
      if (q && q.total > 0) {
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
  }
}
