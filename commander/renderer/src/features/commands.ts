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
import { toggleActivePanel, type Side } from "./panels"
import { closeQuickSearch } from "./quicksearch"
import { calculateSizes, swapSizeJobs } from "./sizes"
import { openDriveMenu } from "./drives"
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
}

export const useUiStore = create<UiState>(() => ({
  mask: null,
  lastMask: "*.*",
  editPath: { left: 0, right: 0 },
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
      toggleActivePanel()
      break
    case "app.settings":
      setSettingsOpen(true)
      break
  }
}
