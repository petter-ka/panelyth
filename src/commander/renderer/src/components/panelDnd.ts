import type { DragEvent } from "react"
import {
  dragSource,
  dragStart,
  dropOn,
  isPanelDrag,
  panelTarget,
  type CopyTarget,
} from "../features/files"
import { endOwnDrag, isMarked, ownDrag } from "@panelyth/renderer-core"
import { moveCursor, pageStoreOf, parentRows, useListingStore } from "../features/listing"
import { markNone, marksDescriptor, marksOf } from "../features/marks"
import type { Side } from "../features/panels"

// Drag and drop between the panels (Stage C04, CFR-27): rows drag the marks
// (or, for an unmarked row, that row); a drop opens the copy dialog (Shift
// moves) with the target's folder. Tabs and drive buttons are targets too.
// Files of this computer go as the OS's drag, so other apps take them as
// well (ADR-0040).

const rowOf = (e: DragEvent): number | null => {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-row]")
  return el ? Number(el.dataset.row) : null
}

/** Drag-source and drop-target handlers of a panel's view body. */
export function panelDnd(side: Side) {
  return {
    onDragStart(e: DragEvent): void {
      const row = rowOf(e)
      const p = useListingStore.getState()[side]
      const index = row === null ? -1 : row - parentRows(p)
      const item = index >= 0 ? pageStoreOf(side).getItem(index) : undefined
      if (row === null || !item) {
        e.preventDefault()
        return
      }
      // An unmarked row drags itself, not the marks.
      if (!marksDescriptor(side) || !isMarked(marksOf(side), index, item.id)) {
        markNone(side)
        moveCursor(side, row)
      }
      if (!dragStart(side, e.nativeEvent)) e.preventDefault()
    },
    ...dropTarget(side, () => {
      const p = useListingStore.getState()[side]
      // An archive panel takes no drops (archives are read-only, ADR-0030).
      return p.archive ? null : panelTarget(side)
    }),
  }
}

/** Drop handlers for anything that stands for a folder of `side`'s panel. */
export function dropTarget(side: Side, target: () => CopyTarget | null) {
  const accepts = (e: DragEvent): boolean => isPanelDrag(e.dataTransfer) && target() !== null
  return {
    onDragOver(e: DragEvent): void {
      if (!accepts(e)) return
      e.preventDefault()
      // The OS's drag of files allows a copy only: Shift still moves, read at the drop.
      e.dataTransfer.dropEffect = e.shiftKey && ownDrag(e.dataTransfer) === null ? "move" : "copy"
    },
    onDrop(e: DragEvent): void {
      const from = dragSource(e.nativeEvent)
      const t = target()
      if (!from || !t) return
      e.preventDefault()
      endOwnDrag()
      // Dropping a panel's items on its own folder does nothing (copy here is Shift+F5).
      const own = useListingStore.getState()[from]
      if (from === side && t.dirId !== null && t.dirId === own.dirId) return
      if (from === side && t.remoteDirId !== undefined && t.remoteDirId === own.remote?.dirId)
        return
      dropOn(from, t, e.shiftKey)
    },
  }
}
