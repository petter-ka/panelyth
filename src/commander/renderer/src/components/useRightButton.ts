import type { Marks } from "@panelyth/renderer-core"
import { useEffect, useRef, type MouseEvent } from "react"
import { openRowMenu, setHold } from "../features/commands"
import { moveCursor, useListingStore } from "../features/listing"
import { dropAnchor, marksOf, paintRows, rowMarked } from "../features/marks"
import type { Side } from "../features/panels"
import { closeQuickSearch } from "../features/quicksearch"
import { useSettingsStore } from "../features/settings"

/** Holding the right button this long opens the context menu instead of marking. */
export const RIGHT_HOLD_MS = 500

interface Press {
  /** The row the button went down on, and the last row the pointer was over. */
  row: number
  last: number
  /** The marks when the button went down; a drag repaints from them. */
  base: Marks
  /** Mark or unmark: the opposite of the first row's state. */
  mark: boolean
  dragged: boolean
  timer: ReturnType<typeof setTimeout>
}

const rowOf = (target: EventTarget): number | null => {
  const el = (target as HTMLElement).closest<HTMLElement>("[data-row]")
  return el ? Number(el.dataset.row) : null
}

/**
 * The right mouse button in a panel's view (CFR-06, the Full and Brief views
 * share it). With "Marks entries" (the default, classic Total Commander): a
 * right-click flips the row's mark, dragging marks or unmarks the rows passed
 * over, and holding the button still opens the context menu. With "Opens the
 * menu": a right-click opens the menu at once. The empty area and the Menu
 * key / Shift+F10 open it in both modes.
 */
export function useRightButton(side: Side) {
  const press = useRef<Press | null>(null)
  // The contextmenu event of a click that marked (it follows the release on Windows).
  const suppress = useRef(false)
  const end = useRef<(() => void) | null>(null)
  useEffect(() => () => end.current?.(), [])

  const onMouseDown = (e: MouseEvent<HTMLElement>): void => {
    suppress.current = false
    if (e.button !== 2) return
    const row = rowOf(e.target)
    if (row === null) return
    closeQuickSearch()
    dropAnchor(side)
    moveCursor(side, row)
    if (useSettingsStore.getState().settings.rightButton !== "mark") return
    suppress.current = true
    end.current?.()

    const area = e.currentTarget
    const { clientX, clientY } = e
    const marked = rowMarked(side, row)
    const finish = (): void => {
      clearTimeout(p.timer)
      window.removeEventListener("mouseup", up)
      press.current = null
      end.current = null
      setHold(side, null)
    }
    const up = (ev: globalThis.MouseEvent): void => {
      if (ev.button !== 2) return
      finish()
      if (!p.dragged) paintRows(side, p.base, row, row, p.mark)
    }
    const { ranges, include, exclude } = marksOf(side)
    const p: Press = {
      row,
      last: row,
      base: { ranges, include, exclude },
      mark: !marked,
      dragged: false,
      timer: setTimeout(() => {
        finish()
        openRowMenu(side, clientX, clientY, marked !== null)
      }, RIGHT_HOLD_MS),
    }
    press.current = p
    end.current = finish
    setHold(side, area, clientX, clientY)
    window.addEventListener("mouseup", up)
  }

  const onMouseMove = (e: MouseEvent): void => {
    const p = press.current
    if (!p) return
    const row = rowOf(e.target)
    if (row === null || row === p.last) return
    p.last = row
    p.dragged = true
    clearTimeout(p.timer)
    setHold(side, null)
    paintRows(side, p.base, p.row, row, p.mark)
    moveCursor(side, row)
  }

  const onContextMenu = (e: MouseEvent<HTMLElement>): void => {
    e.preventDefault()
    if (e.button !== 2) {
      // The Menu key or Shift+F10: the menu of the cursor entry, below its row.
      const { cursor } = useListingStore.getState()[side]
      const at = document.getElementById(`${side}-row-${cursor}`)?.getBoundingClientRect()
      openRowMenu(
        side,
        at ? at.left + 24 : e.clientX,
        at ? at.bottom : e.clientY,
        rowMarked(side, cursor) !== null,
      )
      return
    }
    if (suppress.current) return
    const row = rowOf(e.target)
    openRowMenu(side, e.clientX, e.clientY, row !== null && rowMarked(side, row) !== null)
  }

  return { onMouseDown, onMouseMove, onContextMenu }
}
